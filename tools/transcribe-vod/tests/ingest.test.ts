import { describe, it, expect, vi } from 'vitest';
import { postTranscript } from '../src/ingest.js';
import type { Segment } from '../src/segments.js';

const SEGMENTS: Segment[] = [
  { t: 0, text: 'a' },
  { t: 20, text: 'b' },
];

describe('postTranscript', () => {
  it('endpoint に x-fck-admin-token 付きで POST し accepted/buckets を返す', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ accepted: 2, buckets: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const result = await postTranscript({
      apiBase: 'https://api.test/',
      adminToken: 'admin-tok',
      videoId: 'vid1',
      segments: SEGMENTS,
      fetchImpl,
    });

    expect(result).toEqual({ accepted: 2, buckets: 1 });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.test/v1/stream-context/transcript'); // 末尾スラッシュ正規化
    expect(init.method).toBe('POST');
    expect(init.headers['x-fck-admin-token']).toBe('admin-tok');
    expect(JSON.parse(init.body)).toEqual({ videoId: 'vid1', segments: SEGMENTS });
  });

  it('非 2xx は理由付きで throw', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      postTranscript({
        apiBase: 'https://api.test',
        adminToken: 'x',
        videoId: 'v',
        segments: SEGMENTS,
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it('ネットワーク失敗（fetch throw）は理由付きで throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(
      postTranscript({
        apiBase: 'https://api.test',
        adminToken: 'x',
        videoId: 'v',
        segments: SEGMENTS,
        fetchImpl,
      }),
    ).rejects.toThrow(/network error/);
  });
});
