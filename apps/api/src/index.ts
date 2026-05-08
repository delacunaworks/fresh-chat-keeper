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
import { ingestRouter } from './routes/ingest.js';
import { revokeRouter } from './routes/revoke.js';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) =>
  c.json({
    name: 'fresh-chat-keeper-api',
    status: 'ok',
    phase: '2.5',
  }),
);

app.route('/v1', ingestRouter);
app.route('/v1', revokeRouter);

export default app;
