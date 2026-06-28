/**
 * Background Service Worker 経由の fetch プロキシのメッセージ契約。
 *
 * **背景 (BACKGROUND-01)**:
 * Chrome 147 の MV3 仕様調査により、host_permissions ありでも content-script
 * の fetch は注入先 origin (https://www.youtube.com) で発行されることが判明。
 * これにより apps/api 側の ALLOWED_ORIGINS に youtube.com を含めない限り
 * CORS で reject される。本番では security 上 youtube.com を許可できないため、
 * BACKGROUND-01 で content-script / popup からのすべての fetch を background
 * service worker 経由に変更し、chrome-extension:// origin で発行されるよう
 * 統一する。
 *
 * 通信フロー:
 *   content-script / popup → chrome.runtime.sendMessage(BackgroundFetchRequest)
 *     → background service worker
 *     → fetch (chrome-extension:// origin で発火)
 *     → BackgroundFetchResponse を sendResponse で返却
 *
 * @see dev-docs/phase-2-5-data-collection.md §5.4
 */

/**
 * apps/api のエンドポイントを表す discriminated union のタグ。
 * background 側はこの値から URL パスを構築する（service-worker の ENDPOINT_PATHS）。
 *
 * - ingest / consent / revoke: Phase 2.5 データ収集（consent 必須）
 * - stream-context/captions: Phase 7（P7-FEED）字幕 feeder。token-check のみ
 *   （consent 不要・captionContext.enabled で gating）。
 */
export type BgFetchEndpoint = 'ingest' | 'consent' | 'revoke' | 'stream-context/captions';

/**
 * content-script / popup から background へ送る fetch 依頼のペイロード。
 *
 * **type フィールド**: discriminated union のタグとして使用し、background が
 * `'fck:bg-fetch'` のメッセージのみを処理する（他の chrome.runtime メッセージ
 * — 例: `'fck:consent-refresh-required'` — はスルーする）。
 *
 * **body フィールド**: background 側で JSON.stringify される。null / undefined
 * の場合は body なしのリクエスト（revoke 等）として扱う。
 */
export interface BackgroundFetchRequest {
  type: 'fck:bg-fetch';
  endpoint: BgFetchEndpoint;
  /** apps/api のベース URL。例: 'http://localhost:8788' / 本番 URL */
  apiUrl: string;
  /** x-fck-token ヘッダーに使う匿名トークン（UUID 形式） */
  token: string;
  /** リクエストボディ。background が JSON.stringify する。body 不要なら null */
  body: unknown;
}

/**
 * background から content-script / popup へ返す fetch 結果。
 *
 * 成功 (ok: true) でも HTTP ステータスは含む（4xx / 5xx の判定はクライアント側）。
 * 失敗 (ok: false) は HTTP レイヤー手前のエラー:
 * - 'network':       fetch が throw（DNS / TLS / オフライン / CORS 失敗等）
 * - 'invalid-origin': apiUrl が ALLOWED_API_ORIGINS にない（改ざん検出）
 * - 'invalid-request': リクエスト形式が不正（型ガード失敗、サーバーには送らない）
 */
export type BackgroundFetchResponse =
  | { ok: true; status: number; json: unknown }
  | {
      ok: false;
      kind: 'network' | 'invalid-origin' | 'invalid-request';
      message: string;
    };
