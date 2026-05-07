/**
 * Fresh Chat Keeper Collection API — Cloudflare Workers
 *
 * Phase 2.5（v0.3.5）でデータ収集インフラとして先行新設される統合API の雛形。
 *
 * 役割（Phase 2.5 時点）:
 * - ingestion endpoint `POST /v1/ingest` で判定ログを D1 に蓄積（B2 で実装）
 * - 90 日 retention の cron trigger（B2 の retention.ts で実装）
 *
 * Phase 6 で追加予定:
 * - YouTube OAuth、配信者プロフィール / broadcast 管理
 * - apps/proxy の段階的移行先となる judge endpoint
 *
 * 本ファイルは Hono ルーターのスケルトン。実エンドポイント実装は B2。
 *
 * @see dev-docs/phase-2-5-data-collection.md §5
 */

import { Hono } from 'hono';
import type { Env } from './env.js';

const app = new Hono<{ Bindings: Env }>();

/**
 * ヘルスチェック用エンドポイント。
 * デプロイ動作確認・モニタリング用途。実体ロジックは持たない。
 */
app.get('/', (c) =>
  c.json({
    name: 'fresh-chat-keeper-api',
    status: 'ok',
    phase: '2.5-scaffold',
  }),
);

// B2 で `routes/ingest.ts` 等を実装し、ここから `app.route('/v1', ingestRouter)`
// で接続する。Phase 2.5 のスコープでは未実装。

export default app;
