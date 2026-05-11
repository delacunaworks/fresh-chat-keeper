/**
 * D1 行表現と camelCase ワイヤー形式の相互変換。
 *
 * 命名規則の橋渡し:
 * - TS / JSON 側は camelCase（packages/shared/src/types/collection.ts）
 * - D1 側は snake_case（migrations/0001_initial_collection.sql）
 *
 * `JudgmentLogRow` は D1 から SELECT したときの素直な行表現で、ストレージ寄りの
 * 命名と型（boolean → INTEGER 0/1、ISO8601 → Unix ms、配列 / オブジェクト → JSON 文字列）
 * を保持する。`toJudgmentLogRow` で wire 型から DB 行を作り、`fromJudgmentLogRow` で
 * 反対方向の変換を行う。
 */

import type {
  SpoilerJudgmentLog,
  CollectionLabel,
  StageACategory,
  JudgmentMode,
  LabelSource,
  JudgmentStage,
  ContextMessage,
  UserFeedbackPayload,
} from '@fresh-chat-keeper/shared';

// ─── D1 行型 ───────────────────────────────────────────────────

/**
 * judgment_logs テーブル 1 行分。`PRIMARY KEY = log_id`。
 *
 * D1 は number / string / null のみを保持できるため、boolean は 0/1 INTEGER、
 * 構造体は JSON.stringify した TEXT で保存する。
 */
export interface JudgmentLogRow {
  log_id: string;
  recorded_at: number;            // Unix ms
  consent_version: string;
  video_id: string;
  channel_id: string;
  game_title: string | null;
  stream_progress_hint: string | null;
  time_into_stream: number | null;
  judgment_mode: JudgmentMode;
  target_body: string;
  target_author_channel_id: string;     // 既にハッシュ化済み
  target_timestamp: number;             // Unix ms
  target_is_member: 0 | 1 | null;
  target_is_moderator: 0 | 1 | null;
  target_is_verified: 0 | 1 | null;
  preceding_messages_json: string;
  following_messages_json: string;
  stage_a_category: StageACategory;
  stage_a_confidence: number | null;
  labels_json: string;
  primary_label: CollectionLabel;
  confidence: number;
  stage: JudgmentStage;
  reason_ja: string | null;
  label_source: LabelSource;
  reviewed_by_human: 0 | 1;
  user_feedback_json: string | null;
  extension_version: string;
  user_token_hashed: string;
  received_at: number;
}

/** consent_records テーブル 1 行分 */
export interface ConsentRecordRow {
  user_token_hashed: string;
  consent_version: string;
  consented_at: number;
  revoked_at: number | null;
}

/** consent_versions テーブル 1 行分 */
export interface ConsentVersionRow {
  version: string;
  policy_url: string;
  effective_from: number;
  superseded_at: number | null;
}

// ─── 変換ヘルパー ─────────────────────────────────────────────

function toUnixMs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    // 不正な ISO はバリデーションで落とす想定だが、保険として 0 を返さず例外
    throw new Error(`Invalid ISO 8601 timestamp: ${iso}`);
  }
  return ms;
}

function fromUnixMs(ms: number): string {
  return new Date(ms).toISOString();
}

function toBoolNullable(v: boolean | null | undefined): 0 | 1 | null {
  if (v === null || v === undefined) return null;
  return v ? 1 : 0;
}

function fromBoolNullable(v: 0 | 1 | null): boolean | null {
  if (v === null) return null;
  return v === 1;
}

// ─── 変換関数 ─────────────────────────────────────────────────

/**
 * クライアント送信形式（SpoilerJudgmentLog）を D1 行に変換する。
 *
 * @param log クライアント送信ログ
 * @param hashedAuthorChannelId サーバー側で SHA-1 化した authorChannelId（apps/api の hash.ts で生成）
 * @param hashedUserToken サーバー側で SHA-1 化した x-fck-token
 * @param receivedAt 受信時刻（Unix ms、retention 用）
 */
