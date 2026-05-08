/**
 * /v1/ingest 用 IP ベースレート制限 middleware。
 *
 * 設計:
 * - apps/proxy のレート制限と同一構造（KV カウンタ + 1 分窓）だが、別 namespace
 *   （RATE_LIMIT_KV）を使うため互いに干渉しない
 * - **fail-open**: KV 障害時は warn ログを残してリクエストを通す
 *   （HARD-01 と整合。データ収集は best-effort のため、KV 一時障害で
 *   全 opt-in ユーザーがリトライ嵐に陥るより、レート制限が瞬間的に無効化
 *   される方が望ましい）
 * - レート制限超過時は 429 + `Retry-After` ヘッダ
 *
 * 上限: 設計書 §5.4 では「10req/min/IP」と暫定。Phase 2.5 で 30/min と
 * しているのは、ingestion がバッチ送信前提で 1 リクエスト最大 50 件のため、
 * 通常運用なら IP 当たり 10/min で十分カバーできるが、誤判定報告ボタンを
 * 連打する正当ユースケースを潰さないように apps/proxy（30/min）と同等にした。
 *
 * @see dev-docs/phase-2-5-data-collection.md §5.4
 */

import { createMiddleware } from 'hono/factory';
import type { Env } from '../env.js';

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export const rateLimitMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
    const allowed = await checkIngestRateLimit(ip, c.env.RATE_LIMIT_KV);
    if (!allowed) {
      return c.json(
        { error: 'Rate limit exceeded. Max 30 requests per minute.' },
        429,
        { 'Retry-After': String(RATE_LIMIT_WINDOW_SECONDS) },
      );
    }
    await next();
  },
);

/**
 * 1 リクエストごとに current+1 を atomically に評価して上限超過なら拒否する。
 *
 * KV の `get` → `put` には atomic な incr 操作がないため、最大値付近で
 * 競合が発生すると一瞬上限を超えるリクエストが通る可能性がある（apps/proxy
 * と同じ既知制限）。Phase 2.5 のデータ収集では DOS 防御が主目的で、precise
 * な上限は不要なため許容する。
 */
export async function checkIngestRateLimit(
  ip: string,
  kv: KVNamespace,
): Promise<boolean> {
  try {
    const windowKey = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
    const key = `ingest-rl:${ip}:${windowKey}`;

    const current = await kv.get(key);
    // KV に壊れた値（'NaN' / '' / 'abc'）が入っていても 0 として扱い、
    // parseInt の NaN 戻りで上限チェックが false になって rate limit が
    // 無効化される事故を防ぐ。Number.isFinite で 0 へフォールバック。
    const parsed = current !== null ? parseInt(current, 10) : 0;
    const count = Number.isFinite(parsed) ? parsed : 0;

    if (count >= RATE_LIMIT_MAX) {
      return false;
    }

    await kv.put(key, String(count + 1), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2,
    });
    return true;
  } catch (err) {
    // fail-open: ログだけ残してリクエストを通す（apps/proxy HARD-01 と同方針）
    console.warn(
      `[fck-api] KV rate limit error (failing open): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return true;
  }
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_SECONDS,
  checkIngestRateLimit,
};
