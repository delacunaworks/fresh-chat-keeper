/**
 * AR-1: POST /v1/stream-context/transcript（管理者専用）と
 * GET /v1/stream-context/summary?t= の統合テスト。
 *
 * 戦略（既存 stream-context.test.ts 準拠）: workerModule.fetch を直接呼び、
 * STREAM_CONTEXT_DO は name ごとに実 StreamContextDO（モック state）へルーティング
 * するモック namespace。実 LLM 通信はしない（要約 alarm は endpoint 経由では発火しない）。
 */

import { describe, it, expect } from 'vitest';
import workerModule from '../src/index.js';
import { StreamContextDO } from '../src/stream-context/stream-context-do.js';

const ADMIN_TOKEN = 'admin-secret-token-xyz';
const USER_TOKEN = '11111111-2222-4333-8444-555555555555';

// ─── モック ─────────────────────────────────────────────────────

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

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

function createMockDONamespace(): DurableObjectNamespace {
  const instances = new Map<string, StreamContextDO>();
  return {
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
}

function buildEnv(opts: { adminToken?: string } = {}) {
  return {
    COLLECTION_DB: {} as unknown as D1Database,
    RATE_LIMIT_KV: createMockKV(),
    CONSENT_KV: createMockKV(),
    COLLECTION_SALT: 'test-salt-must-be-long-enough',
    ELEVENLABS_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ADMIN_INGEST_TOKEN: opts.adminToken === undefined ? ADMIN_TOKEN : opts.adminToken,
    STREAM_CONTEXT_DO: createMockDONamespace(),
    ALLOWED_ORIGINS: 'http://localhost:8788,chrome-extension://test',
  } as never;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function transcriptReq(
  body: unknown,
  opts: { adminToken?: string | null; userToken?: string } = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '127.0.0.1',
  };
  if (opts.adminToken !== null && opts.adminToken !== undefined) {
    headers['x-fck-admin-token'] = opts.adminToken;
  }
  if (opts.userToken) headers['x-fck-token'] = opts.userToken;
  return new Request('http://localhost/v1/stream-context/transcript', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID_BODY = {
  videoId: 'archiveVid1',
  segments: [
    { t: 0, text: 'オープニング' },
    { t: 605, text: '第一章' },
  ],
};

// ─── admin 認可 ─────────────────────────────────────────────────

describe('POST /v1/stream-context/transcript — 認可', () => {
  it('200: 正しい admin トークン', async () => {
    const res = await workerModule.fetch(
      transcriptReq(VALID_BODY, { adminToken: ADMIN_TOKEN }),
      buildEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2, buckets: 2 });
  });

  it('401: admin トークンなし', async () => {
    const res = await workerModule.fetch(
      transcriptReq(VALID_BODY, { adminToken: null }),
      buildEnv(),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it('401: admin トークン不一致', async () => {
    const res = await workerModule.fetch(
      transcriptReq(VALID_BODY, { adminToken: 'wrong-token' }),
      buildEnv(),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it('401: x-fck-token（一般ユーザートークン）では通らない', async () => {
    const res = await workerModule.fetch(
      transcriptReq(VALID_BODY, { adminToken: null, userToken: USER_TOKEN }),
      buildEnv(),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it('500: ADMIN_INGEST_TOKEN 未設定（誤デプロイ）', async () => {
    const res = await workerModule.fetch(
      transcriptReq(VALID_BODY, { adminToken: ADMIN_TOKEN }),
      buildEnv({ adminToken: '' }),
      ctx,
    );
    expect(res.status).toBe(500);
  });
});

// ─── body 検証 ──────────────────────────────────────────────────

describe('POST /v1/stream-context/transcript — 検証', () => {
  it('400: videoId 不正', async () => {
    const res = await workerModule.fetch(
      transcriptReq({ videoId: 'bad id', segments: [{ t: 0, text: 'x' }] }, { adminToken: ADMIN_TOKEN }),
      buildEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('400: segments 空', async () => {
    const res = await workerModule.fetch(
      transcriptReq({ videoId: 'vid1', segments: [] }, { adminToken: ADMIN_TOKEN }),
      buildEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('400: segment.t が負', async () => {
    const res = await workerModule.fetch(
      transcriptReq({ videoId: 'vid1', segments: [{ t: -1, text: 'x' }] }, { adminToken: ADMIN_TOKEN }),
      buildEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('400: 不正 JSON', async () => {
    const res = await workerModule.fetch(
      transcriptReq('{bad', { adminToken: ADMIN_TOKEN }),
      buildEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

// ─── GET summary?t= 時刻指定取得 ───────────────────────────────

describe('GET /v1/stream-context/summary?t= — 時刻指定取得', () => {
  it('transcript 取り込み後、t 指定で verbatim（≤T）が返る', async () => {
    const env = buildEnv();
    // 同一 env（＝同一 DO インスタンス）で ingest → 取得。
    await workerModule.fetch(
      transcriptReq(
        {
          videoId: 'vodX',
          // verbatim 窓は [T-120, T]。T=250 → [130,250]。
          segments: [
            { t: 150, text: 'A150' }, // 窓内
            { t: 200, text: 'B200' }, // 窓内
            { t: 900, text: 'C900' }, // T=250 では未来
          ],
        },
        { adminToken: ADMIN_TOKEN },
      ),
      env,
      ctx,
    );
    const res = await workerModule.fetch(
      new Request('http://localhost/v1/stream-context/summary?videoId=vodX&t=250', {
        headers: { 'CF-Connecting-IP': '127.0.0.1' },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { verbatim?: string };
    expect(summary.verbatim).toContain('A150');
    expect(summary.verbatim).toContain('B200');
    expect(summary.verbatim).not.toContain('C900'); // ★未来を返さない
  });

  it('400: t が不正な値', async () => {
    const res = await workerModule.fetch(
      new Request('http://localhost/v1/stream-context/summary?videoId=vodX&t=abc', {
        headers: { 'CF-Connecting-IP': '127.0.0.1' },
      }),
      buildEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('t なしは live rolling（transcript を返さない・後方互換）', async () => {
    const env = buildEnv();
    await workerModule.fetch(
      transcriptReq({ videoId: 'vodY', segments: [{ t: 100, text: 'archived' }] }, { adminToken: ADMIN_TOKEN }),
      env,
      ctx,
    );
    const res = await workerModule.fetch(
      new Request('http://localhost/v1/stream-context/summary?videoId=vodY', {
        headers: { 'CF-Connecting-IP': '127.0.0.1' },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({}); // transcript は t なしでは出ない
  });
});
