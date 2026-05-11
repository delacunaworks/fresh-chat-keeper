/**
 * CORS middleware（chrome-extension origin 許可）。
 *
 * apps/proxy は `Access-Control-Allow-Origin: *` のワイルドカード許可だが、
 * apps/api は判定ログという機微データを扱うため、**ALLOWED_ORIGINS 環境変数で
 * 明示的に列挙された origin のみ** を許可する。これにより:
 *
 * 1. 任意の web ページから x-fck-token を盗んだ攻撃者が直接 ingest を打てない
 *    （x-fck-token は本来クライアント側でしか保持しないが、漏洩リスクの低減）
 * 2. CORS preflight の段階で不正な origin を弾き、handler ロジックに到達しない
 *
 * ALLOWED_ORIGINS は wrangler.toml の `[vars]` で「カンマ区切りの origin リスト」
 * として指定される。本番では Chrome Web Store 発行の extension ID を含む。
 *
 * @see dev-docs/phase-2-5-data-collection.md §5.4
 */

import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';

/**
 * env.ALLOWED_ORIGINS をパースして cors() に渡す middleware を組み立てる。
 *
 * リクエストごとに env を参照する必要があるため、cors() を直接 export せず
 * createMiddleware で env 取得 → cors 呼び出しの順で実行する形にしている。
 */
export const corsMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const allowed = parseAllowedOrigins(c.env.ALLOWED_ORIGINS);
  if (allowed.length === 0) {
    // 環境変数の事故消去・誤デプロイ検出。warn ログを残し、
    // origin を一切許可しない（preflight が全て失敗）状態にする。
    console.warn('[fck-api] ALLOWED_ORIGINS is empty, all CORS requests will be rejected');
  }

  const handler: MiddlewareHandler = cors({
    origin: (origin) => {
      if (!origin) return null;
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'x-fck-token'],
    maxAge: 600,
  });

  return handler(c, next);
});

/**
 * カンマ区切り string を origin の配列に正規化する。
 * 空白・空文字エントリ・末尾スラッシュは除去する。
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s.length > 0);
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = { parseAllowedOrigins };
