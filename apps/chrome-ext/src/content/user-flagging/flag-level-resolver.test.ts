/**
 * Phase 3.5 B4: flag-level-resolver のテスト。
 *
 * 検証観点:
 * - user 未存在 → clean、setCached 呼ばれない
 * - cached 有効（TTL 内 + period 一致）→ cached そのまま、再計算なし
 * - cached TTL 切れ → 再計算 + setCached で書き戻し
 * - cached あり TTL 内だが period 不一致（30d→7d 変更）→ 再計算
 * - session period で sessionStats が evaluator に渡る
 * - userFlagging 未設定 → clean
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveFlagLevel, CACHED_TTL_MS } from './flag-level-resolver.js';
import { SessionTracker } from './session-tracker.js';
import {
  saveStreamerStats,
  emptyStreamerStats,
  loadStreamerStats,
  setCached,
} from '../../shared/user-stats-store.js';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings.js';
import type {
  CachedStats,
  DailyStats,
  FlaggedCounts,
} from '@fresh-chat-keeper/judgment-engine';

const STREAMER = 'UC_streamer';
const USER = '@viewer';
const NOW = new Date('2026-05-25T00:00:00Z');

function installFakeChrome(): { store: Map<string, unknown> } {
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

function settingsWith(scope: '7d' | '30d' | 'session'): Settings {
  return {
    ...DEFAULT_SETTINGS,
    userFlagging: {
      ...DEFAULT_SETTINGS.userFlagging!,
      enabled: true,
      scope,
      sensitivity: { yellow: 0.2, red: 0.4 },
    },
  };
}

function daily(
  date: string,
  counts: Partial<FlaggedCounts> & { messages: number },
): DailyStats {
  const { messages, ...flagged } = counts;
  return {
    date,
    messageCount: messages,
    flaggedCounts: {
      spoiler: 0,
      harassment: 0,
      spam: 0,
      offTopic: 0,
      backseat: 0,
      ...flagged,
    },
  };
}

describe('resolveFlagLevel', () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    installFakeChrome();
    tracker = new SessionTracker();
    tracker.startNewSession(STREAMER);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('user 未存在 → clean / setCached しない / store 不変', async () => {
    const result = await resolveFlagLevel(STREAMER, USER, settingsWith('7d'), tracker, NOW);
    expect(result.level).toBe('clean');
    expect(result.totalMessages).toBe(0);
    expect(result.totalFlagged).toBe(0);
    // user が居ないので store には何も書かれない（loadStreamerStats が空構造を返す）
    const stats = await loadStreamerStats(STREAMER);
    expect(stats.users[USER]).toBeUndefined();
  });

  it('cached TTL 内 + period 一致 → cached そのまま返す（再計算なし）', async () => {
    const stats = emptyStreamerStats(STREAMER);
    stats.users[USER] = {
      channelId: USER,
      displayNameLatest: 'A',
      displayNameFirstSeen: 'A',
      firstSeenAt: 0,
      lastSeenAt: 0,
      // dailyStats は破壊的な値にしておき、cached が優先されていることを確認
      dailyStats: {
        '2026-05-25': daily('2026-05-25', { messages: 100, harassment: 50 }),
      },
      cached: {
        calculatedAt: NOW.getTime() - 60_000, // 1 分前 < 5 分
        period: '7d',
        totalMessages: 7,
        flaggedCounts: {
          spoiler: 1,
          harassment: 0,
          spam: 0,
          offTopic: 0,
          backseat: 0,
        },
        totalFlagged: 1,
        flagLevel: 'grey',
        severityScore: 2.5,
      },
    };
    await saveStreamerStats(stats);

    const result = await resolveFlagLevel(STREAMER, USER, settingsWith('7d'), tracker, NOW);
    expect(result.level).toBe('grey');
    expect(result.severityScore).toBeCloseTo(2.5, 5);
    expect(result.totalMessages).toBe(7);
    expect(result.totalFlagged).toBe(1);
    // dailyStats を見ていない証拠（さもなくば red 相当の score になるはず）
  });

  it('cached TTL 切れ → 再計算 + setCached', async () => {
    const stats = emptyStreamerStats(STREAMER);
    stats.users[USER] = {
      channelId: USER,
      displayNameLatest: 'A',
      displayNameFirstSeen: 'A',
      firstSeenAt: 0,
      lastSeenAt: 0,
      dailyStats: {
        '2026-05-25': daily('2026-05-25', { messages: 10, harassment: 3 }),
      },
      cached: {
        calculatedAt: NOW.getTime() - CACHED_TTL_MS - 1000, // 期限切れ
        period: '7d',
        totalMessages: 999, // 古い値（再計算されれば 10 に置き換わる）
        flaggedCounts: {
          spoiler: 0,
          harassment: 0,
          spam: 0,
          offTopic: 0,
          backseat: 0,
        },
        totalFlagged: 0,
        flagLevel: 'clean',
        severityScore: 0,
      },
    };
    await saveStreamerStats(stats);

    const result = await resolveFlagLevel(STREAMER, USER, settingsWith('7d'), tracker, NOW);
    // 10 messages, harassment 3 → severity=12, normalized=1.2, totalFlagged=3 → red
    expect(result.level).toBe('red');
    expect(result.totalMessages).toBe(10);
    expect(result.totalFlagged).toBe(3);

    // setCached が呼ばれたことを load し直して確認
    const after = await loadStreamerStats(STREAMER);
    expect(after.users[USER].cached?.flagLevel).toBe('red');
    expect(after.users[USER].cached?.calculatedAt).toBe(NOW.getTime());
  });

  it('cached あり TTL 内だが period 不一致（30d→7d）→ 再計算', async () => {
    const stats = emptyStreamerStats(STREAMER);
    stats.users[USER] = {
      channelId: USER,
      displayNameLatest: 'A',
      displayNameFirstSeen: 'A',
      firstSeenAt: 0,
      lastSeenAt: 0,
      dailyStats: {
        '2026-05-25': daily('2026-05-25', { messages: 10, harassment: 3 }),
      },
      cached: {
        calculatedAt: NOW.getTime() - 60_000,
        period: '30d', // 設定は 7d に変わった
        totalMessages: 50,
        flaggedCounts: {
          spoiler: 0,
          harassment: 0,
          spam: 0,
          offTopic: 0,
          backseat: 0,
        },
        totalFlagged: 0,
        flagLevel: 'clean',
        severityScore: 0,
      },
    };
    await saveStreamerStats(stats);

    const result = await resolveFlagLevel(STREAMER, USER, settingsWith('7d'), tracker, NOW);
    // 再計算されれば red
    expect(result.level).toBe('red');
    expect(result.totalMessages).toBe(10);

    // 新 cached が書き戻されている（period が '7d' に）
    const after = await loadStreamerStats(STREAMER);
    expect(after.users[USER].cached?.period).toBe('7d');
    expect(after.users[USER].cached?.flagLevel).toBe('red');
  });

  it('session period: sessionStats が evaluator に渡る（dailyStats は無視）', async () => {
    const stats = emptyStreamerStats(STREAMER);
    stats.users[USER] = {
      channelId: USER,
      displayNameLatest: 'A',
      displayNameFirstSeen: 'A',
      firstSeenAt: 0,
      lastSeenAt: 0,
      dailyStats: {
        '2026-05-25': daily('2026-05-25', { messages: 1000, harassment: 999 }),
      },
      cached: null,
    };
    await saveStreamerStats(stats);

    // session に控えめな値を仕込む
    tracker.recordMessage(USER, { spoiler: 1 });
    tracker.recordMessage(USER, {});
    tracker.recordMessage(USER, {});

    const result = await resolveFlagLevel(
      STREAMER,
      USER,
      settingsWith('session'),
      tracker,
      NOW,
    );
    // session: 3 messages / spoiler 1 → severity=2.5 / normalized=0.83 / totalFlagged=1 → grey
    expect(result.totalMessages).toBe(3);
    expect(result.totalFlagged).toBe(1);
    expect(result.level).toBe('grey');
  });

  it('userFlagging 未設定（旧 popup / 手動編集データ）→ clean / 例外を投げない', async () => {
    // B5 で型上は非 optional に進めたが、popup から書き戻された素データに
    // userFlagging が欠落しているケースの defensive 経路を保護。
    // 型システム的には Settings は userFlagging を必須にしているが、
    // ランタイムでは欠落しうるので Omit してから Settings に戻す。
    const { userFlagging: _omit, ...rest } = DEFAULT_SETTINGS;
    void _omit;
    const settingsNoFlagging = rest as unknown as Settings;

    const result = await resolveFlagLevel(STREAMER, USER, settingsNoFlagging, tracker, NOW);
    expect(result.level).toBe('clean');
  });

  it('setCached 直後の resolve は cached 経路（TTL 内）に乗る', async () => {
    const stats = emptyStreamerStats(STREAMER);
    stats.users[USER] = {
      channelId: USER,
      displayNameLatest: 'A',
      displayNameFirstSeen: 'A',
      firstSeenAt: 0,
      lastSeenAt: 0,
      dailyStats: {
        '2026-05-25': daily('2026-05-25', { messages: 10, harassment: 3 }),
      },
      cached: null,
    };
    await saveStreamerStats(stats);

    // 1 回目: 再計算 + setCached
    const first = await resolveFlagLevel(STREAMER, USER, settingsWith('7d'), tracker, NOW);
    expect(first.level).toBe('red');

    // 2 回目（1 分後）: cached 経路で同じ結果
    const second = await resolveFlagLevel(
      STREAMER,
      USER,
      settingsWith('7d'),
      tracker,
      new Date(NOW.getTime() + 60_000),
    );
    expect(second.level).toBe('red');
    expect(second.totalMessages).toBe(first.totalMessages);
  });

  it('別 cached の period とユーザー設定 scope が同じなら cached 採用', async () => {
    const cached: CachedStats = {
      calculatedAt: NOW.getTime() - 60_000,
      period: 'session',
      totalMessages: 50,
      flaggedCounts: {
        spoiler: 0,
        harassment: 0,
        spam: 0,
        offTopic: 0,
        backseat: 0,
      },
      totalFlagged: 0,
      flagLevel: 'clean',
      severityScore: 0,
    };
    const stats = emptyStreamerStats(STREAMER);
    stats.users[USER] = {
      channelId: USER,
      displayNameLatest: 'A',
      displayNameFirstSeen: 'A',
      firstSeenAt: 0,
      lastSeenAt: 0,
      dailyStats: {
        '2026-05-25': daily('2026-05-25', { messages: 5, harassment: 5 }),
      },
      cached,
    };
    await saveStreamerStats(stats);

    const result = await resolveFlagLevel(
      STREAMER,
      USER,
      settingsWith('session'),
      tracker,
      NOW,
    );
    expect(result.level).toBe('clean');
  });

  it('user 未存在のとき setCached を呼ばない（no-op で storage を汚さない）', async () => {
    // storage は空のまま
    await resolveFlagLevel(STREAMER, USER, settingsWith('7d'), tracker, NOW);
    const stats = await loadStreamerStats(STREAMER);
    expect(Object.keys(stats.users).length).toBe(0);
  });

  it('setCached API が動作して同じ値が読み戻せる（cached 書き戻しの基礎）', async () => {
    const stats = emptyStreamerStats(STREAMER);
    stats.users[USER] = {
      channelId: USER,
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
      totalMessages: 5,
      flaggedCounts: {
        spoiler: 1,
        harassment: 0,
        spam: 0,
        offTopic: 0,
        backseat: 0,
      },
      totalFlagged: 1,
      flagLevel: 'grey',
      severityScore: 2.5,
    };
    await setCached(STREAMER, USER, cached);
    expect((await loadStreamerStats(STREAMER)).users[USER].cached).toEqual(cached);
  });
});
