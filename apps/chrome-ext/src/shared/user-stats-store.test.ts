/**
 * Phase 3.5 B3: user-stats-store.ts のテスト。
 *
 * 検証観点:
 * - normalizeStreamerStats の fail-safe（null / array / users 不正 / entry 欠落）
 * - CRUD ラウンドトリップ
 * - clearAllUserStats が fck_user_stats:* のみ消す（fck_settings 等残す）
 * - recordJudgment + 5 秒 windowed flush（vi.useFakeTimers）
 * - flushAll の即時書き込み
 * - cached API（setCached / invalidateCachedFor / clearAllCached）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadStreamerStats,
  saveStreamerStats,
  clearStreamerStats,
  clearAllUserStats,
  normalizeStreamerStats,
  emptyStreamerStats,
  recordJudgment,
  flushAll,
  setCached,
  invalidateCachedFor,
  clearAllCached,
  storeKeyFor,
  USER_STATS_PREFIX,
  __test__,
} from './user-stats-store.js';
import type { CachedStats } from '@fresh-chat-keeper/judgment-engine';

const STREAMER = 'UC_streamer';
const STREAMER_NAME = 'StreamerName';
const USER_A = '@viewer_a';
const USER_B = '@viewer_b';

// ─── chrome.storage.local の fake ─────────────────────────────────

interface FakeStorage {
  store: Map<string, unknown>;
}

function installFakeChrome(): FakeStorage {
  const store = new Map<string, unknown>();
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
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { store };
}

beforeEach(() => {
  __test__.resetPending();
});

afterEach(() => {
  __test__.resetPending();
});

// ─── normalize 系 ───────────────────────────────────────────────────

describe('normalizeStreamerStats: fail-safe', () => {
  it('null → 空構造（streamerChannelId は引数を権威に）', () => {
    const out = normalizeStreamerStats(null, STREAMER);
    expect(out).toEqual(emptyStreamerStats(STREAMER));
  });

  it('配列 → 空構造', () => {
    const out = normalizeStreamerStats([1, 2, 3], STREAMER);
    expect(out.users).toEqual({});
    expect(out.streamerChannelId).toBe(STREAMER);
  });

  it('users 非オブジェクト → users 空に', () => {
    const out = normalizeStreamerStats(
      { streamerChannelId: STREAMER, users: 'oops' },
      STREAMER,
    );
    expect(out.users).toEqual({});
  });

  it('不正 entry はドロップ、正しい entry は残す', () => {
    const out = normalizeStreamerStats(
      {
        streamerChannelId: STREAMER,
        users: {
          [USER_A]: { channelId: USER_A, dailyStats: {} },
          bogus: 'not-object',
          arrayEntry: [1, 2],
          [USER_B]: {
            channelId: USER_B,
            dailyStats: {
              '2026-05-24': {
                date: '2026-05-24',
                messageCount: 5,
                flaggedCounts: { spoiler: 1 },
              },
              badEntry: 'not-object',
            },
          },
        },
      },
      STREAMER,
    );
    expect(Object.keys(out.users).sort()).toEqual([USER_A, USER_B]);
    expect(out.users[USER_B].dailyStats['2026-05-24'].messageCount).toBe(5);
    expect(out.users[USER_B].dailyStats['2026-05-24'].flaggedCounts.spoiler).toBe(1);
    // 不正 dailyStats entry はドロップ
    expect(out.users[USER_B].dailyStats.badEntry).toBeUndefined();
  });

  it('streamerChannelId は raw 側より引数を優先する', () => {
    const out = normalizeStreamerStats(
      { streamerChannelId: 'mismatch', users: {} },
      STREAMER,
    );
    expect(out.streamerChannelId).toBe(STREAMER);
  });

  it('flaggedCounts の負数・NaN・無限大は 0 に倒す', () => {
    const out = normalizeStreamerStats(
      {
        users: {
          [USER_A]: {
            channelId: USER_A,
            dailyStats: {
              '2026-05-24': {
                date: '2026-05-24',
                messageCount: 10,
                flaggedCounts: { spoiler: -5, harassment: NaN, spam: Infinity, offTopic: 2 },
              },
            },
          },
        },
      },
      STREAMER,
    );
    const fc = out.users[USER_A].dailyStats['2026-05-24'].flaggedCounts;
    expect(fc.spoiler).toBe(0);
    expect(fc.harassment).toBe(0);
    expect(fc.spam).toBe(0);
    expect(fc.offTopic).toBe(2);
  });

  it('cached の壊れた値は null に倒す', () => {
    const out = normalizeStreamerStats(
      {
        users: {
          [USER_A]: {
            channelId: USER_A,
            dailyStats: {},
            cached: { calculatedAt: 'not-number', flagLevel: 'invalid' },
          },
        },
      },
      STREAMER,
    );
    expect(out.users[USER_A].cached).toBeNull();
  });
});

// ─── CRUD ラウンドトリップ ──────────────────────────────────────

describe('CRUD ラウンドトリップ', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('save → load で同じ値が読み出せる', async () => {
    const stats = emptyStreamerStats(STREAMER, 'StreamerName');
    stats.lastUpdated = 12345;
    stats.users[USER_A] = {
      channelId: USER_A,
      displayNameLatest: 'Alice',
      displayNameFirstSeen: 'Alice',
      firstSeenAt: 1000,
      lastSeenAt: 2000,
      dailyStats: {
        '2026-05-24': {
          date: '2026-05-24',
          messageCount: 3,
          flaggedCounts: {
            spoiler: 0,
            harassment: 1,
            spam: 0,
            offTopic: 0,
            backseat: 0,
          },
        },
      },
      cached: null,
    };
    await saveStreamerStats(stats);
    const loaded = await loadStreamerStats(STREAMER);
    expect(loaded).toEqual(stats);
  });

  it('未保存 → 空構造を返す', async () => {
    const loaded = await loadStreamerStats(STREAMER);
    expect(loaded).toEqual(emptyStreamerStats(STREAMER));
  });

  it('clearStreamerStats で削除される', async () => {
    await saveStreamerStats(emptyStreamerStats(STREAMER, 'X'));
    expect(fake.store.has(storeKeyFor(STREAMER))).toBe(true);
    await clearStreamerStats(STREAMER);
    expect(fake.store.has(storeKeyFor(STREAMER))).toBe(false);
  });

  it('storeKeyFor は fck_user_stats: prefix を付与', () => {
    expect(storeKeyFor(STREAMER)).toBe(`${USER_STATS_PREFIX}${STREAMER}`);
    expect(storeKeyFor(STREAMER)).toBe('fck_user_stats:UC_streamer');
  });
});

describe('clearAllUserStats: fck_user_stats:* のみ削除', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('他キー（fck_settings 等）は残す', async () => {
    await saveStreamerStats(emptyStreamerStats('UC_a', ''));
    await saveStreamerStats(emptyStreamerStats('UC_b', ''));
    fake.store.set('fck_settings', { enabled: true });
    fake.store.set('fck_user_blocks', { channelIds: [] });

    const result = await clearAllUserStats();
    expect(result.removedCount).toBe(2);
    expect(fake.store.has('fck_settings')).toBe(true);
    expect(fake.store.has('fck_user_blocks')).toBe(true);
    expect(fake.store.has(storeKeyFor('UC_a'))).toBe(false);
    expect(fake.store.has(storeKeyFor('UC_b'))).toBe(false);
  });

  it('対象キー 0 件なら no-op で removedCount=0', async () => {
    fake.store.set('fck_settings', {});
    const result = await clearAllUserStats();
    expect(result.removedCount).toBe(0);
    expect(fake.store.has('fck_settings')).toBe(true);
  });
});

// ─── recordJudgment + 5 秒 windowed flush ─────────────────────────

describe('recordJudgment / 5 秒 windowed flush', () => {
  let fake: FakeStorage;

  beforeEach(() => {
    fake = installFakeChrome();
    vi.useFakeTimers({ now: new Date('2026-05-24T12:00:00Z').getTime() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1 record で 5s 後に flush（5s 未満では書かれない）', async () => {
    recordJudgment(STREAMER, STREAMER_NAME, { channelId: USER_A, displayName: 'Alice' }, { spoiler: 1 });
    expect(fake.store.has(storeKeyFor(STREAMER))).toBe(false);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fake.store.has(storeKeyFor(STREAMER))).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    // flush の async 処理を解決
    await vi.runAllTimersAsync();
    const stats = await loadStreamerStats(STREAMER);
    expect(stats.users[USER_A].dailyStats['2026-05-24'].messageCount).toBe(1);
    expect(stats.users[USER_A].dailyStats['2026-05-24'].flaggedCounts.spoiler).toBe(1);
  });

  it('5s 窓内の複数 record を 1 set にまとめて書く', async () => {
    recordJudgment(STREAMER, STREAMER_NAME, { channelId: USER_A, displayName: 'Alice' }, { spoiler: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    recordJudgment(STREAMER, STREAMER_NAME, { channelId: USER_A, displayName: 'Alice' }, { harassment: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    recordJudgment(STREAMER, STREAMER_NAME, { channelId: USER_B, displayName: 'Bob' }, {});
    await vi.advanceTimersByTimeAsync(3500);
    await vi.runAllTimersAsync();

    const stats = await loadStreamerStats(STREAMER);
    expect(stats.users[USER_A].dailyStats['2026-05-24'].messageCount).toBe(2);
    expect(stats.users[USER_A].dailyStats['2026-05-24'].flaggedCounts.spoiler).toBe(1);
    expect(stats.users[USER_A].dailyStats['2026-05-24'].flaggedCounts.harassment).toBe(1);
    expect(stats.users[USER_B].dailyStats['2026-05-24'].messageCount).toBe(1);
    expect(stats.users[USER_B].dailyStats['2026-05-24'].flaggedCounts.spoiler).toBe(0);
  });

  it('別 streamerId は独立タイマー（一方の flush で他方は書かれない）', async () => {
    recordJudgment('UC_a', 'NameA', { channelId: USER_A, displayName: 'Alice' }, { spoiler: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    recordJudgment('UC_b', 'NameB', { channelId: USER_A, displayName: 'Alice' }, { spoiler: 1 });
    // UC_a の 5s が満了
    await vi.advanceTimersByTimeAsync(2500);
    await vi.runAllTimersAsync();
    // この時点で UC_a は書かれ、UC_b はまだ
    expect(fake.store.has(storeKeyFor('UC_a'))).toBe(true);

    // UC_b 経路を完了させる
    await vi.advanceTimersByTimeAsync(3000);
    await vi.runAllTimersAsync();
    expect(fake.store.has(storeKeyFor('UC_b'))).toBe(true);
  });

  it('flush 後の新 record は再びタイマーを立てる', async () => {
    recordJudgment(STREAMER, STREAMER_NAME, { channelId: USER_A, displayName: 'Alice' }, { spoiler: 1 });
    await vi.advanceTimersByTimeAsync(5500);
    await vi.runAllTimersAsync();
    expect(
      (await loadStreamerStats(STREAMER)).users[USER_A].dailyStats['2026-05-24'].messageCount,
    ).toBe(1);

    // 新たな record
    recordJudgment(STREAMER, STREAMER_NAME, { channelId: USER_A, displayName: 'Alice' }, { harassment: 1 });
    // 5s 経たないと反映されない
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      (await loadStreamerStats(STREAMER)).users[USER_A].dailyStats['2026-05-24'].messageCount,
    ).toBe(1);
    await vi.advanceTimersByTimeAsync(3500);
    await vi.runAllTimersAsync();
    const stats = await loadStreamerStats(STREAMER);
    expect(stats.users[USER_A].dailyStats['2026-05-24'].messageCount).toBe(2);
    expect(stats.users[USER_A].dailyStats['2026-05-24'].flaggedCounts.harassment).toBe(1);
  });

  it('recordJudgment merge: 新規 user で firstSeenAt が設定される', async () => {
    const t0 = new Date('2026-05-24T12:00:00Z').getTime();
    recordJudgment(
      STREAMER,
      STREAMER_NAME,
      { channelId: USER_A, displayName: 'Alice' },
      { spoiler: 1 },
      t0,
    );
    await vi.advanceTimersByTimeAsync(5500);
    await vi.runAllTimersAsync();
    const stats = await loadStreamerStats(STREAMER);
    expect(stats.users[USER_A].firstSeenAt).toBe(t0);
    expect(stats.users[USER_A].lastSeenAt).toBe(t0);
    expect(stats.users[USER_A].displayNameFirstSeen).toBe('Alice');
  });

  it('recordJudgment merge: 既存 user は firstSeenAt 不変・lastSeenAt 更新', async () => {
    // 初回観測 → flush
    const t0 = new Date('2026-05-24T12:00:00Z').getTime();
    recordJudgment(
      STREAMER,
      STREAMER_NAME,
      { channelId: USER_A, displayName: 'Alice' },
      { spoiler: 1 },
      t0,
    );
    await vi.advanceTimersByTimeAsync(5500);
    await vi.runAllTimersAsync();

    // 2 回目（少し後）
    const t1 = t0 + 60_000;
    recordJudgment(STREAMER, STREAMER_NAME, { channelId: USER_A, displayName: 'Alice2' }, {}, t1);
    await vi.advanceTimersByTimeAsync(5500);
    await vi.runAllTimersAsync();

    const stats = await loadStreamerStats(STREAMER);
    expect(stats.users[USER_A].firstSeenAt).toBe(t0);
    expect(stats.users[USER_A].lastSeenAt).toBe(t1);
    expect(stats.users[USER_A].displayNameLatest).toBe('Alice2');
    expect(stats.users[USER_A].displayNameFirstSeen).toBe('Alice');
  });

  it('cached は新フラグ受領時に null に倒される（B4 再計算用）', async () => {
    // 初回 + flush
    recordJudgment(STREAMER, STREAMER_NAME, { channelId: USER_A, displayName: 'Alice' }, { spoiler: 1 });
    await vi.advanceTimersByTimeAsync(5500);
    await vi.runAllTimersAsync();

    // cached を手動セット
    const cached: CachedStats = {
      calculatedAt: Date.now(),
      period: '30d',
      totalMessages: 1,
      flaggedCounts: { spoiler: 1, harassment: 0, spam: 0, offTopic: 0, backseat: 0 },
      totalFlagged: 1,
      flagLevel: 'grey',
      severityScore: 2.5,
    };
    await setCached(STREAMER, USER_A, cached);
    expect((await loadStreamerStats(STREAMER)).users[USER_A].cached).not.toBeNull();

    // 新 record → cached が null になる
    recordJudgment(STREAMER, STREAMER_NAME, { channelId: USER_A, displayName: 'Alice' }, { spoiler: 1 });
    await vi.advanceTimersByTimeAsync(5500);
    await vi.runAllTimersAsync();
    expect((await loadStreamerStats(STREAMER)).users[USER_A].cached).toBeNull();
  });

  // ─── B5-hotfix: streamerDisplayName 伝播 ─────────────────────────

  it('B5-hotfix: streamerDisplayName が PendingStreamer 経由で flush 後の store に保存される', async () => {
    recordJudgment(
      STREAMER,
      'Initial Streamer',
      { channelId: USER_A, displayName: 'Alice' },
      { spoiler: 1 },
    );
    await vi.advanceTimersByTimeAsync(5500);
    await vi.runAllTimersAsync();

    const stats = await loadStreamerStats(STREAMER);
    expect(stats.streamerDisplayName).toBe('Initial Streamer');
  });

  it('B5-hotfix: 既存 pending の空 displayName を後続 record の非空値で上書きする', async () => {
    // 1 件目: displayName 空（初回 record 時に DOM 未準備のケース）
    recordJudgment(
      STREAMER,
      '',
      { channelId: USER_A, displayName: 'Alice' },
      { spoiler: 1 },
    );
    // 2 件目: 5s 窓内、displayName 取得済み
    await vi.advanceTimersByTimeAsync(1000);
    recordJudgment(
      STREAMER,
      'Late Resolved Streamer',
      { channelId: USER_B, displayName: 'Bob' },
      { harassment: 1 },
    );
    await vi.advanceTimersByTimeAsync(5500);
    await vi.runAllTimersAsync();

    const stats = await loadStreamerStats(STREAMER);
    expect(stats.streamerDisplayName).toBe('Late Resolved Streamer');
  });

  it('B5-hotfix: flush 時に既存 StreamerScopedUserStats の空 displayName も refresh される', async () => {
    // 1 度目の flush は displayName 空のまま保存（旧運用シミュレーション）
    recordJudgment(STREAMER, '', { channelId: USER_A, displayName: 'Alice' }, { spoiler: 1 });
    await vi.advanceTimersByTimeAsync(5500);
    await vi.runAllTimersAsync();
    expect((await loadStreamerStats(STREAMER)).streamerDisplayName).toBe('');

    // 2 度目: 値を持って record → flush 時に refresh される
    recordJudgment(
      STREAMER,
      'Recovered Name',
      { channelId: USER_A, displayName: 'Alice' },
      { spoiler: 1 },
    );
    await vi.advanceTimersByTimeAsync(5500);
    await vi.runAllTimersAsync();

    expect((await loadStreamerStats(STREAMER)).streamerDisplayName).toBe('Recovered Name');
  });

  it('B5-hotfix: 既に取得済みの displayName を空文字で潰さない（空→非空のみ許可）', async () => {
    // 1 件目: 値あり
    recordJudgment(
      STREAMER,
      'Established Name',
      { channelId: USER_A, displayName: 'Alice' },
      { spoiler: 1 },
    );
    // 2 件目: 5s 窓内、空文字（DOM 取得失敗のレース）
    await vi.advanceTimersByTimeAsync(1000);
    recordJudgment(STREAMER, '', { channelId: USER_B, displayName: 'Bob' }, {});
    await vi.advanceTimersByTimeAsync(5500);
    await vi.runAllTimersAsync();

    // 上書きされず Established Name のまま
    const stats = await loadStreamerStats(STREAMER);
    expect(stats.streamerDisplayName).toBe('Established Name');
  });
});

// ─── flushAll ───────────────────────────────────────────────────

describe('flushAll: 即時書き込み', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('5s 未経過でも flushAll で chrome.storage に書く', async () => {
    recordJudgment(STREAMER, STREAMER_NAME, { channelId: USER_A, displayName: 'Alice' }, { spoiler: 1 });
    expect(fake.store.has(storeKeyFor(STREAMER))).toBe(false);
    await flushAll();
    expect(fake.store.has(storeKeyFor(STREAMER))).toBe(true);
    expect(
      (await loadStreamerStats(STREAMER)).users[USER_A].dailyStats[
        Object.keys((await loadStreamerStats(STREAMER)).users[USER_A].dailyStats)[0]
      ].messageCount,
    ).toBe(1);
  });

  it('pending 0 件で flushAll は no-op', async () => {
    await flushAll();
    expect(fake.store.size).toBe(0);
  });
});

// ─── cached API ─────────────────────────────────────────────────

describe('cached API', () => {
  beforeEach(() => {
    installFakeChrome();
  });

  it('setCached / invalidateCachedFor: 該当ユーザーが居なければ no-op', async () => {
    await setCached(STREAMER, USER_A, null); // 居ない → no-op
    await invalidateCachedFor(STREAMER, USER_A); // 居ない → no-op
    expect(true).toBe(true); // 例外を投げないこと
  });

  it('setCached: 居るユーザーの cached を更新', async () => {
    const stats = emptyStreamerStats(STREAMER);
    stats.users[USER_A] = {
      channelId: USER_A,
      displayNameLatest: 'A',
      displayNameFirstSeen: 'A',
      firstSeenAt: 0,
      lastSeenAt: 0,
      dailyStats: {},
      cached: null,
    };
    await saveStreamerStats(stats);

    const cached: CachedStats = {
      calculatedAt: 1000,
      period: '7d',
      totalMessages: 10,
      flaggedCounts: { spoiler: 1, harassment: 0, spam: 0, offTopic: 0, backseat: 0 },
      totalFlagged: 1,
      flagLevel: 'grey',
      severityScore: 2.5,
    };
    await setCached(STREAMER, USER_A, cached);
    const loaded = await loadStreamerStats(STREAMER);
    expect(loaded.users[USER_A].cached).toEqual(cached);
  });

  it('clearAllCached: 全配信者・全ユーザーの cached を null に', async () => {
    const cached: CachedStats = {
      calculatedAt: 1,
      period: '7d',
      totalMessages: 1,
      flaggedCounts: { spoiler: 0, harassment: 0, spam: 0, offTopic: 0, backseat: 0 },
      totalFlagged: 0,
      flagLevel: 'clean',
      severityScore: 0,
    };
    for (const sid of ['UC_a', 'UC_b']) {
      const stats = emptyStreamerStats(sid);
      stats.users[USER_A] = {
        channelId: USER_A,
        displayNameLatest: 'A',
        displayNameFirstSeen: 'A',
        firstSeenAt: 0,
        lastSeenAt: 0,
        dailyStats: {},
        cached: { ...cached },
      };
      await saveStreamerStats(stats);
    }
    await clearAllCached();
    expect((await loadStreamerStats('UC_a')).users[USER_A].cached).toBeNull();
    expect((await loadStreamerStats('UC_b')).users[USER_A].cached).toBeNull();
  });
});
