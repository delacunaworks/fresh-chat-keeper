/**
 * Phase 2.5 misreport 並行送信のテスト。
 *
 * archive.ts の onMisreport コールバック全体を再現するのは DOM 依存が大きい
 * ため、本テストは emitMisreportLog の opt-in / opt-out 分岐に絞る。
 *
 * 検証内容:
 * - opt-in 中: enqueueLog が呼ばれて logId が返る
 * - opt-out 中: null が返って ingest クライアントに何も流れない
 * - 戻り値の logId が UUID 形式
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initCollectionEmitter,
  emitMisreportLog,
  __test__ as emitTestExports,
} from '../src/content/collection-emit.js';
import {
  saveCollectionConsent,
  type CollectionConsentState,
} from '../src/shared/collection-state.js';

const VALID_TOKEN = '11111111-2222-4333-8444-555555555555';

interface FakeStorage {
  store: Map<string, unknown>;
  listeners: Array<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  >;
}

function installFakeChrome(): FakeStorage {
  const store = new Map<string, unknown>();
  const listeners: FakeStorage['listeners'] = [];

  const fake = {
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          const out: Record<string, unknown> = {};
          for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (entries: Record<string, unknown>) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const [k, v] of Object.entries(entries)) {
            const oldValue = store.get(k);
            store.set(k, v);
            changes[k] = { oldValue, newValue: v };
          }
          for (const l of listeners) l(changes, 'local');
        },
        remove: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const k of keys) {
            const oldValue = store.get(k);
            store.delete(k);
            changes[k] = { oldValue, newValue: undefined };
          }
          for (const l of listeners) l(changes, 'local');
        },
      },
      onChanged: {
        addListener: (l: (typeof listeners)[number]) => {
          listeners.push(l);
        },
        removeListener: (l: (typeof listeners)[number]) => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
    runtime: {
      sendMessage: async () => undefined,
      getManifest: () => ({ version: '0.3.5' }),
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { store, listeners };
}

import type { EmitJudgmentInput } from '../src/content/collection-emit.js';

function buildInput(): EmitJudgmentInput {
  return {
    videoId: 'dQw4w9WgXcQ',
    channelId: 'UCstreamer',
    gameTitle: 'persona5',
    timeIntoStream: 100,
    judgmentMode: 'archive_replay',
    targetBody: '主人公が死ぬ',
    targetAuthorChannelId: 'UCviewer-plain',
    targetTimestamp: '2026-05-01T10:00:00.000Z',
    precedingMessages: [],
    stageACategory: 'unknown',
    labels: ['spoiler'],
    primaryLabel: 'spoiler',
    confidence: 1.0,
    stage: 'stage2',
    reasonJa: null,
    labelSource: 'user_report',
  };
}

const userFeedback = {
  reportedAt: '2026-05-01T10:05:00.000Z',
  correctLabel: 'safe' as const,
  failureCategory: null,
  freeTextReason: null,
};

beforeEach(() => {
  installFakeChrome();
  emitTestExports.reset();
  // 全テストで使う fetch モック（200 OK）
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ accepted: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
  vi.useFakeTimers();
});

afterEach(() => {
  emitTestExports.reset();
  vi.useRealTimers();
});

describe('emitMisreportLog', () => {
  it('opt-out 中は null を返し ingest に送信しない', () => {
    // initCollectionEmitter なし、または consent 未保存
    const result = emitMisreportLog(buildInput(), userFeedback);
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('opt-in 中は logId を返し、IngestClient のバッファに積まれる', async () => {
    const consent: CollectionConsentState = {
      optedIn: true,
      consentVersion: '2026-05-01',
      recordedAt: 1714521600000,
    };
    await saveCollectionConsent(consent);
    await initCollectionEmitter('http://localhost:8788', VALID_TOKEN);

    const result = emitMisreportLog(buildInput(), userFeedback);
    expect(result).not.toBeNull();
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // 5 秒タイマーで flush され fetch が走る
    await vi.advanceTimersByTimeAsync(5_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // 送信された body の logs[0] に user_report ラベルと userFeedback が含まれる
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.logs[0].labelSource).toBe('user_report');
    expect(body.logs[0].userFeedback.correctLabel).toBe('safe');
    expect(body.logs[0].logId).toBe(result);
  });

  it('未許可 apiUrl で初期化された場合は opt-in 状態でも null を返す', async () => {
    const consent: CollectionConsentState = {
      optedIn: true,
      consentVersion: '2026-05-01',
      recordedAt: 1,
    };
    await saveCollectionConsent(consent);
    // 許可リスト外 URL
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await initCollectionEmitter('https://attacker.example.com', VALID_TOKEN);
      const result = emitMisreportLog(buildInput(), userFeedback);
      expect(result).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
