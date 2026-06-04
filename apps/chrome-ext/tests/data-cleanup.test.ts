/**
 * Phase 3.5 B8: data-cleanup の単体テスト。
 *
 * 純粋関数（pruneStreamerStats / enforceUserLimit / selectStreamerKeysToEvict）を
 * 中心に検証し、chrome glue（runUserStatsCleanup）は chrome.storage の fake +
 * now 固定で最小限カバーする。cutoff は judgment-engine の formatDateKey / addDays
 * で計算（B3 supplement、UTC 日付の単一の真実）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  pruneStreamerStats,
  enforceUserLimit,
  selectStreamerKeysToEvict,
  runUserStatsCleanup,
  MAX_STREAMERS_TRACKED,
  MAX_USERS_PER_STREAMER,
} from '../src/background/data-cleanup.js';
import {
  storeKeyFor,
  USER_STATS_PREFIX,
  type StreamerScopedUserStats,
} from '../src/shared/user-stats-store.js';
import { DEFAULT_SETTINGS, STORAGE_KEY, type Settings } from '../src/shared/settings.js';
import { formatDateKey, addDays } from '@fresh-chat-keeper/judgment-engine';
import type { DailyStats, FlaggedCounts, UserStatsEntry } from '@fresh-chat-keeper/judgment-engine';

const NOW = new Date('2026-05-24T00:00:00Z');

function fc(p: Partial<FlaggedCounts> = {}): FlaggedCounts {
  return { spoiler: 0, harassment: 0, spam: 0, offTopic: 0, backseat: 0, ...p };
}

function daily(date: string, messages = 5, flagged: Partial<FlaggedCounts> = {}): DailyStats {
  return { date, messageCount: messages, flaggedCounts: fc(flagged) };
}

function entry(opts: {
  channelId: string;
  lastSeenAt?: number;
  daily?: DailyStats[];
  cached?: UserStatsEntry['cached'];
}): UserStatsEntry {
  const dailyStats: Record<string, DailyStats> = {};
  for (const d of opts.daily ?? []) dailyStats[d.date] = d;
  return {
    channelId: opts.channelId,
    displayNameLatest: opts.channelId.replace('@', ''),
    displayNameFirstSeen: opts.channelId.replace('@', ''),
    firstSeenAt: 0,
    lastSeenAt: opts.lastSeenAt ?? 0,
    dailyStats,
    cached: opts.cached ?? null,
  };
}

function streamer(opts: {
  id?: string;
  lastUpdated?: number;
  users: UserStatsEntry[];
}): StreamerScopedUserStats {
  const users: Record<string, UserStatsEntry> = {};
  for (const u of opts.users) users[u.channelId] = u;
  return {
    streamerChannelId: opts.id ?? 'UC_s',
    streamerDisplayName: 'Streamer',
    lastUpdated: opts.lastUpdated ?? 0,
    users,
  };
}

// ─── pruneStreamerStats ─────────────────────────────────────────────

describe('pruneStreamerStats', () => {
  const cutoff = '2026-05-18'; // 7d 窓の最古日（now=05-24, N=7 → 05-18）

  it('cutoff 未満の dailyStats が削除され、cutoff 以降は残る', () => {
    const stats = streamer({
      users: [
        entry({
          channelId: '@u',
          daily: [
            daily('2026-05-24', 5, { spoiler: 1 }), // 残る
            daily('2026-05-18', 3), // cutoff ちょうど → 残る
            daily('2026-05-17', 9), // cutoff 未満 → 削除
            daily('2026-05-01', 100), // 削除
          ],
        }),
      ],
    });
    const { cleaned, modified } = pruneStreamerStats(stats, cutoff);
    expect(modified).toBe(true);
    const days = Object.keys(cleaned.users['@u'].dailyStats).sort();
    expect(days).toEqual(['2026-05-18', '2026-05-24']);
  });

  it('全 dailyStats が削除された user entry 自体が消える', () => {
    const stats = streamer({
      users: [
        entry({ channelId: '@old', daily: [daily('2026-05-01', 10)] }), // 全削除 → entry 消滅
        entry({ channelId: '@new', daily: [daily('2026-05-24', 5)] }), // 残る
      ],
    });
    const { cleaned, modified } = pruneStreamerStats(stats, cutoff);
    expect(modified).toBe(true);
    expect(cleaned.users['@old']).toBeUndefined();
    expect(cleaned.users['@new']).toBeDefined();
  });

  it('変更なしなら modified=false / 同一参照を返す', () => {
    const stats = streamer({
      users: [entry({ channelId: '@u', daily: [daily('2026-05-24', 5)] })],
    });
    const { cleaned, modified } = pruneStreamerStats(stats, cutoff);
    expect(modified).toBe(false);
    expect(cleaned).toBe(stats);
  });

  it('dailyStats を削った user は cached が無効化される', () => {
    const stats = streamer({
      users: [
        entry({
          channelId: '@u',
          daily: [daily('2026-05-24', 5), daily('2026-05-01', 100)],
          cached: {
            calculatedAt: 1,
            period: '7d',
            totalMessages: 105,
            flaggedCounts: fc(),
            totalFlagged: 0,
            flagLevel: 'clean',
            severityScore: 0,
          },
        }),
      ],
    });
    const { cleaned } = pruneStreamerStats(stats, cutoff);
    expect(cleaned.users['@u'].cached).toBeNull();
  });

  it('空スコープでも壊れない（modified=false）', () => {
    const stats = streamer({ users: [] });
    const { cleaned, modified } = pruneStreamerStats(stats, cutoff);
    expect(modified).toBe(false);
    expect(cleaned.users).toEqual({});
  });

  it('入力 stats を破壊しない（純粋）', () => {
    const stats = streamer({
      users: [entry({ channelId: '@u', daily: [daily('2026-05-24', 5), daily('2026-05-01', 1)] })],
    });
    const snapshot = JSON.parse(JSON.stringify(stats));
    pruneStreamerStats(stats, cutoff);
    expect(stats).toEqual(snapshot);
  });
});

// ─── enforceUserLimit ───────────────────────────────────────────────

describe('enforceUserLimit', () => {
  it('maxUsers 超過時に lastSeenAt 降順で上位のみ残す', () => {
    const stats = streamer({
      users: [
        entry({ channelId: '@a', lastSeenAt: 100 }),
        entry({ channelId: '@b', lastSeenAt: 300 }),
        entry({ channelId: '@c', lastSeenAt: 200 }),
      ],
    });
    const { cleaned, modified } = enforceUserLimit(stats, 2);
    expect(modified).toBe(true);
    expect(Object.keys(cleaned.users).sort()).toEqual(['@b', '@c']); // 100 の @a が落ちる
  });

  it('上限以下なら modified=false / 同一参照', () => {
    const stats = streamer({
      users: [entry({ channelId: '@a', lastSeenAt: 1 }), entry({ channelId: '@b', lastSeenAt: 2 })],
    });
    const { cleaned, modified } = enforceUserLimit(stats, 2);
    expect(modified).toBe(false);
    expect(cleaned).toBe(stats);
  });

  it('同数 lastSeenAt は入力順で安定（先のものが残る）', () => {
    const stats = streamer({
      users: [
        entry({ channelId: '@first', lastSeenAt: 50 }),
        entry({ channelId: '@second', lastSeenAt: 50 }),
        entry({ channelId: '@third', lastSeenAt: 50 }),
      ],
    });
    const { cleaned } = enforceUserLimit(stats, 2);
    expect(Object.keys(cleaned.users)).toEqual(['@first', '@second']);
  });
});

// ─── selectStreamerKeysToEvict ──────────────────────────────────────

describe('selectStreamerKeysToEvict', () => {
  it('maxStreamers 超過時に lastUpdated 古い順に削除キーを返す', () => {
    const evict = selectStreamerKeysToEvict(
      [
        { key: 'k_a', lastUpdated: 100 },
        { key: 'k_b', lastUpdated: 300 },
        { key: 'k_c', lastUpdated: 200 },
      ],
      2,
    );
    // 上位 2 (k_b 300, k_c 200) を残し、k_a (100) を削除
    expect(evict).toEqual(['k_a']);
  });

  it('上限以下なら空配列', () => {
    expect(
      selectStreamerKeysToEvict(
        [
          { key: 'k_a', lastUpdated: 1 },
          { key: 'k_b', lastUpdated: 2 },
        ],
        5,
      ),
    ).toEqual([]);
  });

  it('同数 lastUpdated は入力順で安定（先のものが残る）', () => {
    const evict = selectStreamerKeysToEvict(
      [
        { key: 'k1', lastUpdated: 10 },
        { key: 'k2', lastUpdated: 10 },
        { key: 'k3', lastUpdated: 10 },
      ],
      1,
    );
    // k1 が残り、k2 / k3 が削除対象
    expect(evict).toEqual(['k2', 'k3']);
  });
});

// ─── runUserStatsCleanup（chrome.storage fake） ─────────────────────

interface FakeStorage {
  store: Map<string, unknown>;
  setCalls: number;
  removeCalls: number;
}

function installFakeChrome(seed: Record<string, unknown>): FakeStorage {
  const store = new Map<string, unknown>(Object.entries(seed));
  const state: FakeStorage = { store, setCalls: 0, removeCalls: 0 };
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
          state.setCalls += 1;
          for (const [k, v] of Object.entries(entries)) store.set(k, v);
        },
        remove: async (key: string | string[]) => {
          state.removeCalls += 1;
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) store.delete(k);
        },
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return state;
}

function storedSettings(uf: Partial<Settings['userFlagging']>): unknown {
  // 現行スキーマ世代（v5）で seed する。旧 version だと loadSettings が
  // マイグレーション書き込みを起こし、「set 呼ばれない」系アサーションが壊れる
  // （P5-B4b で CURRENT_SETTINGS_VERSION が 4→5 に上がったため）。
  return {
    ...DEFAULT_SETTINGS,
    version: 5,
    userFlagging: { ...DEFAULT_SETTINGS.userFlagging, ...uf },
  };
}

describe('runUserStatsCleanup', () => {
  beforeEach(() => {
    // 各テストで installFakeChrome を呼ぶ
  });

  it('userFlagging.enabled=false → no-op（set / remove 呼ばれない）', async () => {
    const fake = installFakeChrome({
      [STORAGE_KEY]: storedSettings({ enabled: false }),
      [storeKeyFor('UC_a')]: streamer({
        id: 'UC_a',
        users: [entry({ channelId: '@u', daily: [daily('2026-05-01', 100)] })],
      }),
    });
    await runUserStatsCleanup(NOW);
    expect(fake.setCalls).toBe(0);
    expect(fake.removeCalls).toBe(0);
  });

  it('enabled=true / 30d: cutoff 未満の古い dailyStats が消える', async () => {
    const fake = installFakeChrome({
      [STORAGE_KEY]: storedSettings({ enabled: true, scope: '30d' }),
      [storeKeyFor('UC_a')]: streamer({
        id: 'UC_a',
        lastUpdated: 1000,
        users: [
          entry({
            channelId: '@u',
            lastSeenAt: 1000,
            daily: [daily('2026-05-24', 5), daily('2026-04-01', 99)], // 04-01 は 30d 窓外
          }),
        ],
      }),
    });
    await runUserStatsCleanup(NOW);
    const saved = fake.store.get(storeKeyFor('UC_a')) as StreamerScopedUserStats;
    const days = Object.keys(saved.users['@u'].dailyStats);
    expect(days).toEqual(['2026-05-24']); // 04-01 が消える
  });

  it('retentionDays が scope に応じて 7/30 で切り替わる', async () => {
    // 2026-05-18 のデータ: 7d 窓では最古日ちょうど（残る）、だが
    // 2026-05-15 は 7d 窓外（消える）/ 30d 窓内（残る）
    const seed = {
      [storeKeyFor('UC_a')]: streamer({
        id: 'UC_a',
        lastUpdated: 1,
        users: [
          entry({
            channelId: '@u',
            lastSeenAt: 1,
            daily: [daily('2026-05-24', 5), daily('2026-05-15', 9)],
          }),
        ],
      }),
    };

    // 7d: 05-15 は窓外 → 消える
    const fake7 = installFakeChrome({
      [STORAGE_KEY]: storedSettings({ enabled: true, scope: '7d' }),
      ...seed,
    });
    await runUserStatsCleanup(NOW);
    const saved7 = fake7.store.get(storeKeyFor('UC_a')) as StreamerScopedUserStats;
    expect(Object.keys(saved7.users['@u'].dailyStats)).toEqual(['2026-05-24']);

    // 30d: 05-15 は窓内 → 残る（cutoff = 04-25）
    const fake30 = installFakeChrome({
      [STORAGE_KEY]: storedSettings({ enabled: true, scope: '30d' }),
      ...seed,
    });
    await runUserStatsCleanup(NOW);
    const saved30 = fake30.store.get(storeKeyFor('UC_a')) as StreamerScopedUserStats;
    expect(Object.keys(saved30.users['@u'].dailyStats).sort()).toEqual([
      '2026-05-15',
      '2026-05-24',
    ]);

    // cutoff 計算の sanity（30d 窓最古日 = now の 29 日前）
    expect(formatDateKey(addDays(NOW, -29))).toBe('2026-04-25');
  });

  it('配信者数上限超過分が remove される（古い順）', async () => {
    const seed: Record<string, unknown> = {
      [STORAGE_KEY]: storedSettings({ enabled: true, scope: '30d' }),
    };
    // MAX_STREAMERS_TRACKED + 2 件作る（lastUpdated を昇順 i にして古い 2 件が evict）
    const total = MAX_STREAMERS_TRACKED + 2;
    for (let i = 0; i < total; i++) {
      seed[storeKeyFor(`UC_${i}`)] = streamer({
        id: `UC_${i}`,
        lastUpdated: i, // i=0,1 が最古
        users: [entry({ channelId: '@u', lastSeenAt: i, daily: [daily('2026-05-24', 5)] })],
      });
    }
    const fake = installFakeChrome(seed);
    await runUserStatsCleanup(NOW);

    // 最古 2 件（UC_0, UC_1）が消えている
    expect(fake.store.has(storeKeyFor('UC_0'))).toBe(false);
    expect(fake.store.has(storeKeyFor('UC_1'))).toBe(false);
    // 残りは存在
    expect(fake.store.has(storeKeyFor('UC_2'))).toBe(true);
    expect(fake.store.has(storeKeyFor(`UC_${total - 1}`))).toBe(true);
    // 残った fck_user_stats:* は MAX 件
    const remaining = [...fake.store.keys()].filter((k) => k.startsWith(USER_STATS_PREFIX));
    expect(remaining.length).toBe(MAX_STREAMERS_TRACKED);
  });

  it('ユーザー数上限超過分が削られる（MAX_USERS_PER_STREAMER）', async () => {
    const users: UserStatsEntry[] = [];
    const over = MAX_USERS_PER_STREAMER + 5;
    for (let i = 0; i < over; i++) {
      users.push(entry({ channelId: `@u${i}`, lastSeenAt: i, daily: [daily('2026-05-24', 5)] }));
    }
    const fake = installFakeChrome({
      [STORAGE_KEY]: storedSettings({ enabled: true, scope: '30d' }),
      [storeKeyFor('UC_a')]: streamer({ id: 'UC_a', lastUpdated: 1, users }),
    });
    await runUserStatsCleanup(NOW);
    const saved = fake.store.get(storeKeyFor('UC_a')) as StreamerScopedUserStats;
    expect(Object.keys(saved.users).length).toBe(MAX_USERS_PER_STREAMER);
    // lastSeenAt 最大（@u{over-1}）は残り、最小（@u0）は消える
    expect(saved.users[`@u${over - 1}`]).toBeDefined();
    expect(saved.users['@u0']).toBeUndefined();
  });

  it('fck_user_stats:* が無ければ no-op（set 呼ばれない）', async () => {
    const fake = installFakeChrome({
      [STORAGE_KEY]: storedSettings({ enabled: true, scope: '30d' }),
    });
    await runUserStatsCleanup(NOW);
    expect(fake.setCalls).toBe(0);
    expect(fake.removeCalls).toBe(0);
  });

  it('変更不要なスコープは save されない（set 呼ばれない）', async () => {
    const fake = installFakeChrome({
      [STORAGE_KEY]: storedSettings({ enabled: true, scope: '30d' }),
      [storeKeyFor('UC_a')]: streamer({
        id: 'UC_a',
        lastUpdated: 1,
        users: [entry({ channelId: '@u', lastSeenAt: 1, daily: [daily('2026-05-24', 5)] })],
      }),
    });
    await runUserStatsCleanup(NOW);
    expect(fake.setCalls).toBe(0); // 全部新しいデータなのでプルーニング不要
  });
});
