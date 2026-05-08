/**
 * POST /v1/ingest
 *
 * 判定ログを D1 に蓄積する。設計書 §5.4 / §5.3 / §6 に準拠。
 *
 * フロー:
 * 1. rate-limit middleware（IP ベース、29req/min、fail-open）
 * 2. token-check middleware（x-fck-token 形式検証）
 * 3. consent-check middleware（consentVersion 照合 + body 読み出し）
 * 4. 本ハンドラ:
 *    a. logs 配列のバリデーション（最大 50 件、必須フィールド）
 *    b. 各 log の authorChannelId を SHA-1 + COLLECTION_SALT でハッシュ化
 *    c. x-fck-token 自体も同様にハッシュ化（D1 の user_token_hashed に使用）
 *    d. D1 batch insert
 *    e. 200 OK + IngestResponsePayload
 *
 * セキュリティ:
 * - 平文 authorChannelId はハッシュ化後即座にスコープから抜ける（local 変数のみ）
 * - レスポンス・エラー・ログに salt や平文値を含めない
 *
 * @see dev-docs/phase-2-5-data-collection.md §5.4
 */

import { Hono } from 'hono';
import type { Env } from '../env.js';
import type {
  SpoilerJudgmentLog,
  IngestRequestPayload,
  IngestResponsePayload,
} from '@fresh-chat-keeper/shared';
import { tokenCheckMiddleware } from '../middleware/token-check.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import { consentCheckMiddleware } from '../middleware/consent-check.js';
import { hashAuthorChannelId, hashUserToken, assertValidSalt } from '../lib/hash.js';
import { toJudgmentLogRow, type JudgmentLogRow } from '../db/schema.js';
import { insertJudgmentLogs } from '../db/repository.js';

const MAX_BATCH = 50;

export const ingestRouter = new Hono<{
  Bindings: Env;
  Variables: { rawToken: string; parsedBody: unknown; currentConsentVersion: string };
}>();

ingestRouter.post(
  '/ingest',
  rateLimitMiddleware,
  tokenCheckMiddleware,
  consentCheckMiddleware,
  async (c) => {
    const body = c.get('parsedBody') as IngestRequestPayload;
    const rawToken = c.get('rawToken');
    const currentVersion = c.get('currentConsentVersion');

    // logs 配列の存在 / 形式チェック
    if (!Array.isArray(body.logs)) {
      return c.json({ error: 'logs must be an array' }, 422);
    }
    if (body.logs.length === 0) {
      return c.json({ error: 'logs must not be empty' }, 422);
    }
    if (body.logs.length > MAX_BATCH) {
      return c.json(
        { error: `logs must not exceed ${MAX_BATCH} items per request` },
        413,
      );
    }

    // 各 log のバリデーション。一件でも不正なら全体を 422 で拒否
    // （D1 の batch transaction と同じ all-or-nothing ポリシー）
    for (let i = 0; i < body.logs.length; i++) {
      const err = validateLog(body.logs[i]);
      if (err) {
        return c.json({ error: `logs[${i}]: ${err}` }, 422);
      }
    }

    // ハッシュ化 + 行変換
    const salt = c.env.COLLECTION_SALT;
    try {
      assertValidSalt(salt);
    } catch (err) {
      // salt 未設定 / 短すぎは運用ミス。ログには長さ情報のみ（値は含めない）
      console.error(err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Server misconfiguration' }, 500);
    }
    const receivedAt = Date.now();
    const hashedUserToken = await hashUserToken(rawToken, salt);

    let rows: JudgmentLogRow[];
    try {
      rows = await Promise.all(
        body.logs.map(async (log) => {
          const hashedAuthor = await hashAuthorChannelId(
            log.targetMessage.authorChannelId,
            salt,
          );
          return toJudgmentLogRow(log, hashedAuthor, hashedUserToken, receivedAt);
        }),
      );
    } catch (err) {
      // toJudgmentLogRow は不正な ISO 8601 で例外を投げる
      console.error(
        `[fck-api] ingest mapping error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: 'Invalid log format (timestamp parsing failed)' }, 422);
    }

    // D1 batch insert
    try {
      await insertJudgmentLogs(c.env.COLLECTION_DB, rows);
    } catch (err) {
      // CHECK 制約違反 / DB 障害。ロールバック済み
      console.error(
        `[fck-api] D1 insert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: 'Failed to persist logs' }, 500);
    }

    const response: IngestResponsePayload = {
      accepted: rows.length,
      rejected: 0,
      currentConsentVersion: currentVersion,
    };
    return c.json(response, 200);
  },
);

