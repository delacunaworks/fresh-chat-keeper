/**
 * rate-limit middleware の単体テスト。
 *
 * 検証範囲:
 * - 通常: 0 → 1 → ... → 30 までは通過、31 で拒否
 * - NaN guard: KV に壊れた値（'NaN' / 'abc' / ''）が入っていても 0 扱いで通過
 * - fail-open: KV 障害時は warn ログのみで通過
 *
 * checkIngestRateLimit を直接呼ぶ単体テストで、middleware 統合は
 * ingest.test.ts の 429 ケースが既にカバー済み。
 */

import { describe, it, expect, vi } from 'vitest';
import { __test__ } from '../src/middleware/rate-limit.js';

const { checkIngestRateLimit, RATE_LIMIT_MAX } = __test__;

function createKvWithValue(value: string | null): KVNamespace {
  const store = new Map<string, string>();
  if (value !== null) {
    // 現在の window key と一致するキーで書き込む
    const windowKey = Math.floor(Date.now() / 60000);
    store.set(`ingest-rl:test-ip:${windowKey}`, value);
  }
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, val: string) => {
      store.set(key, val);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

describe('checkIngestRateLimit: 通常動作', () => {
  it('カウンタが上限未満なら通過する', async () => {
    const kv = createKvWithValue('5');
    const ok = await checkIngestRateLimit('test-ip', kv);
    expect(ok).toBe(true);
  });

  it('カウンタが上限ちょうどなら拒否する', async () => {
    const kv = createKvWithValue(String(RATE_LIMIT_MAX));
    const ok = await checkIngestRateLimit('test-ip', kv);
    expect(ok).toBe(false);
  });

  it('カウンタ未設定なら 0 扱いで通過する', async () => {
    const kv = createKvWithValue(null);
    const ok = await checkIngestRateLimit('test-ip', kv);
    expect(ok).toBe(true);
  });
});

describe('checkIngestRateLimit: NaN guard', () => {
  it('"NaN" 文字列が入っていても 0 扱いで通過する（rate limit が無効化されない）', async () => {
    const kv = createKvWithValue('NaN');
    const ok = await checkIngestRateLimit('test-ip', kv);
    expect(ok).toBe(true);
  });

  it('"abc" のような完全な非数字でも 0 扱いで通過する', async () => {
    const kv = createKvWithValue('abc');
    const ok = await checkIngestRateLimit('test-ip', kv);
    expect(ok).toBe(true);
  });

  it('空文字でも 0 扱いで通過する', async () => {
    const kv = createKvWithValue('');
    const ok = await checkIngestRateLimit('test-ip', kv);
    expect(ok).toBe(true);
  });

  it('"10abc" のような先頭数字つき文字列は parseInt の挙動どおり 10 が使われる', async () => {
    // これは現状実装の挙動を保護するテスト。「parseInt は緩い」ことを意識的に固定する。
    // 10 < RATE_LIMIT_MAX(30) なので通過する。
    const kv = createKvWithValue('10abc');
    const ok = await checkIngestRateLimit('test-ip', kv);
    expect(ok).toBe(true);
  });

  it('"99abc"（parseInt で 99）は上限超えで拒否される（NaN 経路ではない）', async () => {
    // NaN guard が誤って parseInt の結果まで 0 にしないことの確認。
    const kv = createKvWithValue('99abc');
    const ok = await checkIngestRateLimit('test-ip', kv);
    expect(ok).toBe(false);
  });
});

describe('checkIngestRateLimit: fail-open', () => {
  it('KV 障害時はリクエストを通す（warn ログのみ）', async () => {
    const failingKv = {
      get: async () => {
        throw new Error('KV outage');
      },
      put: async () => {
        throw new Error('KV outage');
      },
    } as unknown as KVNamespace;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ok = await checkIngestRateLimit('test-ip', failingKv);
      expect(ok).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
      const msg = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(msg.toLowerCase()).toContain('failing open');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
