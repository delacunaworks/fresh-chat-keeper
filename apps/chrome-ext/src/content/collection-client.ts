/**
 * Phase 2.5 データ収集 API クライアント（chrome-ext content-script / popup 側）。
 *
 * apps/api への以下 3 エンドポイントへのラッパー:
 *   POST /v1/consent — opt-in 通知（モーダル承諾直後）
 *   POST /v1/ingest  — 判定ログ送信（バッチ最大 50 件、5s インターバル）
 *   POST /v1/revoke  — 同意取り消し
 *
 * **BACKGROUND-01 (2026-05)**: 旧設計では content-script から直接 fetch して
 * いたが、Chrome 147 の MV3 仕様により host_permissions ありでも fetch は
 * 注入先 origin (https://www.youtube.com) で発行される。本番安全性のため
 * `chrome.runtime.sendMessage` 経由で background service worker に依頼し、
 * chrome-extension:// origin で fetch を発火する設計に統一。popup からの
 * fetch も同経路を通る（一貫性のため）。詳細は
 * `apps/chrome-ext/src/background/service-worker.ts` の handleBgFetch 参照。
 *
 * 設計判断:
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
  BackgroundFetchRequest,
  BackgroundFetchResponse,
  BgFetchEndpoint,
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

// ─── background 経由 fetch ヘルパー ────────────────────────────

/**
 * background service worker 経由で fetch を発行する。
 *
 * BACKGROUND-01 の心臓部。content-script / popup から直接 fetch する代わりに
 * `chrome.runtime.sendMessage` で background に依頼し、background が
 * chrome-extension:// origin で fetch を実行する。これにより本番 ALLOWED_ORIGINS は
 * chrome-extension のみで済み、youtube.com 等の緩和許可は不要になる。
 *
 * 失敗パターン:
 * - sendMessage 自体が throw（chrome.runtime が無効化された等） → network
 * - response が undefined（背景にリスナーがない / sendResponse されなかった） → network
 * - response が `{ ok: false, ... }` → そのまま返却
 */
