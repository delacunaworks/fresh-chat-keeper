/**
 * x-fck-token 形式検証 middleware。
 *
 * 役割:
 * - x-fck-token ヘッダの存在を確認
 * - UUID v4 形式（36 文字、`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`）であることを確認
 * - 通過後は c.set('rawToken', token) で次の middleware / handler に渡す
 *
 * 設計判断:
 * - 厳密な署名検証は Phase 2.5 では行わない（既存 apps/proxy 規約踏襲）
 * - 形式不正の場合は 401 を返し、トークン再生成を促す
 *
 * @see dev-docs/phase-2-5-data-collection.md §5.4
 */

import { createMiddleware } from 'hono/factory';
import type { Env } from '../env.js';

/** UUID v4 の正規表現。緩めに `4` の固定と variant の `8/9/a/b` を許容。 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const tokenCheckMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { rawToken: string };
}>(async (c, next) => {
  const token = c.req.header('x-fck-token');
  if (!token) {
    return c.json({ error: 'Missing x-fck-token header' }, 401);
  }
  if (!UUID_V4_REGEX.test(token)) {
    return c.json({ error: 'Invalid x-fck-token format' }, 401);
  }
  c.set('rawToken', token);
  await next();
});

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = { UUID_V4_REGEX };
