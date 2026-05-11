/**
 * Fresh Chat Keeper Collection API — Cloudflare Workers
 *
 * Phase 2.5（v0.3.5）でデータ収集インフラとして先行新設される統合API。
 *
 * 役割（Phase 2.5 時点）:
 * - POST /v1/ingest — opt-in したクライアントから判定ログを D1 に蓄積
 * - POST /v1/revoke — 同意取り消し（consent_records.revoked_at 更新 +
 *   judgment_logs の bulk delete）
 * - GET / — ヘルスチェック
 *
 * Phase 6 で追加予定:
 * - YouTube OAuth、配信者プロフィール / broadcast 管理
 * - apps/proxy の段階的移行先となる judge endpoint
 * - retention cron（B3 で実装、本ファイルには増設のみ）
 *
 * @see dev-docs/phase-2-5-data-collection.md §5
 */

import { Hono } from 'hono';
import type { Env } from './env.js';
import { corsMiddleware } from './middleware/cors.js';
import { ingestRouter } from './routes/ingest.js';
import { revokeRouter } from './routes/revoke.js';
import { consentRouter } from './routes/consent.js';
import { runRetention } from './db/retention.js';

const app = new Hono<{ Bindings: Env }>();

// CORS は /v1/* だけに適用する。`GET /` ヘルスチェックは origin を見ずに
// 200 を返す（モニタリング・uptime check は様々な経路から打たれるため）。
app.use('/v1/*', corsMiddleware);

app.get('/', (c) =>
  c.json({
    name: 'fresh-chat-keeper-api',
    status: 'ok',
    phase: '2.5',
  }),
);

app.route('/v1', ingestRouter);
app.route('/v1', revokeRouter);
app.route('/v1', consentRouter);

/**
 * Cloudflare Workers の cron trigger ハンドラ。wrangler.toml の
 * `[triggers] crons = ["0 3 * * *"]` から毎日 03:00 UTC に呼ばれる。
 *
 * scheduled は default export の中で fetch と並列で公開する必要がある。
 */
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // waitUntil で retention の完了を待つ。例外は Cloudflare 側で
    // 「scheduled task failed」として記録される。
    ctx.waitUntil(
      runRetention(env.COLLECTION_DB).catch((err) => {
        console.error(
          `[fck-api] retention failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
    );
  },
};
