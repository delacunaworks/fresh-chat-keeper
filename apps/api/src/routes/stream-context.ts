/**
 * stream-context endpoint（Phase 7 / P7-B3）。
 *
 * - POST /v1/stream-context/captions
 *     body: { videoId, segments: [{ text, t }] }
 *     文字起こし segment を video_id 単位の StreamContextDO に蓄積する。
 *     middleware: rate-limit + token-check（cors は app の /v1/* で適用済み）。
 *
 * - GET  /v1/stream-context/summary?videoId=...
 *     該当 DO の getRecentSummary() を返す（{ whole?, recent?, verbatim? }）。
 *     middleware: rate-limit のみ。token-check は **あえて付けない** —— 判定
 *     Worker（proxy）が P7-B5 で Service Binding 経由に引く際、x-fck-token を
 *     持たない呼び出しになるため。読み出し認可の本格設計は P7-B5 / プライバシー
 *     対応（§6）で行う。現状は rate-limit で最低限のレート保護のみ。
 *
 * **入力は文字起こしテキスト segment（当面 DOM 字幕）**。scribe / 音声取得は
 * 呼ばない（P7-B3.5）。
 *
 * @see dev-docs/phase-7-asr-audio-context.md §2, §5, §7（P7-B3）
 */

import { Hono } from 'hono';
import type { Env } from '../env.js';
import { tokenCheckMiddleware } from '../middleware/token-check.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import type { CaptionSegment } from '../stream-context/stream-context-do.js';

/** 1 リクエストあたりの最大 segment 件数。 */
const MAX_SEGMENTS_PER_REQUEST = 200;
/** segment テキストの最大文字数。 */
const MAX_SEGMENT_TEXT_LENGTH = 1000;
/** videoId の形式（YouTube ID 互換 + 余裕。英数 / `_` / `-`、1〜64 文字）。 */
const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

// ─── AR-1: アーカイブ transcript 一括取り込み ─────────────────────
/** transcript 1 リクエストの最大 segment 件数（VOD 全量前提で大きめ）。 */
const MAX_TRANSCRIPT_SEGMENTS = 100_000;
/** transcript segment テキストの最大文字数。 */
const MAX_TRANSCRIPT_TEXT_LENGTH = 2000;
/** 管理者トークンを提示するヘッダ（一般 x-fck-token とは別物）。 */
const ADMIN_TOKEN_HEADER = 'x-fck-admin-token';

export const streamContextRouter = new Hono<{
  Bindings: Env;
  Variables: { rawToken: string };
}>();

// ─── POST /v1/stream-context/captions ───────────────────────────
streamContextRouter.post(
  '/stream-context/captions',
  rateLimitMiddleware,
  tokenCheckMiddleware,
  async (c) => {
    let body: { videoId?: unknown; segments?: unknown };
    try {
      body = (await c.req.json()) as { videoId?: unknown; segments?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const videoId = body.videoId;
    if (typeof videoId !== 'string' || !VIDEO_ID_REGEX.test(videoId)) {
      return c.json({ error: 'videoId is required and must match [A-Za-z0-9_-]{1,64}' }, 400);
    }

    const segmentsErr = validateSegments(body.segments);
    if (segmentsErr) {
      return c.json({ error: segmentsErr }, 400);
    }
    const segments = body.segments as CaptionSegment[];

    // video_id を name にした singleton DO へルーティングして蓄積を委譲。
    const stub = c.env.STREAM_CONTEXT_DO.get(c.env.STREAM_CONTEXT_DO.idFromName(videoId));
    const res = await stub.fetch('https://stream-context-do/append', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments }),
    });

    if (!res.ok) {
      console.error(`[fck-api] StreamContextDO append failed: ${res.status}`);
      return c.json({ error: 'failed to append captions' }, 502);
    }

    return c.json({ accepted: segments.length }, 200);
  },
);

// ─── GET /v1/stream-context/summary ─────────────────────────────
streamContextRouter.get('/stream-context/summary', rateLimitMiddleware, async (c) => {
  const videoId = c.req.query('videoId');
  if (typeof videoId !== 'string' || !VIDEO_ID_REGEX.test(videoId)) {
    return c.json({ error: 'videoId query param is required and must match [A-Za-z0-9_-]{1,64}' }, 400);
  }

  // AR-1: optional t（視聴者の再生時刻・秒）。あれば transcript の時刻指定取得、
  // 無ければ従来の live rolling（後方互換）。不正値は 400。
  const tRaw = c.req.query('t');
  let tQuery = '';
  if (tRaw !== undefined) {
    const t = Number(tRaw);
    if (!Number.isFinite(t) || t < 0) {
      return c.json({ error: 't must be a non-negative finite number (seconds)' }, 400);
    }
    tQuery = `?t=${t}`;
  }

  const stub = c.env.STREAM_CONTEXT_DO.get(c.env.STREAM_CONTEXT_DO.idFromName(videoId));
  const res = await stub.fetch(`https://stream-context-do/summary${tQuery}`, { method: 'GET' });

  if (!res.ok) {
    console.error(`[fck-api] StreamContextDO summary failed: ${res.status}`);
    return c.json({ error: 'failed to read summary' }, 502);
  }

  const summary = await res.json();
  return c.json(summary, 200);
});

