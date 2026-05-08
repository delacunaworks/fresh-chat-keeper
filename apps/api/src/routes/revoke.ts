/**
 * POST /v1/revoke
 *
 * 視聴者の同意取り消しを処理する。設計書 §6.4。
 *
 * フロー:
 * 1. rate-limit middleware
 * 2. token-check middleware（x-fck-token 形式検証）
 * 3. 本ハンドラ:
 *    a. x-fck-token を SHA-1 + COLLECTION_SALT でハッシュ化
 *    b. consent_records.revoked_at を更新
 *    c. judgment_logs から該当ユーザーの行を削除
 *    d. 200 OK + RevokeResponsePayload（idempotent: 該当なしでも 200）
 *
 * idempotency:
 * - 既に revoked、または一度も consent していないユーザーから revoke が来ても、
 *   final state は同じ（user_token_hashed のログは存在しない）なので 200 を返す
 *
 * セキュリティ:
 * - body の `reason` は Phase 2.5 では未使用（型上は受け付ける）
 * - consent-check middleware は使わない（取り消しは古い同意バージョンでも受理する必要がある）
 *
 * @see dev-docs/phase-2-5-data-collection.md §6.4
 */

import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { RevokeResponsePayload } from '@fresh-chat-keeper/shared';
import { tokenCheckMiddleware } from '../middleware/token-check.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import { hashUserToken } from '../lib/hash.js';
import { revokeConsentAndDeleteLogs } from '../db/repository.js';

export const revokeRouter = new Hono<{
  Bindings: Env;
  Variables: { rawToken: string };
}>();

revokeRouter.post(
  '/revoke',
  rateLimitMiddleware,
  tokenCheckMiddleware,
  async (c) => {
    const rawToken = c.get('rawToken');

    // body は任意（reason のみ将来用、Phase 2.5 では参照しない）。
    // パース失敗は無視して空オブジェクト扱い。
    try {
      await c.req.json();
    } catch {
      // ignore: revoke は body 不要
    }

    const hashedToken = await hashUserToken(rawToken, c.env.COLLECTION_SALT);

    let deletedLogCount: number | null;
    try {
      deletedLogCount = await revokeConsentAndDeleteLogs(
        c.env.COLLECTION_DB,
        hashedToken,
        Date.now(),
      );
    } catch (err) {
      console.error(
        `[fck-api] revoke failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: 'Failed to revoke consent' }, 500);
    }

    const response: RevokeResponsePayload = {
      revoked: true,
      deletedLogCount,
    };
    return c.json(response, 200);
  },
);
