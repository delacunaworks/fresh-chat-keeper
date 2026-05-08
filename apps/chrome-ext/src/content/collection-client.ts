/**
 * Phase 2.5 データ収集 API クライアント（chrome-ext content-script 側）。
 *
 * apps/api（B3 で完成）への以下 3 エンドポイントへの fetch ラッパー:
 *   POST /v1/consent — opt-in 通知（モーダル承諾直後）
 *   POST /v1/ingest  — 判定ログ送信（バッチ最大 50 件、5s インターバル）
 *   POST /v1/revoke  — 同意取り消し
 *
 * 設計判断:
 * - chrome-transport.ts と同じく content-script から直接 fetch（host_permissions
 *   経由で CORS 通過）。background 経由化は将来課題。
 * - opt-in OFF のユーザーは本モジュールを呼ばない（filter-orchestrator 側で
 *   getCollectionConsent() の null チェックでガード）
 * - 410 Gone（consent_version_mismatch）→ 同意モーダル再表示通知を popup へ
 * - 422 → 単発のクライアント不具合 / バリデーション漏れ。再送せずログだけ残す
 * - 429 / ネットワークエラー → 30 秒バックオフでリトライ最大 3 回、それ以降は破棄
 */

import type {
  SpoilerJudgmentLog,
  IngestRequestPayload,
  IngestResponsePayload,
  ConsentNotifyRequestPayload,
  ConsentNotifyResponsePayload,
  RevokeResponsePayload,
} from '@fresh-chat-keeper/shared';

// ─── 設定値 ────────────────────────────────────────────────────

/**
 * 許可される apps/api の origin（ハードコード）。
 *
 * **改ざん耐性のため env から読まずソースコードで固定する**。
 * ユーザーが chrome.storage.local の collectionApiUrl を手動で書き換えても、
 * このリストに含まれない origin にはリクエストを送らない。
 *
 * - 本番: fresh-chat-keeper-api.playnicelab.workers.dev（HTTPS のみ）
 * - 開発: localhost:8788 / 127.0.0.1:8788（wrangler dev デフォルト）
 *
 * DEPLOY-01 後に本番 origin が確定したらここを更新する。
 */
export const ALLOWED_API_ORIGINS: readonly string[] = [
  'https://fresh-chat-keeper-api.playnicelab.workers.dev',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
];

/**
 * apiUrl が許可リストに含まれるかを判定する。
 *
 * 失敗ケース（unknown / 不正な URL）は false を返し、呼び出し側が IngestClient
 * を起動しないことで「変な URL に判定ログを送らない」を保証する。
 */
export function isAllowedApiOrigin(apiUrl: string): boolean {
  try {
    const origin = new URL(apiUrl).origin;
    return ALLOWED_API_ORIGINS.includes(origin);
  } catch {
    return false;
  }
}

/** 1 リクエストあたりの最大ログ件数（apps/api 側 MAX_BATCH と一致） */
export const MAX_BATCH = 50;

/** バッファに溜まったログを送信するインターバル（ms） */
export const FLUSH_INTERVAL_MS = 5_000;

/** ネットワークエラー / 429 のリトライ上限 */
export const MAX_RETRIES = 3;

/** リトライ前の待機時間（ms）。30 秒固定（429 の Retry-After と整合） */
export const RETRY_BACKOFF_MS = 30_000;

// ─── 型 ────────────────────────────────────────────────────────

/**
 * 410 Gone レスポンスを受けたときに popup に再同意を促す通知の payload。
 * background service worker 経由ではなく chrome.runtime.sendMessage で popup に直送。
 */
export interface ConsentRefreshMessage {
  type: 'fck:consent-refresh-required';
  /** サーバー側で有効な consentVersion */
  currentConsentVersion: string;
}

/** ingest クライアントの依存をインジェクトするための context */
export interface CollectionClientContext {
  /** ベース URL（settings.collectionApiUrl） */
  apiUrl: string;
  /** 匿名トークン（既存 fck_anon_token、x-fck-token ヘッダに使用） */
  token: string;
}

// ─── consent / revoke（一発系 API）─────────────────────────────

