/**
 * POST /v1/consent の統合テスト。
 *
 * 検証範囲:
 * - 200（新規 INSERT）
 * - 200（既存 token の再同意 = UPSERT）
 * - 422（consentVersion が consent_versions に未登録）
 * - 422（consentVersion 欠落）
 * - 401（token なし）
 */

import { describe, it, expect } from 'vitest';
import workerModule from '../src/index.js';

const VALID_TOKEN = '11111111-2222-4333-8444-555555555555';

interface RecordedStmt {
  sql: string;
  params: unknown[];
}

function createMockD1(opts: {
  knownVersions?: string[];
} = {}): { db: D1Database; stmts: RecordedStmt[] } {
  const stmts: RecordedStmt[] = [];
  const known = new Set(opts.knownVersions ?? ['2026-05-01']);

  const prepare = (sql: string): D1PreparedStatement => {
    let boundParams: unknown[] = [];
    const upper = sql.trim().toUpperCase();

    const stmt = {
      bind: (...args: unknown[]) => {
        boundParams = args;
        return stmt;
      },
      first: async <T = unknown>(): Promise<T | null> => {
        if (upper.includes('FROM CONSENT_VERSIONS WHERE VERSION')) {
          const v = String(boundParams[0]);
          stmts.push({ sql, params: boundParams });
          return known.has(v) ? ({ version: v } as unknown as T) : null;
        }
        return null;
      },
      run: async () => {
        stmts.push({ sql, params: boundParams });
        return { success: true, meta: { changes: 1 }, results: [] } as unknown as D1Response;
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
    stmts,
  };
}

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function buildEnv(opts: { knownVersions?: string[] } = {}) {
  const d1 = createMockD1({ knownVersions: opts.knownVersions });
  return {
    env: {
      COLLECTION_DB: d1.db,
      RATE_LIMIT_KV: createMockKV(),
      CONSENT_KV: createMockKV(),
      COLLECTION_SALT: 'test-salt-must-be-long-enough',
      ALLOWED_ORIGINS: 'http://localhost:8788,chrome-extension://test',
    },
    d1,
  };
}

function buildConsentRequest(body: unknown, opts: { token?: string | null } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '127.0.0.1',
  };
  if (opts.token !== null) {
    headers['x-fck-token'] = opts.token ?? VALID_TOKEN;
  }
  return new Request('http://localhost/v1/consent', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /v1/consent', () => {
  it('200: 新規 INSERT — UPSERT SQL に user_token_hashed と consentVersion が渡る', async () => {
    const { env, d1 } = buildEnv();
    const res = await workerModule.fetch(
      buildConsentRequest({ consentVersion: '2026-05-01' }),
      env as never,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { recorded: boolean; currentConsentVersion: string };
    expect(body.recorded).toBe(true);
    expect(body.currentConsentVersion).toBe('2026-05-01');

    const upsertCall = d1.stmts.find((s) =>
      s.sql.toUpperCase().includes('INSERT INTO CONSENT_RECORDS'),
    );
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.sql.toUpperCase()).toContain('ON CONFLICT');
    // user_token_hashed が SHA-1 hex に変換されていること（平文 token ではない）
    const tokenParam = String(upsertCall!.params[0]);
    expect(tokenParam).toMatch(/^[0-9a-f]{40}$/);
    expect(tokenParam).not.toBe(VALID_TOKEN);
    expect(upsertCall!.params[1]).toBe('2026-05-01');
  });

  it('200: 既存 token が再同意した場合も UPSERT で 200 が返る（idempotent）', async () => {
    // モックは INSERT/UPDATE を区別しないが、ON CONFLICT の SQL が正しく
    // 渡っていることが UPSERT 動作の十分条件。実際の D1 挙動は別テストで確認。
    const { env, d1 } = buildEnv();
    // 1 回目
    await workerModule.fetch(buildConsentRequest({ consentVersion: '2026-05-01' }), env as never);
    // 2 回目（同じ token）
    const res = await workerModule.fetch(
      buildConsentRequest({ consentVersion: '2026-05-01' }),
      env as never,
    );
    expect(res.status).toBe(200);
    const upsertCalls = d1.stmts.filter((s) =>
      s.sql.toUpperCase().includes('INSERT INTO CONSENT_RECORDS'),
    );
    expect(upsertCalls).toHaveLength(2);
  });

  it('422: consentVersion が consent_versions に存在しない', async () => {
    const { env, d1 } = buildEnv({ knownVersions: ['2026-05-01'] });
    const res = await workerModule.fetch(
      buildConsentRequest({ consentVersion: '2099-12-31' }),
      env as never,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('consentVersion');
    // UPSERT は呼ばれていない
    const upsertCalls = d1.stmts.filter((s) =>
      s.sql.toUpperCase().includes('INSERT INTO CONSENT_RECORDS'),
    );
    expect(upsertCalls).toHaveLength(0);
  });

  it('422: consentVersion フィールドが欠落', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(buildConsentRequest({}), env as never);
    expect(res.status).toBe(422);
  });

  it('401: x-fck-token なし', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(
      buildConsentRequest({ consentVersion: '2026-05-01' }, { token: null }),
      env as never,
    );
    expect(res.status).toBe(401);
  });

  it('401: x-fck-token 形式不正', async () => {
    const { env } = buildEnv();
    const res = await workerModule.fetch(
      buildConsentRequest({ consentVersion: '2026-05-01' }, { token: 'not-a-uuid' }),
      env as never,
    );
    expect(res.status).toBe(401);
  });
});