export function toJudgmentLogRow(
  log: SpoilerJudgmentLog,
  hashedAuthorChannelId: string,
  hashedUserToken: string,
  receivedAt: number,
): JudgmentLogRow {
  return {
    log_id: log.logId,
    recorded_at: toUnixMs(log.recordedAt),
    consent_version: log.consentVersion,
    video_id: log.videoId,
    channel_id: log.channelId,
    game_title: log.gameTitle,
    stream_progress_hint: log.streamProgressHint,
    time_into_stream: log.timeIntoStream,
    judgment_mode: log.judgmentMode,
    target_body: log.targetMessage.body,
    target_author_channel_id: hashedAuthorChannelId,
    target_timestamp: toUnixMs(log.targetMessage.timestamp),
    target_is_member: toBoolNullable(log.targetMessage.isMember),
    target_is_moderator: toBoolNullable(log.targetMessage.isModerator),
    target_is_verified: toBoolNullable(log.targetMessage.isVerified),
    preceding_messages_json: JSON.stringify(log.precedingMessages ?? []),
    following_messages_json: JSON.stringify(log.followingMessages ?? []),
    stage_a_category: log.stageACategory,
    stage_a_confidence: log.stageAConfidence,
    labels_json: JSON.stringify(log.labels),
    primary_label: log.primaryLabel,
    confidence: log.confidence,
    stage: log.stage,
    reason_ja: log.reasonJa,
    label_source: log.labelSource,
    reviewed_by_human: log.reviewedByHuman ? 1 : 0,
    user_feedback_json: log.userFeedback ? JSON.stringify(log.userFeedback) : null,
    extension_version: log.extensionVersion,
    user_token_hashed: hashedUserToken,
    received_at: receivedAt,
  };
}

/**
 * 壊れた JSON 文字列を読み込む際の安全フォールバック。
 *
 * D1 側に json_valid() CHECK があるため通常は不正な JSON は入らないが、
 * - マイグレーション前データの読み出し
 * - DB 直接書き込みによる事故
 * - スキーマ変更時の中間状態
 * 等で例外が発生し得る。warn ログを残しデフォルト値を返すことで、
 * fromJudgmentLogRow が 1 行の異常で全体クラッシュしないようにする。
 */
function safeJsonParse<T>(raw: string | null, fallback: T, fieldName: string): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(
      `[fck-api] safeJsonParse: failed to parse ${fieldName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return fallback;
  }
}

/**
 * D1 行を SpoilerJudgmentLog（ワイヤー形式）に戻す。
 *
 * Phase 2.5 では SELECT 系 API を持たないため、現状はテスト・将来の retention
 * バッチ・Phase 3 のレビュー UI で使う想定。
 */
export function fromJudgmentLogRow(row: JudgmentLogRow): SpoilerJudgmentLog {
  return {
    logId: row.log_id,
    recordedAt: fromUnixMs(row.recorded_at),
    consentVersion: row.consent_version,
    videoId: row.video_id,
    channelId: row.channel_id,
    gameTitle: row.game_title,
    streamProgressHint: row.stream_progress_hint,
    timeIntoStream: row.time_into_stream,
    judgmentMode: row.judgment_mode,
    targetMessage: {
      body: row.target_body,
      authorChannelId: row.target_author_channel_id,
      timestamp: fromUnixMs(row.target_timestamp),
      isMember: fromBoolNullable(row.target_is_member),
      isModerator: fromBoolNullable(row.target_is_moderator),
      isVerified: fromBoolNullable(row.target_is_verified),
    },
    precedingMessages: safeJsonParse<ContextMessage[]>(
      row.preceding_messages_json,
      [],
      'preceding_messages_json',
    ),
    followingMessages: safeJsonParse<ContextMessage[]>(
      row.following_messages_json,
      [],
      'following_messages_json',
    ),
    stageACategory: row.stage_a_category,
    stageAConfidence: row.stage_a_confidence,
    labels: safeJsonParse<CollectionLabel[]>(row.labels_json, [], 'labels_json'),
    primaryLabel: row.primary_label,
    confidence: row.confidence,
    stage: row.stage,
    reasonJa: row.reason_ja,
    labelSource: row.label_source,
    reviewedByHuman: row.reviewed_by_human === 1,
    userFeedback: safeJsonParse<UserFeedbackPayload | null>(
      row.user_feedback_json,
      null,
      'user_feedback_json',
    ),
    extensionVersion: row.extension_version,
    userTokenHashed: row.user_token_hashed,
  };
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = { safeJsonParse };
