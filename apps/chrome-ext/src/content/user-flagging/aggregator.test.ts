/**
 * Phase 3.5 B4: aggregator のテスト。
 *
 * 検証観点:
 * - enabled=false で recordJudgment / sessionTracker.recordMessage 共に呼ばれない
 * - enabled=true で 'spoiler' / 'safe' / 'off_topic' / 'harassment' / 'backseat' /
 *   'spam' を渡したときの buildFlaggedDelta が期待通り
 * - streamerChannelId=null で skip + warn 1 回
 * - chrome.storage.onChanged で enabled が false→true / true→false に切り替わる
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initAggregator, recordAggregate, __test__ } from './aggregator.js';
import { SessionTracker } from './session-tracker.js';
import {
  __test__ as storeTest,
  flushAll,
  loadStreamerStats,
} from '../../shared/user-stats-store.js';
import * as streamDetector from './stream-detector.js';
import { DEFAULT_SETTINGS, STORAGE_KEY, type Settings } from '../../shared/settings.js';

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
        get: async (key: string | string[] | null) => {
          const keys = Array.isArray(key) ? key : key ? [key] : [...store.keys()];
          const out: Record<string, unknown> = {};
          for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) store.set(k, v);
        },
        remove: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) store.delete(k);
        },
      },
      onChanged: {
        addListener: (
          fn: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
        ) => {
          listeners.push(fn);
        },
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { store, listeners };
}

function settingsWith(userFlaggingEnabled: boolean): Settings {
  return {
    ...DEFAULT_SETTINGS,
    userFlagging: {
      ...DEFAULT_SETTINGS.userFlagging!,
      enabled: userFlaggingEnabled,
    },
  };
}

describe('aggregator', () => {
  let fake: FakeStorage;
  let tracker: SessionTracker;
  // 型は MockInstance だが共変問題でゆるく受ける（テスト局所スコープ）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let streamerSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let displayNameSpy: any;

  beforeEach(() => {
    fake = installFakeChrome();
    __test__.reset();
    storeTest.resetPending();
    tracker = new SessionTracker();
    tracker.startNewSession('UC_streamer');
    streamerSpy = vi
      .spyOn(streamDetector, 'getCurrentStreamerChannelId')
      .mockReturnValue('UC_streamer');
    displayNameSpy = vi
      .spyOn(streamDetector, 'getCurrentStreamerDisplayName')
      .mockReturnValue('Test Streamer');
  });

  afterEach(() => {
    streamerSpy.mockRestore();
    displayNameSpy.mockRestore();
    storeTest.resetPending();
  });

  it('enabled=false 初期化 → recordAggregate が no-op（store も session も触らない）', async () => {
    initAggregator(settingsWith(false), tracker);
    recordAggregate({
      user: { channelId: '@viewer', displayName: 'A' },
      primaryLabel: 'spoiler',
    });
    await flushAll();
    expect(tracker.getSessionStats('@viewer')).toBeNull();
    expect(fake.store.has('fck_user_stats:UC_streamer')).toBe(false);
  });

  it('enabled=true で spoiler → flagged={spoiler:1} が積まれる', async () => {
    initAggregator(settingsWith(true), tracker);
    recordAggregate({
      user: { channelId: '@viewer', displayName: 'A' },
      primaryLabel: 'spoiler',
      timestamp: new Date('2026-05-25T00:00:00Z').getTime(),
    });
    await flushAll();
    const stats = await loadStreamerStats('UC_streamer');
    const dailyKey = Object.keys(stats.users['@viewer'].dailyStats)[0];
    expect(stats.users['@viewer'].dailyStats[dailyKey].messageCount).toBe(1);
    expect(stats.users['@viewer'].dailyStats[dailyKey].flaggedCounts.spoiler).toBe(1);
    // session 側にも反映
    const session = tracker.getSessionStats('@viewer');
    expect(session?.messageCount).toBe(1);
    expect(session?.flaggedCounts.spoiler).toBe(1);
  });

  it('B5-hotfix: streamerDisplayName が store に伝播する', async () => {
    initAggregator(settingsWith(true), tracker);
    recordAggregate({
      user: { channelId: '@viewer', displayName: 'A' },
      primaryLabel: 'spoiler',
    });
    await flushAll();
    const stats = await loadStreamerStats('UC_streamer');
    expect(stats.streamerDisplayName).toBe('Test Streamer');
  });

  it("enabled=true で 'safe' → messageCount +1 / 全カテゴリ 0", async () => {
    initAggregator(settingsWith(true), tracker);
    recordAggregate({
      user: { channelId: '@viewer', displayName: 'A' },
      primaryLabel: 'safe',
    });
    await flushAll();
    const stats = await loadStreamerStats('UC_streamer');
    const dailyKey = Object.keys(stats.users['@viewer'].dailyStats)[0];
    expect(stats.users['@viewer'].dailyStats[dailyKey].messageCount).toBe(1);
    expect(stats.users['@viewer'].dailyStats[dailyKey].flaggedCounts.spoiler).toBe(0);
    expect(stats.users['@viewer'].dailyStats[dailyKey].flaggedCounts.harassment).toBe(0);
    expect(tracker.getSessionStats('@viewer')?.messageCount).toBe(1);
    expect(tracker.getSessionStats('@viewer')?.flaggedCounts.spoiler).toBe(0);
  });

  it("'off_topic' は offTopic キーに変換される", async () => {
    initAggregator(settingsWith(true), tracker);
    recordAggregate({
      user: { channelId: '@viewer', displayName: 'A' },
      primaryLabel: 'off_topic',
    });
    await flushAll();
    const stats = await loadStreamerStats('UC_streamer');
    const dailyKey = Object.keys(stats.users['@viewer'].dailyStats)[0];
    expect(stats.users['@viewer'].dailyStats[dailyKey].flaggedCounts.offTopic).toBe(1);
    expect(tracker.getSessionStats('@viewer')?.flaggedCounts.offTopic).toBe(1);
  });

  it("'harassment' / 'spam' / 'backseat' も期待通り反映される", async () => {
    initAggregator(settingsWith(true), tracker);
    for (const label of ['harassment', 'spam', 'backseat'] as const) {
      recordAggregate({
        user: { channelId: `@${label}`, displayName: label },
        primaryLabel: label,
      });
    }
    await flushAll();
    const stats = await loadStreamerStats('UC_streamer');
    const harK = Object.keys(stats.users['@harassment'].dailyStats)[0];
    expect(stats.users['@harassment'].dailyStats[harK].flaggedCounts.harassment).toBe(1);
    const spK = Object.keys(stats.users['@spam'].dailyStats)[0];
    expect(stats.users['@spam'].dailyStats[spK].flaggedCounts.spam).toBe(1);
    const bsK = Object.keys(stats.users['@backseat'].dailyStats)[0];
    expect(stats.users['@backseat'].dailyStats[bsK].flaggedCounts.backseat).toBe(1);
  });

  it('streamerChannelId=null → skip + warn 1 度だけ', async () => {
    streamerSpy.mockReturnValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    initAggregator(settingsWith(true), tracker);

    recordAggregate({ user: { channelId: '@a', displayName: 'A' }, primaryLabel: 'spoiler' });
    recordAggregate({ user: { channelId: '@b', displayName: 'B' }, primaryLabel: 'spoiler' });
    await flushAll();

    expect(tracker.getSessionStats('@a')).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('onChanged で enabled false→true / true→false が反映される', async () => {
    initAggregator(settingsWith(false), tracker);
    expect(__test__.isEnabled()).toBe(false);

    // false → true
    const newOn: Settings = settingsWith(true);
    fake.listeners.forEach((fn) =>
      fn({ [STORAGE_KEY]: { newValue: newOn, oldValue: settingsWith(false) } }, 'local'),
    );
    expect(__test__.isEnabled()).toBe(true);

    // true → false
    const newOff: Settings = settingsWith(false);
    fake.listeners.forEach((fn) =>
      fn({ [STORAGE_KEY]: { newValue: newOff, oldValue: newOn } }, 'local'),
    );
    expect(__test__.isEnabled()).toBe(false);
  });

  it('init は二重起動しても listener を 1 つだけ持つ（再起動安全）', () => {
    initAggregator(settingsWith(true), tracker);
    initAggregator(settingsWith(false), tracker);
    // 2 回目で enabled は更新される
    expect(__test__.isEnabled()).toBe(false);
    // listener は 1 つだけ（installed フラグで gating）
    expect(fake.listeners.length).toBe(1);
  });
});