// ─── POST /v1/stream-context/transcript（AR-1・管理者専用）───────
// アーカイブ VOD の全量 transcript を一括取り込みする。運営 CLI（AR-2）だけが
// x-fck-admin-token で叩く。一般ユーザーの x-fck-token では通らない。
streamContextRouter.post('/stream-context/transcript', async (c) => {
  // 管理者トークン検証（定数時間比較）。未設定は誤デプロイなので 500。
  const expected = c.env.ADMIN_INGEST_TOKEN;
  if (typeof expected !== 'string' || expected.length === 0) {
    console.error('[fck-api] ADMIN_INGEST_TOKEN is not configured');
    return c.json({ error: 'Server misconfiguration' }, 500);
  }
  const provided = c.req.header(ADMIN_TOKEN_HEADER);
  if (typeof provided !== 'string' || !timingSafeEqual(provided, expected)) {
    return c.json({ error: 'Invalid or missing admin token' }, 401);
  }

  let body: { videoId?: unknown; segments?: unknown };
  try {
    body = (await c.req.json()) as { videoId?: unknown; segments?: unknown };
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const videoId = body.videoId;
  if (typeof videoId !== 'string' || !VIDEO_ID_REGEX.test(videoId)) {
    return c.json({ error: 'videoId is required and must match [A-Za-z0-9_-]{1,64}' }, 400);
  }

  const err = validateTranscriptSegments(body.segments);
  if (err) return c.json({ error: err }, 400);
  const segments = body.segments as CaptionSegment[];

  const stub = c.env.STREAM_CONTEXT_DO.get(c.env.STREAM_CONTEXT_DO.idFromName(videoId));
  const res = await stub.fetch('https://stream-context-do/ingest-transcript', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments }),
  });
  if (!res.ok) {
    console.error(`[fck-api] StreamContextDO ingest-transcript failed: ${res.status}`);
    return c.json({ error: 'failed to ingest transcript' }, 502);
  }
  const result = (await res.json()) as { accepted?: number; buckets?: number };
  return c.json({ accepted: result.accepted ?? segments.length, buckets: result.buckets ?? 0 }, 200);
});

// ─── バリデーション ───────────────────────────────────────────

/** segments 配列を検証する。問題なければ null、あればエラーメッセージ。 */
function validateSegments(segments: unknown): string | null {
  if (!Array.isArray(segments)) return 'segments must be an array';
  if (segments.length === 0) return 'segments must not be empty';
  if (segments.length > MAX_SEGMENTS_PER_REQUEST) {
    return `segments must not exceed ${MAX_SEGMENTS_PER_REQUEST} items per request`;
  }
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (typeof s !== 'object' || s === null) return `segments[${i}] must be an object`;
    const seg = s as Partial<CaptionSegment>;
    if (typeof seg.text !== 'string') return `segments[${i}].text must be a string`;
    if (seg.text.length > MAX_SEGMENT_TEXT_LENGTH) {
      return `segments[${i}].text exceeds ${MAX_SEGMENT_TEXT_LENGTH} characters`;
    }
    if (typeof seg.t !== 'number' || !Number.isFinite(seg.t) || seg.t < 0) {
      return `segments[${i}].t must be a finite number >= 0`;
    }
  }
  return null;
}

/** transcript segments 配列を検証する（問題なければ null）。 */
function validateTranscriptSegments(segments: unknown): string | null {
  if (!Array.isArray(segments)) return 'segments must be an array';
  if (segments.length === 0) return 'segments must not be empty';
  if (segments.length > MAX_TRANSCRIPT_SEGMENTS) {
    return `segments must not exceed ${MAX_TRANSCRIPT_SEGMENTS} items`;
  }
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (typeof s !== 'object' || s === null) return `segments[${i}] must be an object`;
    const seg = s as Partial<CaptionSegment>;
    if (typeof seg.text !== 'string') return `segments[${i}].text must be a string`;
    if (seg.text.length > MAX_TRANSCRIPT_TEXT_LENGTH) {
      return `segments[${i}].text exceeds ${MAX_TRANSCRIPT_TEXT_LENGTH} characters`;
    }
    if (typeof seg.t !== 'number' || !Number.isFinite(seg.t) || seg.t < 0) {
      return `segments[${i}].t must be a finite number >= 0`;
    }
  }
  return null;
}

/**
 * 定数時間文字列比較（管理者トークンのタイミング攻撃対策）。
 * 長さが異なれば false。長さが同じなら全文字を XOR して差分の有無を集計する。
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─── テスト用エクスポート ─────────────────────────────────────
export const __test__ = {
  MAX_SEGMENTS_PER_REQUEST,
  MAX_SEGMENT_TEXT_LENGTH,
  MAX_TRANSCRIPT_SEGMENTS,
  MAX_TRANSCRIPT_TEXT_LENGTH,
  ADMIN_TOKEN_HEADER,
  VIDEO_ID_REGEX,
  validateSegments,
  validateTranscriptSegments,
  timingSafeEqual,
};
