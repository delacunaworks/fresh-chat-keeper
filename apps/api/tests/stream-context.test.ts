/**
 * stream-context endpoint の統合テスト（P7-B3）。
 *
 * 戦略（既存 ingest.test.ts に準拠）:
 * - workerModule.fetch を直接呼ぶ。
 * - RATE_LIMIT_KV はインメモリモック。
 * - STREAM_CONTEXT_DO は「name ごとに実 StreamContextDO（モック state）を保持し、
 *   stub.fetch で実インスタンスにルーティングする」モック namespace。
 *   → endpoint → DO.fetch → メソッド の全経路を実際に通す。
 *
 * 検証:
 * - POST /v1/stream-context/captions: 200 / 401(token) / 400(body・videoId) / 429(rate)
 * - GET  /v1/stream-context/summary: 200（蓄積反映）/ 400（videoId 欠損）
 * - video_id 単位の singleton ルーティング（同 id は同 DO）
 */

import { describe, it, expect } from 'vitest';
import workerModule from '../src/index.js';
import { StreamContextDO } from '../src/stream-context/stream-context-do.js';

const VALID_TOKEN = '11111111-2222-4333-8444-555555555555';

// ─── モック ─────────────────────────────────────────────────────

function createMockKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
  return { kv, store };
}

/** DO state（Map ベース storage）モック。 */
function createMockState(): DurableObjectState {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => store.delete(key),
    getAlarm: async (): Promise<number | null> => alarm,
    setAlarm: async (t: number | Date): Promise<void> => {
      alarm = typeof t === 'number' ? t : t.getTime();
    },
    deleteAlarm: async (): Promise<void> => {
      alarm = null;
    },
  };
  return { storage } as unknown as DurableObjectState;
}

/** name ごとに実 StreamContextDO を保持する DO namespace モック。 */
function createMockDONamespace(): {
  namespace: DurableObjectNamespace;
  instances: Map<string, StreamContextDO>;
} {
  const instances = new Map<string, StreamContextDO>();

  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = (id as unknown as { name: string }).name;
      let inst = instances.get(name);
      if (!inst) {
        inst = new StreamContextDO(createMockState(), {} as never);
        instances.set(name, inst);
      }
      const instance = inst;
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          instance.fetch(new Request(input as RequestInfo, init)),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  return { namespace, instances };
}

function buildEnv(opts: { rateLimitFails?: boolean } = {}) {
  const rateLimitKv = createMockKV();
  if (opts.rateLimitFails) {
    const windowKey = Math.floor(Date.now() / 60000);
    rateLimitKv.store.set(`ingest-rl:127.0.0.1:${windowKey}`, '999');
  }
  const { namespace, instances } = createMockDONamespace();
  return {
    env: {
      COLLECTION_DB: {} as unknown as D1Database,
      RATE_LIMIT_KV: rateLimitKv.kv,
      CONSENT_KV: createMockKV().kv,
      COLLECTION_SALT: 'test-salt-must-be-long-enough',
      ELEVENLABS_API_KEY: '',
      STREAM_CONTEXT_DO: namespace,
      ALLOWED_ORIGINS: 'http://localhost:8788,chrome-extension://test',
    },
    instances,
  };
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function captionsReq(body: unknown, opts: { token?: string | null } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '127.0.0.1',
  };
  if (opts.token !== null) headers['x-fck-token'] = opts.token ?? VALID_TOKEN;
  return new Request('http://localhost/v1/stream-context/captions', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function summaryReq(videoId: string | null): Request {
  const url =
    videoId === null
      ? 'http://localhost/v1/stream-context/summary'
      : `http://localhost/v1/stream-context/summary?videoId=${videoId}`;
  return new Request(url, {
    method: 'GET',
    headers: { 'CF-Connecting-IP': '127.0.0.1' },
  });
}

// ─── POST /captions ─────────────────────────────────────────────

describe('POST /v1/stream-context/captions', () => {
  it('200: 正常蓄積で accepted を返す', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(
      captionsReq({ videoId: 'dQw4w9WgXcQ', segments: [{ text: 'やあ', t: 1 }] }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });
  });

  it('401: token なしは弾く', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(
      captionsReq({ videoId: 'dQw4w9WgXcQ', segments: [{ text: 'x', t: 0 }] }, { token: null }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it('400: videoId 欠損', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(
      captionsReq({ segments: [{ text: 'x', t: 0 }] }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('400: videoId 形式不正', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(
      captionsReq({ videoId: 'bad id with spaces', segments: [{ text: 'x', t: 0 }] }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('400: segments が空', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(
      captionsReq({ videoId: 'vid12345', segments: [] }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('400: segment.t が負', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(
      captionsReq({ videoId: 'vid12345', segments: [{ text: 'x', t: -1 }] }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('400: 不正 JSON body', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(captionsReq('{not json'), env, ctx);
    expect(res.status).toBe(400);
  });

  it('429: rate limit 超過', async () => {
    const { env } = buildEnv({ rateLimitFails: true });
    const res = await workerModule.fetch(
      captionsReq({ videoId: 'vid12345', segments: [{ text: 'x', t: 0 }] }),
      env,
      ctx,
    );
    expect(res.status).toBe(429);
  });
});

// ─── GET /summary ───────────────────────────────────────────────

describe('GET /v1/stream-context/summary', () => {
  it('200: 蓄積した verbatim が返る（同 videoId の singleton）', async () => {
    const { env } = buildEnv();
    await workerModule.fetch(
      captionsReq({ videoId: 'sharedVid', segments: [{ text: 'ほのお', t: 10 }] }),
      env,
      ctx,
    );
    const res = await workerModule.fetch(summaryReq('sharedVid'), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verbatim: 'ほのお' });
  });

  it('200: 未蓄積 videoId は空サマリ', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(summaryReq('emptyVid'), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('400: videoId クエリ欠損', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(summaryReq(null), env, ctx);
    expect(res.status).toBe(400);
  });

  it('token を要求しない（Service Binding 連携の余地・P7-B5）', async () => {
    const { env } = buildEnv();
    // x-fck-token を付けずに 200 が返ること
    const res = await workerModule.fetch(summaryReq('noTokenVid'), env, ctx);
    expect(res.status).toBe(200);
  });
});
