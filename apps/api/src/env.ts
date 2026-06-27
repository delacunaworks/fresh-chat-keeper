/**
 * apps/api の Cloudflare Workers 環境バインディング型。
 *
 * - D1 データベース（COLLECTION_DB）: ingestion ログと同意記録を格納
 * - KV: rate-limit / 同意バージョン管理（apps/proxy とは別 namespace）
 * - シークレット: ハッシュ用 salt（COLLECTION_SALT、P2.5-LEGAL-01 で値確定）
 *
 * 本ファイルは型定義のみ。バインディング自体の宣言は wrangler.toml と
 * `wrangler secret put` で行う。
 */

export interface Env {
  // ─── D1 ────────────────────────────────────────
  /** ingestion ログ・同意記録を格納する D1（`fck-collection-db`） */
  COLLECTION_DB: D1Database;

  // ─── KV ────────────────────────────────────────
  /** /v1/ingest 用の IP ベースレート制限カウンタ。apps/proxy とは別 namespace */
  RATE_LIMIT_KV: KVNamespace;
  /** 現在有効な consentVersion（クライアントの送信値と照合） */
  CONSENT_KV: KVNamespace;

  // ─── Durable Objects ──────────────────────────────
  /**
   * 配信(video_id)単位の音声文脈 DO（Phase 7 / P7-B3）。
   * `idFromName(videoId)` で singleton にルーティングし、文字起こし segment の
   * 蓄積・要約（P7-B4）を行う。SQLite-backed（Workers 無料枠で動作）。
   * クラス実体は src/stream-context/stream-context-do.ts、宣言は wrangler.toml。
   */
  STREAM_CONTEXT_DO: DurableObjectNamespace;

  // ─── シークレット ─────────────────────────────
  /**
   * authorChannelId 等のハッシュ化に使う共通 salt。
   * VTuber 1B (sigvt/holodata) の公開仕様に準拠（P2.5-LEGAL-01 で確定）。
   * `wrangler secret put COLLECTION_SALT` で本番に設定。
   * ローカル開発時は `.dev.vars` に書く。
   */
  COLLECTION_SALT: string;

  /**
   * ElevenLabs Scribe v2（ASR / 文字起こし）の API キー（Phase 7 / P7-B1）。
   * `apps/api/src/lib/scribe.ts` の `transcribe()` に渡す。
   * `wrangler secret put ELEVENLABS_API_KEY` で本番に設定し、
   * ローカル開発時は `.dev.vars` に書く（値はリポにコミットしない）。
   *
   * 実際の ASR 呼び出し配線（Durable Object / endpoint）は P7-B3 で行う。
   */
  ELEVENLABS_API_KEY: string;

  // ─── 公開 vars ────────────────────────────────────────
  /**
   * CORS 許可 origin のカンマ区切りリスト。
   *
   * 本番例:
   *   ALLOWED_ORIGINS = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
   *
   * 開発時は wrangler.toml の dev セクション or `.dev.vars` で localhost を追加:
   *   ALLOWED_ORIGINS = "chrome-extension://...,http://localhost:5173"
   *
   * extension ID は Chrome Web Store 公開時に確定する公開情報のため secret では
   * なく vars として扱う。空文字 / 未定義の場合は CORS middleware が起動時に
   * 例外を投げ、誤デプロイを早期に検出する。
   */
  ALLOWED_ORIGINS: string;
}
