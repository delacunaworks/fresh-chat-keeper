/**
 * POST /v1/revoke の統合テスト。
 *
 * 検証範囲:
 * - 200（revoke 成功）
 * - 200（既に revoked / 一度も consent していない、idempotent）
 * - 401（token なし）
 * - x-fck-token がハッシュ化されてから DB に渡される
 *
 * D1 / KV モックは ingest.test.ts と同じ構造で軽量化。
 */

import { describe, it, expect } from 'vitest';
import workerModule from '../src/index.js';

const VALID_TOKEN = '11111111-2222-4333-8444-555555555555';

interface FakeRunCall {
  sql: string;
  params: unknown[];
}

function createMockD1WithRunRecorder(): {
  db: D1Database;
  runs: FakeRunCall[];
  setDeleteChanges: (n: number) => void;
} {
  const runs: FakeRunCall[] = [];
  let deleteChanges = 0;

  const prepare = (sql: string): D1PreparedStatement => {
    let boundParams: unknown[] = [];
    const stmt = {
      bind: (...args: unknown[]) => {
        boundParams = args;
        return stmt;
      },
      first: async () => null,
      run: async () => {
        runs.push({ sql, params: boundParams });
        const isDelete = sql.toUpperCase().includes('DELETE FROM JUDGMENT_LOGS');
        return {
          success: true,
          meta: {
            changes: isDelete ? deleteChanges : 0,
            last_row_id: 0,
            duration: 0,
            rows_read: 0,
            rows_written: isDelete ? deleteChanges : 0,
            size_after: 0,
          },
          results: [],
        } as unknown as D1Response;
      },
      all: async () => ({ results: [], success: true, meta: {} }) as unknown as D1Result,
      raw: async () => [] as unknown as never[],
    } as unknown as D1PreparedStatement;
    return stmt;
  };

  return {
    db: {
      prepare,
      batch: async () => [],
      dump: async () => new ArrayBuffer(0),
      exec: async () => ({ count: 0, duration: 0 }) as D1ExecResult,
    } as unknown as D1Database,
    runs,
    setDeleteChanges: (n) => {
      deleteChanges = n;
    },
  };
}

function createMockKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv: KVNamespace = {
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

function buildEnv() {
  const d1 = createMockD1WithRunRecorder();
  const consentKv = createMockKV();
  const rateLimitKv = createMockKV();
  return {
    env: {
      COLLECTION_DB: d1.db,
      RATE_LIMIT_KV: rateLimitKv.kv,
      CONSENT_KV: consentKv.kv,
      COLLECTION_SALT: 'test-salt',
    },
    d1,
  };
}

function buildRevokeRequest(opts: { token?: string | null; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '127.0.0.1',
  };
  if (opts.token !== null) {
    headers['x-fck-token'] = opts.token ?? VALID_TOKEN;
  }
  return new Request('http://localhost/v1/revoke', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
}

describe('POST /v1/revoke', () => {
  it('200: revoke 成功（既存ログがある場合、削除件数が返る）', async () => {
    const { env, d1 } = buildEnv();
    d1.setDeleteChanges(7);

    const res = await workerModule.fetch(buildRevokeRequest(), env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean; deletedLogCount: number | null };
    expect(body.revoked).toBe(true);
    expect(body.deletedLogCount).toBe(7);

    // SQL 呼び出しが UPDATE consent_records と DELETE FROM judgment_logs の両方で発生
    const updateCall = d1.runs.find((r) => r.sql.toUpperCase().includes('UPDATE CONSENT_RECORDS'));
    const deleteCall = d1.runs.find((r) => r.sql.toUpperCase().includes('DELETE FROM JUDGMENT_LOGS'));
    expect(updateCall).toBeDefined();
    expect(deleteCall).toBeDefined();

    // x-fck-token がハッシュ化されてから DB に渡されること（平文の VALID_TOKEN そのものではない）
    const tokenInUpdate = updateCall!.params.find((p) => typeof p === 'string' && p !== VALID_TOKEN);
    expect(tokenInUpdate).toBeDefined();
    expect(typeof tokenInUpdate).toBe('string');
    expect(tokenInUpdate as string).toMatch(/^[0-9a-f]{40}$/);
    expect(tokenInUpdate).not.toBe(VALID_TOKEN);
  });

  it('200: 該当ユーザーのログが 0 件でも idempotent に成功する（既に revoked）', async () => {
    const { env, d1 } = buildEnv();
    d1.setDeleteChanges(0);

    const res = await workerModule.fetch(buildRevokeRequest(), env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean; deletedLogCount: number | null };
    expect(body.revoked).toBe(true);
    expect(body.deletedLogCount).toBe(0);
  });

  it('200: body が空でも受け付ける（reason は optional）', async () => {
    const { env, d1 } = buildEnv();
    d1.setDeleteChanges(0);

    const req = new Request('http://localhost/v1/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
        'x-fck-token': VALID_TOKEN,
      },
      // 空 body
      body: '',
    });
    const res = await workerModule.fetch(req, env as never);
    expect(res.status).toBe(200);
  });

  it('401: x-fck-token なし', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(buildRevokeRequest({ token: null }), env as never);
    expect(res.status).toBe(401);
  });

  it('401: x-fck-token 形式不正', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(
      buildRevokeRequest({ token: 'not-a-uuid' }),
      env as never,
    );
    expect(res.status).toBe(401);
  });
});
