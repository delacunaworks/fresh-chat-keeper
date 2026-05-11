/**
 * background service worker の fetch プロキシ単体テスト。
 *
 * BACKGROUND-01: content-script / popup から chrome.runtime.sendMessage 経由で
 * 受け取った fetch 依頼を、chrome-extension:// origin で実行して結果を返す。
 *
 * 検証内容:
 * - isAllowedApiOrigin: ホワイトリストの判定（malformed URL も含む）
 * - handleBgFetch:
 *   - 200 OK: { ok: true, status: 200, json: <parsed> }
 *   - 4xx / 5xx: { ok: true, status, json }（status は呼び出し側が解釈）
 *   - fetch throw: { ok: false, kind: 'network', message }
 *   - apiUrl が allowlist 外: { ok: false, kind: 'invalid-origin', message }
 *   - body の JSON parse 失敗時: json: null
 * - isBackgroundFetchRequest: 型ガードの境界条件
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isAllowedApiOrigin,
  handleBgFetch,
  __test__,
} from '../src/background/service-worker.js';
import type { BackgroundFetchRequest } from '@fresh-chat-keeper/shared';

const VALID_REQUEST: BackgroundFetchRequest = {
  type: 'fck:bg-fetch',
  endpoint: 'consent',
  apiUrl: 'http://localhost:8788',
  token: '11111111-2222-4333-8444-555555555555',
  body: { consentVersion: '2026-05-01' },
};

/**
 * fetch をモック化し、レスポンスシーケンスを順番に返す helper。
 * `throwError` を立てるとその呼び出しで例外を投げる。
 */