async function bgFetch(
  endpoint: BgFetchEndpoint,
  ctx: CollectionClientContext,
  body: unknown,
): Promise<BackgroundFetchResponse> {
  const req: BackgroundFetchRequest = {
    type: 'fck:bg-fetch',
    endpoint,
    apiUrl: ctx.apiUrl,
    token: ctx.token,
    body,
  };
  let res: BackgroundFetchResponse | undefined;
  try {
    res = (await chrome.runtime.sendMessage(req)) as
      | BackgroundFetchResponse
      | undefined;
  } catch (err) {
    return {
      ok: false,
      kind: 'network',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (res === undefined || res === null) {
    return {
      ok: false,
      kind: 'network',
      message: 'no response from background service worker',
    };
  }
  return res;
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
  const res = await bgFetch('consent', ctx, payload);

  if (!res.ok) {
    // network / invalid-origin / invalid-request: サーバーに到達できなかった
    // 既存呼び出し側 (App.tsx handleConsent) は ConsentApiError 以外を
    // 「ネットワークエラー」としてユーザーに表示するため、通常 Error を投げる
    throw new Error(`bg-fetch failed (${res.kind}): ${res.message}`);
  }

  if (res.status === 200) {
    return res.json as ConsentNotifyResponsePayload;
  }

  // 422: unknown consentVersion 等（クライアントが古い）
  // それ以外: サーバー側不具合 or auth 問題
  throw new ConsentApiError(res.status, jsonToBodyString(res.json));
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
  // body 不要だが Content-Length: 0 を避けるため空オブジェクトを送る
  const res = await bgFetch('revoke', ctx, {});

  if (!res.ok) {
    throw new Error(`bg-fetch failed (${res.kind}): ${res.message}`);
  }
  if (res.status === 200) {
    return res.json as RevokeResponsePayload;
  }
  throw new ConsentApiError(res.status, jsonToBodyString(res.json));
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
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushing = false;
  private retryCount = 0;
  /**
   * バックオフ待機中フラグ。true の間は 5 秒タイマーや 50 件到達による
   * 即フラッシュを抑止し、バックオフタイマーの満了に統一する。
   *
   * **B5 review C-2 で導入**: バックオフ中に enqueueLog が走ると 5 秒
   * タイマーが立ち、その後 30 秒バックオフタイマーも発火し、両方が
   * 短期間に flush() を呼ぶ二重送信に近い挙動が発生していた。
   */
  private inBackoff = false;
  /** 410 で sendMessage 済みフラグ。多重通知を抑止 */
  private consentRefreshNotified = false;

  constructor(private readonly ctx: CollectionClientContext) {}

  /** バッファにログを追加。50 件到達で即フラッシュ、それ未満なら 5 秒タイマー予約。 */
  enqueueLog(log: SpoilerJudgmentLog): void {
    this.buffer.push(log);
    // バックオフ中は 5 秒タイマーも 50 件即フラッシュも抑止する。
    // バックオフ満了時の flush でまとめて処理される（または上限到達で破棄）。
    if (this.inBackoff) return;
    if (this.buffer.length >= MAX_BATCH) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  /** 強制フラッシュ。revoke 時 / 拡張シャットダウン時に呼ぶ。 */
  async flush(): Promise<void> {
    if (this.isFlushing) return;
    // バックオフ中は外部からの flush 呼び出しを抑止し、
    // バックオフタイマー経由の flush だけが内部から走るようにする
    // （flush 内で `this.inBackoff = false` してから sendBatch する）
    if (this.inBackoff) return;
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
          // バックオフ予約。inBackoff フラグで他の flush 経路を抑止。
          this.inBackoff = true;
          this.backoffTimer = setTimeout(() => {
            this.backoffTimer = null;
            this.inBackoff = false;
            void this.flush();
          }, RETRY_BACKOFF_MS);
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
      // バッファに残りがあれば次回フラッシュを予約（バックオフ中は抑止される）
      if (!this.inBackoff && this.buffer.length > 0) this.scheduleFlush();
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
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    this.inBackoff = false;
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
   * - 'drop': 410 / 422 / 401 / invalid-origin。再送しない
   * - 'retry': 429 / 5xx / network。バックオフ後再試行候補
   */
  private async sendBatch(
    batch: SpoilerJudgmentLog[],
  ): Promise<'success' | 'drop' | 'retry'> {
    const consentVersion = batch[0]?.consentVersion ?? '';
    const payload: IngestRequestPayload = { consentVersion, logs: batch };

    const res = await bgFetch('ingest', this.ctx, payload);

    if (!res.ok) {
      if (res.kind === 'network') {
        console.warn(`[FreshChatKeeper] ingest network error: ${res.message}`);
        return 'retry';
      }
      // invalid-origin / invalid-request: 設定不正なので再送しても直らない
      console.error(
        `[FreshChatKeeper] ingest ${res.kind} (${batch.length} logs dropped): ${res.message}`,
      );
      return 'drop';
    }

    if (res.status === 200) {
      // body は読まずに破棄（サーバーが返す accepted/rejected はログだけで使う想定）
      void (res.json as IngestResponsePayload);
      return 'success';
    }

    if (res.status === 410) {
      // consent_version_mismatch: クライアント側のバージョンが古い
      // popup に再同意モーダル表示を通知。consent state は popup 側で
      // 「現在 opt-in 中だが mismatch を検出した」状態を示し、ユーザーアクション
      // を促す（content script 側で勝手に同意取り消しはしない）
      const body = res.json as { error?: string; currentConsentVersion?: string } | null;
      const currentConsentVersion = body?.currentConsentVersion ?? '';
      this.notifyConsentRefresh(currentConsentVersion);
      return 'drop';
    }

    if (res.status === 422) {
      // バリデーション失敗。クライアント側のログ構築バグなので再送しても直らない
      console.error(
        `[FreshChatKeeper] ingest 422 (${batch.length} logs dropped): ${jsonToBodyString(res.json)}`,
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

/**
 * background が parse 済みで返す json を ConsentApiError.body の string に正規化する。
 * オブジェクトは JSON.stringify、null/undefined は空文字、文字列はそのまま。
 */
function jsonToBodyString(json: unknown): string {
  if (json === null || json === undefined) return '';
  if (typeof json === 'string') return json;
  try {
    return JSON.stringify(json);
  } catch {
    return String(json);
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
