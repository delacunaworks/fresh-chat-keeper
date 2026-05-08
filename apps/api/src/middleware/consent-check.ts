/**
 * consentVersion 照合 middleware。
 *
 * 役割:
 * - リクエストボディの `consentVersion` を読む
 * - サーバー側で現在有効なバージョンと一致するか確認
 * - 不一致なら 410 Gone + `currentConsentVersion` を返し、クライアントに
 *   再同意を促す（同意モーダル再表示）
 *
 * パフォーマンス:
 * - 現行バージョンは CONSENT_KV にキャッシュ（TTL 1h）。D1 の
 *   consent_versions テーブルへのアクセスを毎リクエスト発生させない
 * - キャッシュミス時のみ getActiveConsentVersion で D1 を引く
 *
 * 設計上の注意:
 * - 本 middleware は body をパースする必要があるため、token-check の **後**
 *   に走らせる。先に rate-limit / token を通してから body を読み込むことで、
 *   不正なクライアントの DOS 耐性を確保する
 * - body 読み出し後は c.set('parsedBody', body) で次の handler に渡す
 *   （Hono は req.json() を 1 回しか読めないため）
 *
 * @see dev-docs/phase-2-5-data-collection.md §5.4 §6.3
 */

import { createMiddleware } from 'hono/factory';
import type { Env } from '../env.js';
import { getActiveConsentVersion } from '../db/repository.js';

const CONSENT_CACHE_KEY = 'current-consent-version';
const CONSENT_CACHE_TTL_SECONDS = 3600; // 1 hour

export const consentCheckMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { parsedBody: unknown; currentConsentVersion: string };
}>(async (c, next) => {
  // body 読み出し（後段の handler でも parsedBody を再利用）
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof body !== 'object' || body === null) {
    return c.json({ error: 'Body must be a JSON object' }, 400);
  }

  const clientVersion = (body as Record<string, unknown>)['consentVersion'];
  if (typeof clientVersion !== 'string' || clientVersion.length === 0) {
    return c.json({ error: 'consentVersion is required' }, 400);
  }

  // 現行バージョン取得（KV キャッシュ → D1 フォールバック）
  const currentVersion = await getCurrentConsentVersionCached(c.env);
  if (currentVersion === null) {
    // consent_versions が未投入（DEPLOY-01 の初期データ投入前）
    // この状態で ingest が来るのは運用ミスなので 503 で明示的に拒否
    console.error('[fck-api] No active consent version in DB (DEPLOY-01 not run yet?)');
    return c.json({ error: 'Server not ready: no active consent version' }, 503);
  }

  if (clientVersion !== currentVersion) {
    return c.json(
      {
        error: 'consent_version_mismatch',
        currentConsentVersion: currentVersion,
      },
      410,
    );
  }

  c.set('parsedBody', body);
  c.set('currentConsentVersion', currentVersion);
  await next();
});

/**
 * KV キャッシュ経由で現行 consentVersion を取得。
 *
 * KV 障害時は D1 直アクセスにフォールバックする。両方失敗したら null を返し、
 * 呼び出し側で 5xx 扱いとする（fail-closed: 同意検証は安全寄りに倒す）。
 */
export async function getCurrentConsentVersionCached(env: Env): Promise<string | null> {
  // 1. KV キャッシュ
  try {
    const cached = await env.CONSENT_KV.get(CONSENT_CACHE_KEY);
    if (cached !== null) return cached;
  } catch (err) {
    console.warn(
      `[fck-api] CONSENT_KV read failed, falling back to D1: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 2. D1 から取得
  let row: { version: string } | null = null;
  try {
    row = await getActiveConsentVersion(env.COLLECTION_DB);
  } catch (err) {
    console.error(
      `[fck-api] getActiveConsentVersion failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  if (!row) return null;

  // 3. KV にキャッシュ書き戻し（書き込み失敗は無視、次回 D1 を引けばよい）
  try {
    await env.CONSENT_KV.put(CONSENT_CACHE_KEY, row.version, {
      expirationTtl: CONSENT_CACHE_TTL_SECONDS,
    });
  } catch (err) {
    console.warn(
      `[fck-api] CONSENT_KV write failed (ignored): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return row.version;
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = {
  CONSENT_CACHE_KEY,
  CONSENT_CACHE_TTL_SECONDS,
  getCurrentConsentVersionCached,
};
