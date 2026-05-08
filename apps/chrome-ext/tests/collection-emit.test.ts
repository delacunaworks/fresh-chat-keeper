/**
 * collection-emit.ts のホワイトリスト検証 + opt-in ガードテスト。
 *
 * IngestClient 自体は collection-client.test.ts でカバーするので、本ファイルは
 * 「不正な apiUrl で client が起動しないこと」「opt-in 状態に追従すること」を
 * 単体検証する。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initCollectionEmitter,
  __test__ as emitTestExports,
} from '../src/content/collection-emit.js';
import { isAllowedApiOrigin } from '../src/content/collection-client.js';

const emitInternal = emitTestExports;

function installFakeChrome() {
  const fake = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
      },
      onChanged: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
    runtime: {
      sendMessage: async () => undefined,
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
}

beforeEach(() => {
  installFakeChrome();
  emitInternal.reset();
});

afterEach(() => {
  emitInternal.reset();
});

describe('isAllowedApiOrigin', () => {
  it('本番 URL は通過する', () => {
    expect(isAllowedApiOrigin('https://fresh-chat-keeper-api.playnicelab.workers.dev')).toBe(true);
    expect(isAllowedApiOrigin('https://fresh-chat-keeper-api.playnicelab.workers.dev/v1/ingest')).toBe(
      true,
    );
  });

  it('ローカル開発 URL は通過する', () => {
    expect(isAllowedApiOrigin('http://localhost:8788')).toBe(true);
    expect(isAllowedApiOrigin('http://127.0.0.1:8788/anything')).toBe(true);
  });

  it('未許可 origin は弾く（HTTP 本番 / 別ドメイン / port 違い）', () => {
    expect(isAllowedApiOrigin('http://fresh-chat-keeper-api.playnicelab.workers.dev')).toBe(false);
    expect(isAllowedApiOrigin('https://attacker.example.com')).toBe(false);
    expect(isAllowedApiOrigin('http://localhost:9999')).toBe(false);
  });

  it('不正な URL は false', () => {
    expect(isAllowedApiOrigin('not-a-url')).toBe(false);
    expect(isAllowedApiOrigin('')).toBe(false);
    expect(isAllowedApiOrigin('javascript:alert(1)')).toBe(false);
  });
});

describe('initCollectionEmitter: ホワイトリスト検証', () => {
  it('許可 URL なら警告なしで処理を進める', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await initCollectionEmitter('http://localhost:8788', 'token');
      // 同意状態が無いので client はまだ作られない（OK）
      expect(emitInternal.hasClient()).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('未許可 URL なら警告を出して client を起動しない', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await initCollectionEmitter('https://attacker.example.com', 'token');
      expect(warnSpy).toHaveBeenCalled();
      expect(emitInternal.hasClient()).toBe(false);
      const msg = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(msg).toContain('allowlist');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