/**
 * POST /v1/consent — opt-in 通知。
 *
 * 成功時はサーバー側 consent_records に UPSERT され、以降の ingest が受理される。
 *
 * @throws ConsentApiError 422 / その他のサーバーエラー時
 * @throws Error ネットワーク / fetch エラー時（呼び出し側でリトライ判断）
 */
export async function notifyConsent(
  ctx: CollectionClientContext,
  consentVersion: string,
): Promise<ConsentNotifyResponsePayload> {
  const payload: ConsentNotifyRequestPayload = { consentVersion };
  const res = await fetch(`${ctx.apiUrl}/v1/consent`, {
    method: 'POST',
    headers: jsonHeaders(ctx.token),
    body: JSON.stringify(payload),
  });

  if (res.status === 200) {
    return (await res.json()) as ConsentNotifyResponsePayload;
  }

  // 422: unknown consentVersion 等（クライアントが古い）
  // それ以外: サーバー側不具合 or auth 問題
  throw new ConsentApiError(res.status, await safeReadBody(res));
}

/**
 * POST /v1/revoke — 同意取り消し。
 *
 * idempotent: 既に revoked / そもそも consent していなくても 200 を返す。
 * サーバー側で `consent_records.revoked_at` 更新 + `judgment_logs` 削除（user_token_hashed 単位）。
 */
export async function notifyRevoke(
  ctx: CollectionClientContext,
): Promise<RevokeResponsePayload> {
  const res = await fetch(`${ctx.apiUrl}/v1/revoke`, {
    method: 'POST',
    headers: jsonHeaders(ctx.token),
    // body 不要だが Content-Length: 0 を避けるため空オブジェクトを送る
    body: JSON.stringify({}),
  });

  if (res.status === 200) {
    return (await res.json()) as RevokeResponsePayload;
  }
  throw new ConsentApiError(res.status, await safeReadBody(res));
}

// ─── ingest（バッチ送信） ─────────────────────────────────────

/**
 * 判定ログのバッファ管理 + 自動フラッシュを担う ingest クライアント。
 *
 * archive.ts / filter-orchestrator.ts から `enqueueLog` で投入し、
 * 5 秒ごと or 50 件到達でサーバーへ送信する。
 *
 * インスタンスは content-script 全体で 1 つ（archive.ts 起動時に生成、
 * 同一動画ページが閉じるまで再利用）。
 */
