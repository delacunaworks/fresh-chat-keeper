/**
 * CORS middleware の単体・統合テスト。
 *
 * 検証範囲:
 * - parseAllowedOrigins: カンマ区切り string の正規化
 * - 統合テスト: preflight (OPTIONS) と実リクエスト時の Access-Control-* ヘッダ
 */

import { describe, it, expect } from 'vitest';
import workerModule from '../src/index.js';
import { __test__ as corsTestExports } from '../src/middleware/cors.js';

const { parseAllowedOrigins } = corsTestExports;

describe('parseAllowedOrigins', () => {
  it('カンマ区切り文字列を origin の配列に分割する', () => {
    const result = parseAllowedOrigins('chrome-extension://abc,http://localhost:5173');
    expect(result).toEqual(['chrome-extension://abc', 'http://localhost:5173']);
  });

  it('前後の空白・末尾スラッシュ・空文字を除去する', () => {
    const result = parseAllowedOrigins(' chrome-extension://abc/ , ,http://localhost/ ');
    expect(result).toEqual(['chrome-extension://abc', 'http://localhost']);
  });

  it('未定義 / 空文字は空配列を返す', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins(' , , ')).toEqual([]);
  });
});

// ─── 統合テスト ──────────────────────────────────────────────

function buildEnv(allowedOrigins: string) {
  // CORS 単体検証用のごく軽いモック。実際の D1/KV/handler は呼ばれない想定で十分。
  const noopKv = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;

  const noopDb = {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        run: async () => ({ success: true, meta: { changes: 0 } }),
        all: async () => ({ results: [], success: true, meta: {} }),
      }),
    }),
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database;

  return {
    COLLECTION_DB: noopDb,
    RATE_LIMIT_KV: noopKv,
    CONSENT_KV: noopKv,
    COLLECTION_SALT: 'test-salt-must-be-long-enough',
    ALLOWED_ORIGINS: allowedOrigins,
  };
}

describe('CORS preflight (OPTIONS /v1/*)', () => {
  it('許可された origin の preflight に Access-Control-Allow-Origin を返す', async () => {
    const env = buildEnv('chrome-extension://allowed-id');
    const req = new Request('http://localhost/v1/ingest', {
      method: 'OPTIONS',
      headers: {
        Origin: 'chrome-extension://allowed-id',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-fck-token, content-type',
      },
    });
    const res = await workerModule.fetch(req, env as never);

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('chrome-extension://allowed-id');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-fck-token');
  });

  it('許可されない origin の preflight には Access-Control-Allow-Origin を返さない', async () => {
    const env = buildEnv('chrome-extension://allowed-id');
    const req = new Request('http://localhost/v1/ingest', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://attacker.example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const res = await workerModule.fetch(req, env as never);

    // Hono の cors() は origin が未許可なら ACAO を返さない（ブラウザ側で
    // preflight が失敗扱いになる）
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('ALLOWED_ORIGINS が空のときは全 origin を拒否する', async () => {
    const env = buildEnv('');
    const req = new Request('http://localhost/v1/ingest', {
      method: 'OPTIONS',
      headers: {
        Origin: 'chrome-extension://anything',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const res = await workerModule.fetch(req, env as never);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('GET / は CORS の影響を受けない', () => {
  it('Origin なしで health check が 200 を返す（モニタリング・uptime check 用）', async () => {
    const env = buildEnv('chrome-extension://allowed');
    const req = new Request('http://localhost/', { method: 'GET' });
    const res = await workerModule.fetch(req, env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});
