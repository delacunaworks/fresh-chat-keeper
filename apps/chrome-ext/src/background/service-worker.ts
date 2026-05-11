/**
 * バックグラウンド Service Worker（Manifest V3）
 *
 * 役割:
 * - 拡張インストール / 起動時のワンショット処理（旧名時代の orphan キー削除等）
 * - **BACKGROUND-01 (Phase 2.5)**: content-script / popup からの fetch を中継。
 *   chrome-extension:// origin で fetch を発火することで、apps/api 側の
 *   ALLOWED_ORIGINS を chrome-extension のみに保てる（本番 security 要件）。
 *
 * 注: content script や popup から呼ぶと多重実行になるため、起動系の処理は
 * すべて service worker 側で完結させる。
 */

import { cleanupLegacyPrefixKeys } from '../shared/settings-loader.js';
import type {
  BackgroundFetchRequest,
  BackgroundFetchResponse,
  BgFetchEndpoint,
} from '@fresh-chat-keeper/shared';

// ─── 起動系（テスト環境では skip）──────────────────────────────

// テスト環境（vitest）では `chrome` グローバルが存在しないため、guard で skip。
// 本番では service worker 起動時に必ず chrome.runtime が存在するため、
// この分岐は production runtime に影響しない。
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onInstalled.addListener(() => {
    // 旧名拡張時代の `flc_*` プレフィックスキーを削除（存在しなければ no-op）
    void cleanupLegacyPrefixKeys();
  });

  chrome.runtime.onStartup.addListener(() => {
    // ブラウザ再起動時にも実行（onInstalled は更新時のみ）
    void cleanupLegacyPrefixKeys();
  });
}

// ─── BACKGROUND-01: fetch プロキシ ─────────────────────────────

/**
 * apps/api への fetch を許可する origin のホワイトリスト（ハードコード）。
 *
 * collection-client.ts の `ALLOWED_API_ORIGINS` と一致させること。改ざん耐性
 * のため env から読まずソースコードで固定する。ユーザーが chrome.storage の
 * collectionApiUrl を手動で書き換えても、このリストにない origin にはリクエストを
 * 送らない（fail-closed）。
 *
 * - 本番: fresh-chat-keeper-api.playnicelab.workers.dev
 * - 開発: localhost / 127.0.0.1:8788（wrangler dev、apps/api/package.json で port 固定）
 */
const ALLOWED_API_ORIGINS: readonly string[] = [
  'https://fresh-chat-keeper-api.playnicelab.workers.dev',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
];

/**
 * BgFetchEndpoint → URL パスのマッピング。許可されていない値はビルド時に弾かれる。
 */
const ENDPOINT_PATHS: Record<BgFetchEndpoint, string> = {
  ingest: '/v1/ingest',
  consent: '/v1/consent',
  revoke: '/v1/revoke',
};

const VALID_ENDPOINTS = new Set<BgFetchEndpoint>(['ingest', 'consent', 'revoke']);

/**
 * 文字列が apps/api の許可 origin かを判定する。
 * unknown / malformed URL は false を返し、呼び出し側 (handleBgFetch) が
 * 'invalid-origin' で返却する。
 */
export function isAllowedApiOrigin(apiUrl: string): boolean {
  try {
    const origin = new URL(apiUrl).origin;
    return ALLOWED_API_ORIGINS.includes(origin);
  } catch {
    return false;
  }
}

/**
 * BackgroundFetchRequest の型ガード。msg が想定外の構造なら false。
 *
 * `chrome.runtime.onMessage` は他の chrome.runtime メッセージ
 * （例: 'fck:consent-refresh-required'）も受信するため、
 * `msg.type === 'fck:bg-fetch'` で確実にフィルタする。
 */
function isBackgroundFetchRequest(msg: unknown): msg is BackgroundFetchRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Partial<BackgroundFetchRequest>;
  if (m.type !== 'fck:bg-fetch') return false;
  if (typeof m.endpoint !== 'string' || !VALID_ENDPOINTS.has(m.endpoint as BgFetchEndpoint)) {
    return false;
  }
  if (typeof m.apiUrl !== 'string' || m.apiUrl.length === 0) return false;
  if (typeof m.token !== 'string' || m.token.length === 0) return false;
  // body は unknown（null も許可）。型ガード対象外
  return true;
}

/**
 * 1 回の fetch を実行して BackgroundFetchResponse を組み立てる。
 *
 * - apiUrl の origin が ALLOWED_API_ORIGINS にない → invalid-origin
 * - fetch が throw（DNS / TLS / ネットワーク） → network
 * - HTTP レスポンス受領 → ok: true（body の JSON parse 失敗時は json: null）
 *
 * 注: fetch は chrome-extension:// origin で発火するため、apps/api の
 * ALLOWED_ORIGINS には extension ID が必要（CORS 通過用）。
 */
export async function handleBgFetch(
  req: BackgroundFetchRequest,
): Promise<BackgroundFetchResponse> {
  if (!isAllowedApiOrigin(req.apiUrl)) {
    return {
      ok: false,
      kind: 'invalid-origin',
      message: `apiUrl origin not in allowlist`,
    };
  }

  const url = `${req.apiUrl}${ENDPOINT_PATHS[req.endpoint]}`;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'x-fck-token': req.token,
  };
  // body: null/undefined の場合は空オブジェクトを送る（既存 collection-client と同等）
  const body = JSON.stringify(req.body ?? {});

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body });
  } catch (err) {
    return {
      ok: false,
      kind: 'network',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // body を JSON として解釈。失敗時は null を返却（呼び出し側で許容）。
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  return { ok: true, status: res.status, json };
}

// メッセージリスナー登録（テスト環境では skip）
// MV3 service worker では sendResponse を非同期で呼ぶ場合 listener が true を
// 返す必要がある。返さないと sendResponse が無効化される。
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isBackgroundFetchRequest(message)) {
      // 他の type のメッセージ（例: fck:consent-refresh-required）には介入しない。
      // false を返すと chrome.runtime は他の listener に処理を委ねる。
      return false;
    }

    // Promise を返さず、sendResponse を非同期コールバックで呼ぶ MV3 パターン。
    // 例外発生時も BackgroundFetchResponse の形式に正規化して返す。
    void handleBgFetch(message)
      .then(sendResponse)
      .catch((err: unknown) => {
        sendResponse({
          ok: false,
          kind: 'network',
          message: err instanceof Error ? err.message : String(err),
        } satisfies BackgroundFetchResponse);
      });

    // 非同期で sendResponse を呼ぶことを宣言
    return true;
  });
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = {
  ALLOWED_API_ORIGINS,
  ENDPOINT_PATHS,
  isBackgroundFetchRequest,
};