export class IngestClient {
  private buffer: SpoilerJudgmentLog[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushing = false;
  private retryCount = 0;
  /** 410 で sendMessage 済みフラグ。多重通知を抑止 */
  private consentRefreshNotified = false;

  constructor(private readonly ctx: CollectionClientContext) {}

  /** バッファにログを追加。50 件到達で即フラッシュ、それ未満なら 5 秒タイマー予約。 */
  enqueueLog(log: SpoilerJudgmentLog): void {
    this.buffer.push(log);
    if (this.buffer.length >= MAX_BATCH) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  /** 強制フラッシュ。revoke 時 / 拡張シャットダウン時に呼ぶ。 */
  async flush(): Promise<void> {
    if (this.isFlushing) return;
    if (this.buffer.length === 0) return;

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.isFlushing = true;
    const batch = this.buffer.splice(0, MAX_BATCH);

    try {
      const res = await this.sendBatch(batch);
      if (res === 'retry') {
        if (this.retryCount < MAX_RETRIES) {
          this.retryCount += 1;
          // バッファ先頭に戻して次回フラッシュで再試行
          this.buffer.unshift(...batch);
          // バックオフ後に再フラッシュ予約
          setTimeout(() => void this.flush(), RETRY_BACKOFF_MS);
        } else {
          // 上限到達: 諦めて破棄（ログのみ残す）
          console.warn(
            `[FreshChatKeeper] ingest dropped ${batch.length} logs after ${MAX_RETRIES} retries`,
          );
          this.retryCount = 0;
        }
      } else {
        // success / drop（再送しない）
        this.retryCount = 0;
      }
    } finally {
      this.isFlushing = false;
      // バッファに残りがあれば次回フラッシュを予約
      if (this.buffer.length > 0) this.scheduleFlush();
    }
  }

  /**
   * バッファをクリアして flush 予約をキャンセルする（revoke 時に使用）。
   * 進行中の flush は abort できないので、結果的にサーバーに到達するログが
   * 数件残る可能性があるが、サーバー側 revoke で削除されるため最終整合する。
   */
  abort(): void {
    this.buffer = [];
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.retryCount = 0;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  /**
   * 1 バッチを送信。戻り値:
   * - 'success': 200 OK
   * - 'drop': 410 / 422 / 401。再送しない（呼び出し側もリトライしない）
   * - 'retry': 429 / 5xx / network。バックオフ後再試行候補
   */
  private async sendBatch(
    batch: SpoilerJudgmentLog[],
  ): Promise<'success' | 'drop' | 'retry'> {
    const consentVersion = batch[0]?.consentVersion ?? '';
    const payload: IngestRequestPayload = { consentVersion, logs: batch };

    let res: Response;
    try {
      res = await fetch(`${this.ctx.apiUrl}/v1/ingest`, {
        method: 'POST',
        headers: jsonHeaders(this.ctx.token),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // ネットワーク障害（DNS / TLS / オフライン）
      console.warn(
        `[FreshChatKeeper] ingest network error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'retry';
    }

    if (res.status === 200) {
      // body は読まずに破棄（サーバーが返す accepted/rejected はログだけで使う想定）
      try {
        const _body = (await res.json()) as IngestResponsePayload;
        void _body;
      } catch {
        // body 解析失敗でも 200 なら成功扱い
      }
      return 'success';
    }

    if (res.status === 410) {
      // consent_version_mismatch: クライアント側のバージョンが古い
      // popup に再同意モーダル表示を通知。consent state は popup 側で
      // 「現在 opt-in 中だが mismatch を検出した」状態を示し、ユーザーアクション
      // を促す（content script 側で勝手に同意取り消しはしない）
      try {
        const body = (await res.json()) as { error?: string; currentConsentVersion?: string };
        const currentConsentVersion = body.currentConsentVersion ?? '';
        this.notifyConsentRefresh(currentConsentVersion);
      } catch {
        this.notifyConsentRefresh('');
      }
      return 'drop';
    }

    if (res.status === 422) {
      // バリデーション失敗。クライアント側のログ構築バグなので再送しても直らない
      const body = await safeReadBody(res);
      console.error(
        `[FreshChatKeeper] ingest 422 (${batch.length} logs dropped): ${body}`,
      );
      return 'drop';
    }

    if (res.status === 401) {
      // x-fck-token 不正（UUID 形式違反 or 欠落）。トークンが壊れているため再送不可
      console.error('[FreshChatKeeper] ingest 401: token rejected, dropping batch');
      return 'drop';
    }

    if (res.status === 429 || res.status >= 500) {
      // レート制限 or サーバー障害。バックオフ後リトライ
      return 'retry';
    }

    // 想定外のステータス: 再送せず破棄
    console.warn(`[FreshChatKeeper] ingest unexpected status ${res.status}, dropping batch`);
    return 'drop';
  }

  private notifyConsentRefresh(currentConsentVersion: string): void {
    if (this.consentRefreshNotified) return;
    this.consentRefreshNotified = true;
    const msg: ConsentRefreshMessage = {
      type: 'fck:consent-refresh-required',
      currentConsentVersion,
    };
    try {
      // popup が開いていない場合は無応答 / chrome.runtime.lastError が発生するが、
      // popup が次に開いた時点で sendMessage は届かないので、popup 側でも
      // chrome.storage.local の状態を毎回確認する必要がある（App.tsx 側で対応）
      chrome.runtime.sendMessage(msg).catch(() => undefined);
    } catch {
      // chrome.runtime が無効化されている等
    }
  }

  // ─── テスト用 getter ─────────────────────────────────────

  /** @internal テスト用：現在のバッファサイズ */
  _bufferSize(): number {
    return this.buffer.length;
  }

  /** @internal テスト用：リトライカウントの現在値 */
  _retryCount(): number {
    return this.retryCount;
  }
}

// ─── ヘルパー ──────────────────────────────────────────────────

function jsonHeaders(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'x-fck-token': token,
  };
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** /v1/consent と /v1/revoke が投げる API エラー（HTTP ステータス + body 文字列） */
export class ConsentApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Consent API error: HTTP ${status}`);
    this.name = 'ConsentApiError';
  }
}