// ─── バリデーション ───────────────────────────────────────────

const VALID_JUDGMENT_MODES = new Set(['live', 'archive_replay', 'post_stream_review']);
const VALID_LABELS = new Set([
  'safe',
  'spoiler',
  'harassment',
  'spam',
  'off_topic',
  'backseat',
]);
const VALID_STAGE_A = new Set(['story_reference', 'reaction', 'meta', 'unknown']);
const VALID_STAGES = new Set(['stage1', 'stage1_5', 'stage2']);
const VALID_LABEL_SOURCES = new Set(['haiku', 'user_report', 'moderator', 'tommy_manual']);

/**
 * SpoilerJudgmentLog の必須フィールドと列挙値を検証する。
 *
 * 戻り値:
 * - 問題なければ null
 * - 問題があれば「どこが不正か」のメッセージ（クライアント返却用）
 *
 * 設計判断: zod 等の追加依存は使わず手書きガード。
 * Phase 3 でフィールドが増えたら本関数 + DB CHECK 制約の両方を更新する。
 */
function validateLog(log: unknown): string | null {
  if (typeof log !== 'object' || log === null) {
    return 'must be an object';
  }
  const l = log as Partial<SpoilerJudgmentLog>;

  if (typeof l.logId !== 'string' || l.logId.length === 0) return 'logId is required';
  if (typeof l.recordedAt !== 'string') return 'recordedAt is required';
  if (typeof l.consentVersion !== 'string') return 'consentVersion is required';
  if (typeof l.videoId !== 'string') return 'videoId is required';
  if (typeof l.channelId !== 'string') return 'channelId is required';
  if (typeof l.judgmentMode !== 'string' || !VALID_JUDGMENT_MODES.has(l.judgmentMode)) {
    return 'judgmentMode must be one of live/archive_replay/post_stream_review';
  }

  // targetMessage
  if (typeof l.targetMessage !== 'object' || l.targetMessage === null) {
    return 'targetMessage is required';
  }
  const t = l.targetMessage;
  if (typeof t.body !== 'string') return 'targetMessage.body is required';
  if (typeof t.authorChannelId !== 'string' || t.authorChannelId.length === 0) {
    return 'targetMessage.authorChannelId is required';
  }
  if (typeof t.timestamp !== 'string') return 'targetMessage.timestamp is required';

  // 配列
  if (!Array.isArray(l.precedingMessages)) return 'precedingMessages must be an array';
  if (!Array.isArray(l.followingMessages)) return 'followingMessages must be an array';

  // 段階A / B
  if (typeof l.stageACategory !== 'string' || !VALID_STAGE_A.has(l.stageACategory)) {
    return 'stageACategory must be one of story_reference/reaction/meta/unknown';
  }
  if (!Array.isArray(l.labels) || l.labels.length === 0) {
    return 'labels must be a non-empty array';
  }
  for (const label of l.labels) {
    if (typeof label !== 'string' || !VALID_LABELS.has(label)) {
      return `labels contains invalid value: ${String(label)}`;
    }
  }
  if (typeof l.primaryLabel !== 'string' || !VALID_LABELS.has(l.primaryLabel)) {
    return 'primaryLabel must be a valid CollectionLabel';
  }
  if (typeof l.confidence !== 'number') return 'confidence must be a number';
  if (typeof l.stage !== 'string' || !VALID_STAGES.has(l.stage)) {
    return 'stage must be one of stage1/stage1_5/stage2';
  }

  if (typeof l.labelSource !== 'string' || !VALID_LABEL_SOURCES.has(l.labelSource)) {
    return 'labelSource must be one of haiku/user_report/moderator/tommy_manual';
  }
  if (typeof l.reviewedByHuman !== 'boolean') return 'reviewedByHuman must be a boolean';

  if (typeof l.extensionVersion !== 'string') return 'extensionVersion is required';
  // userTokenHashed はクライアントが送ってきても本サーバーが上書きするが、
  // 型としては string が来る前提。誤った型なら早めに弾く。
  if (typeof l.userTokenHashed !== 'string') return 'userTokenHashed is required';

  return null;
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = {
  MAX_BATCH,
  validateLog,
};
