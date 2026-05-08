/**
 * POST /v1/consent
 *
 * クライアントが opt-in モーダルで「同意」した直後に送信される通知。
 * サーバー側 consent_records に UPSERT を行い、後の revoke / retention の
 * 起点を作る。
 *
 * 設計判断:
 * - rate-limit middleware を適用（consent 通知は頻度が低いはずだが、攻撃
 *   ベクタになりうるため軽量レート制限は必須）
 * - consent-check middleware は使わない（このエンドポイント自身が
 *   consentVersion を受け取り、consent_versions テーブルへの存在確認を
 *   独自に行う）
 * - body のパースは consent-check と独立した形で行う
 *
 * フロー:
 * 1. rate-limit
 * 2. token-check（UUID v4）
 * 3. body.consentVersion を読む（不正なら 422）
 * 4. consentVersion が consent_versions テーブルに存在するか確認（無ければ 422）
 * 5. x-fck-token を SHA-1 + COLLECTION_SALT でハッシュ化
 * 6. consent_records に UPSERT（既存行の revoked_at クリア対応）
 * 7. 200 OK + ConsentNotifyResponsePayload
 *
 * @see dev-docs/phase-2-5-data-collection.md §6.1〜6.3
 */

import { Hono } from 'hono';
import type { Env } from '../env.js';
import type {
  ConsentNotifyRequestPayload,
  ConsentNotifyResponsePayload,
} from '@fresh-chat-keeper/shared';
import { tokenCheckMiddleware } from '../middleware/token-check.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import { hashUserToken, assertValidSalt } from '../lib/hash.js';
import { upsertConsentRecord, consentVersionExists } from '../db/repository.js';

export const consentRouter = new Hono<{
  Bindings: Env;
  Variables: { rawToken: string };
}>();

consentRouter.post(
  '/consent',
  rateLimitMiddleware,
  tokenCheckMiddleware,
  async (c) => {
    const rawToken = c.get('rawToken');

    // body 読み出し
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }

    const payload = body as Partial<ConsentNotifyRequestPayload>;
    if (typeof payload.consentVersion !== 'string' || payload.consentVersion.length === 0) {
      return c.json({ error: 'consentVersion is required' }, 422);
    }

    // consent_versions テーブルへの存在確認
    let exists: boolean;
    try {
      exists = await consentVersionExists(c.env.COLLECTION_DB, payload.consentVersion);
    } catch (err) {
      console.error(
        `[fck-api] consentVersionExists failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: 'Database error' }, 500);
    }
    if (!exists) {
      return c.json({ error: 'Unknown consentVersion' }, 422);
    }

    // salt 検証 + token ハッシュ化
    const salt = c.env.COLLECTION_SALT;
    try {
      assertValidSalt(salt);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return c.json({ error: 'Server misconfiguration' }, 500);
    }
    const hashedToken = await hashUserToken(rawToken, salt);

    // UPSERT
    try {
      await upsertConsentRecord(
        c.env.COLLECTION_DB,
        hashedToken,
        payload.consentVersion,
        Date.now(),
      );
    } catch (err) {
      console.error(
        `[fck-api] upsertConsentRecord failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: 'Failed to record consent' }, 500);
    }

    const response: ConsentNotifyResponsePayload = {
      recorded: true,
      currentConsentVersion: payload.consentVersion,
    };
    return c.json(response, 200);
  },
);
