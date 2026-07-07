/**
 * AR-1 transcript endpoint への投入（AR-2）。
 *
 * POST /v1/stream-context/transcript（x-fck-admin-token）。fetch を注入可能にして
 * 単体テストで実通信を避ける。
 */

import type { Segment } from './segments.js';

/** 投入結果。endpoint の { accepted, buckets } をそのまま。 */
export interface IngestResult {
  accepted: number;
  buckets: number;
}

export interface IngestOptions {
  apiBase: string;
  adminToken: string;
  videoId: string;
  segments: Segment[];
  /** テスト用 fetch 注入（既定 global fetch）。 */
  fetchImpl?: typeof fetch;
}

/**
 * segment を AR-1 endpoint に POST する。
 * 非 2xx / ネットワーク失敗は理由付きで throw する（呼び出し側が扱う）。
 */
export async function postTranscript(opts: IngestOptions): Promise<IngestResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.apiBase.replace(/\/+$/, '')}/v1/stream-context/transcript`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-fck-admin-token': opts.adminToken,
      },
      body: JSON.stringify({ videoId: opts.videoId, segments: opts.segments }),
    });
  } catch (err) {
    throw new Error(`transcript POST network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`transcript POST HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as Partial<IngestResult>;
  return { accepted: json.accepted ?? opts.segments.length, buckets: json.buckets ?? 0 };
}