function mockFetchSequence(
  responses: Array<{ status: number; body?: unknown; throwError?: boolean }>,
): { calls: Array<{ url: string; init: RequestInit | undefined }>; restore: () => void } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const original = globalThis.fetch;
  // @ts-expect-error: テスト用簡易型
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r.throwError) throw new Error('network down');
    return new Response(
      r.body === undefined ? '' : JSON.stringify(r.body),
      {
        status: r.status,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('isAllowedApiOrigin', () => {
  it('本番 URL は許可される', () => {
    expect(
      isAllowedApiOrigin('https://fresh-chat-keeper-api.playnicelab.workers.dev'),
    ).toBe(true);
    expect(
      isAllowedApiOrigin(
        'https://fresh-chat-keeper-api.playnicelab.workers.dev/v1/ingest',
      ),
    ).toBe(true);
  });

  it('localhost / 127.0.0.1 :8788 は許可される（dev）', () => {
    expect(isAllowedApiOrigin('http://localhost:8788')).toBe(true);
    expect(isAllowedApiOrigin('http://localhost:8788/v1/consent')).toBe(true);
    expect(isAllowedApiOrigin('http://127.0.0.1:8788')).toBe(true);
  });

  it('似ているが別ドメイン（typosquat 等）は弾く', () => {
    expect(
      isAllowedApiOrigin(
        'https://fresh-chat-keeper-api.playnicelab.workers.dev.evil.com',
      ),
    ).toBe(false);
    expect(isAllowedApiOrigin('http://localhost:9999')).toBe(false);
    expect(isAllowedApiOrigin('https://localhost:8788')).toBe(false); // https
    expect(isAllowedApiOrigin('http://example.com')).toBe(false);
  });

  it('malformed URL は false（fail-closed）', () => {
    expect(isAllowedApiOrigin('')).toBe(false);
    expect(isAllowedApiOrigin('not a url')).toBe(false);
    expect(isAllowedApiOrigin('javascript:alert(1)')).toBe(false);
  });
});

describe('handleBgFetch', () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it('200 OK: { ok: true, status: 200, json } を返す', async () => {
    const m = mockFetchSequence([{ status: 200, body: { recorded: true } }]);
    restore = m.restore;
    const res = await handleBgFetch(VALID_REQUEST);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ recorded: true });
    }
    expect(m.calls[0].url).toBe('http://localhost:8788/v1/consent');
    const headers = m.calls[0].init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['x-fck-token']).toBe(VALID_REQUEST.token);
  });

  it('endpoint = ingest: URL パスは /v1/ingest', async () => {
    const m = mockFetchSequence([{ status: 200, body: { accepted: 1 } }]);
    restore = m.restore;
    await handleBgFetch({ ...VALID_REQUEST, endpoint: 'ingest', body: { logs: [] } });
    expect(m.calls[0].url).toBe('http://localhost:8788/v1/ingest');
  });

  it('endpoint = revoke: body は空オブジェクトでも OK', async () => {
    const m = mockFetchSequence([{ status: 200, body: { revoked: true } }]);
    restore = m.restore;
    await handleBgFetch({ ...VALID_REQUEST, endpoint: 'revoke', body: null });
    expect(m.calls[0].url).toBe('http://localhost:8788/v1/revoke');
    expect(m.calls[0].init?.body).toBe('{}');
  });

  it('4xx ステータス: { ok: true, status: 422 } を返す（HTTP エラーは ok:true）', async () => {
    const m = mockFetchSequence([{ status: 422, body: { error: 'bad' } }]);
    restore = m.restore;
    const res = await handleBgFetch(VALID_REQUEST);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(422);
      expect(res.json).toEqual({ error: 'bad' });
    }
  });

  it('fetch が throw: { ok: false, kind: "network" }', async () => {
    const m = mockFetchSequence([{ status: 0, throwError: true }]);
    restore = m.restore;
    const res = await handleBgFetch(VALID_REQUEST);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('network');
      expect(res.message).toMatch(/network down/);
    }
  });

  it('apiUrl が allowlist にない: { ok: false, kind: "invalid-origin" }（fetch しない）', async () => {
    const m = mockFetchSequence([]);
    restore = m.restore;
    const res = await handleBgFetch({
      ...VALID_REQUEST,
      apiUrl: 'http://evil.example.com',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('invalid-origin');
    }
    expect(m.calls).toHaveLength(0); // fetch すら呼ばれない
  });

  it('apiUrl が malformed: { ok: false, kind: "invalid-origin" }', async () => {
    const m = mockFetchSequence([]);
    restore = m.restore;
    const res = await handleBgFetch({ ...VALID_REQUEST, apiUrl: 'not a url' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('invalid-origin');
    }
  });

  it('body の JSON parse 失敗（200 だが空 body）: json: null', async () => {
    const m = mockFetchSequence([{ status: 200 }]); // body 未指定 → 空文字
    restore = m.restore;
    const res = await handleBgFetch(VALID_REQUEST);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      expect(res.json).toBeNull();
    }
  });
});

describe('isBackgroundFetchRequest (型ガード)', () => {
  const guard = __test__.isBackgroundFetchRequest;

  it('完全なリクエストは true', () => {
    expect(guard(VALID_REQUEST)).toBe(true);
  });

  it('type 不一致は false（他の chrome.runtime メッセージ）', () => {
    expect(guard({ ...VALID_REQUEST, type: 'fck:consent-refresh-required' })).toBe(false);
    expect(guard({ ...VALID_REQUEST, type: 'unknown' })).toBe(false);
  });

  it('endpoint 不正は false', () => {
    expect(guard({ ...VALID_REQUEST, endpoint: 'unknown' })).toBe(false);
    expect(guard({ ...VALID_REQUEST, endpoint: '' })).toBe(false);
  });

  it('apiUrl / token 欠落は false', () => {
    expect(guard({ ...VALID_REQUEST, apiUrl: '' })).toBe(false);
    expect(guard({ ...VALID_REQUEST, token: '' })).toBe(false);
  });

  it('null / undefined / プリミティブは false', () => {
    expect(guard(null)).toBe(false);
    expect(guard(undefined)).toBe(false);
    expect(guard('string')).toBe(false);
    expect(guard(42)).toBe(false);
  });
});
