/**
 * Phase 3.5 B2: flag-evaluator の単体テスト。
 *
 * 検証観点（受入基準のテストカテゴリ A-G を網羅）:
 * - A. 少サンプル特別判定（totalMessages < 3 の harassment ショートカット）
 * - B. 大量サンプル全 0 → clean
 * - C. 深刻度重み計算（設計文書 L446-458 の具体例）
 * - D. 閾値ぎりぎり（normalizedScore / totalFlagged の境界条件）
 * - E. 期間別抽出（extractPeriodStats 単体・UTC 日付境界・session 経路）
 * - F. 戻り値フィールド検証（4 フィールドすべて）
 * - G. 退化ケース（全 0 dailyStats 多日 / 空 / 感度極端値 / session 未指定）
 *
 * 設計 ground truth: `dev-docs/phase-3-5-user-flagging.md` L336-427。
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateFlagLevel,
  evaluateFlagLevelsForUsers,
  extractPeriodStats,
  SEVERITY_WEIGHTS,
} from './flag-evaluator.js';
import {
  emptyFlaggedCounts,
  type DailyStats,
  type FlaggedCounts,
  type FlagEvaluationInput,
  type SessionUserStats,
  type UserStatsEntry,
} from './types.js';

// ─── ヘルパー ──────────────────────────────────────────────────────────

/** 固定 "now"（UTC）。期間抽出テストで境界を決定論的にする。 */
const NOW = new Date('2026-05-24T00:00:00Z');

const STANDARD_SENSITIVITY = { yellow: 0.2, red: 0.4 } as const;

function mockDaily(
  date: string,
  counts: Partial<FlaggedCounts> & { messages: number },
): DailyStats {
  const { messages, ...flagged } = counts;
  return {
    date,
    messageCount: messages,
    flaggedCounts: { ...emptyFlaggedCounts(), ...flagged },
  };
}

function mockStats(opts: {
  channelId?: string;
  daily?: DailyStats[];
}): UserStatsEntry {
  const dailyStats: Record<string, DailyStats> = {};
  for (const d of opts.daily ?? []) {
    dailyStats[d.date] = d;
  }
  const channelId = opts.channelId ?? '@example';
  return {
    channelId,
    displayNameLatest: 'Example',
    displayNameFirstSeen: 'Example',
    firstSeenAt: 0,
    lastSeenAt: 0,
    dailyStats,
    cached: null,
  };
}

function mockSession(counts: Partial<FlaggedCounts> & { messages: number }): SessionUserStats {
  const { messages, ...flagged } = counts;
  return {
    userId: '@example',
    messageCount: messages,
    flaggedCounts: { ...emptyFlaggedCounts(), ...flagged },
  };
}

function input(opts: Partial<FlagEvaluationInput> & { stats: UserStatsEntry }): FlagEvaluationInput {
  return {
    period: opts.period ?? '7d',
    sensitivity: opts.sensitivity ?? STANDARD_SENSITIVITY,
    stats: opts.stats,
    sessionStartTime: opts.sessionStartTime,
    sessionStats: opts.sessionStats,
  };
}

// ─── A. 少サンプル特別判定（totalMessages < 3） ──────────────────────

describe('A: 少サンプル特別判定', () => {
  it('messages=0 / harassment=0 → grey (severityScore=0)', () => {
    const result = evaluateFlagLevel(
      input({ stats: mockStats({}) }),
      NOW,
    );
    expect(result.level).toBe('grey');
    expect(result.severityScore).toBe(0);
    expect(result.totalMessages).toBe(0);
    expect(result.totalFlagged).toBe(0);
  });

  it('messages=1 / harassment=0 → grey（フラグ無いのに grey: 設計仕様。少サンプルは判定保留）', () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 1 })],
        }),
      }),
      NOW,
    );
    expect(result.level).toBe('grey');
    expect(result.totalMessages).toBe(1);
  });

  it('messages=2 / harassment=1 → yellow（severityScore=Infinity）', () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 2, harassment: 1 })],
        }),
      }),
      NOW,
    );
    expect(result.level).toBe('yellow');
    expect(result.severityScore).toBe(Number.POSITIVE_INFINITY);
    expect(result.totalFlagged).toBe(1);
  });

  it('messages=2 / harassment=2 → red（severityScore=Infinity）', () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 2, harassment: 2 })],
        }),
      }),
      NOW,
    );
    expect(result.level).toBe('red');
    expect(result.severityScore).toBe(Number.POSITIVE_INFINITY);
    expect(result.totalFlagged).toBe(2);
  });

  it('messages=2 / spoiler=2（harassment 以外） → grey（少サンプル特別判定は harassment 限定）', () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 2, spoiler: 2 })],
        }),
      }),
      NOW,
    );
    expect(result.level).toBe('grey');
    expect(result.severityScore).toBe(0);
    expect(result.totalFlagged).toBe(0);
  });

  it('messages=3 へのバウンダリ: 少サンプル経路を抜ける（通常判定）', () => {
    // 3 件 / spoiler 2 / 標準感度: severity=5, normalized≈1.67 ≥ red=0.4 かつ totalFlagged=2 < 3 → yellow
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 3, spoiler: 2 })],
        }),
      }),
      NOW,
    );
    expect(result.level).toBe('yellow');
    expect(Number.isFinite(result.severityScore)).toBe(true);
    expect(result.severityScore).toBeCloseTo(5.0, 5);
  });
});

// ─── B. 大量サンプル全 0 → clean ──────────────────────────────────────

describe('B: 大量サンプル全 0 → clean', () => {
  it('messages=100 / 全 0 → clean', () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 100 })],
        }),
      }),
      NOW,
    );
    expect(result.level).toBe('clean');
    expect(result.severityScore).toBe(0);
    expect(result.totalMessages).toBe(100);
    expect(result.totalFlagged).toBe(0);
  });

  it('messages=1000 / 全 0 → clean', () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 1000 })],
        }),
      }),
      NOW,
    );
    expect(result.level).toBe('clean');
    expect(result.severityScore).toBe(0);
    expect(result.totalFlagged).toBe(0);
  });
});

// ─── C. 深刻度重み計算 ─────────────────────────────────────────────

describe('C: 深刻度重み計算', () => {
  it('設計文書ケース1（標準感度）: messages=45 / harassment=2 / spoiler=3 → yellow', () => {
    // severity = 2*4 + 3*2.5 = 15.5, normalized = 15.5/45 ≈ 0.344
    // 標準感度 red=0.4 (届かず) / yellow=0.2 (超過、totalFlagged=5>=2) → yellow
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [
            mockDaily('2026-05-24', {
              messages: 45,
              harassment: 2,
              spoiler: 3,
            }),
          ],
        }),
      }),
      NOW,
    );
    expect(result.level).toBe('yellow');
    expect(result.severityScore).toBeCloseTo(15.5, 5);
    expect(result.totalMessages).toBe(45);
    expect(result.totalFlagged).toBe(5);
  });

  it('設計文書ケース1（厳格感度）: 同じ入力で sensitivity.red=0.2 → red', () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [
            mockDaily('2026-05-24', {
              messages: 45,
              harassment: 2,
              spoiler: 3,
            }),
          ],
        }),
        sensitivity: { yellow: 0.1, red: 0.2 },
      }),
      NOW,
    );
    expect(result.level).toBe('red');
    expect(result.severityScore).toBeCloseTo(15.5, 5);
    expect(result.totalFlagged).toBe(5);
  });

  it('harassment 単独で重みが効く（4.0）', () => {
    // 10 messages / harassment 3 → severity 12 / normalized 1.2 / totalFlagged 3 ≥ 3 → red
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 10, harassment: 3 })],
        }),
      }),
      NOW,
    );
    expect(result.severityScore).toBeCloseTo(12.0, 5);
    expect(result.level).toBe('red');
  });

  it('offTopic 単独は重み 1.0 で控えめ（同じ件数でも red になりにくい）', () => {
    // 10 messages / offTopic 3 → severity 3 / normalized 0.3 / totalFlagged 3
    // 標準感度 red=0.4 未達、yellow=0.2 超過 → yellow
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 10, offTopic: 3 })],
        }),
      }),
      NOW,
    );
    expect(result.severityScore).toBeCloseTo(3.0, 5);
    expect(result.level).toBe('yellow');
  });

  it('全カテゴリの重みが期待通り適用される（5 カテゴリ 1 件ずつ）', () => {
    // severity = 4 + 2.5 + 2 + 1.5 + 1 = 11.0
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [
            mockDaily('2026-05-24', {
              messages: 100,
              harassment: 1,
              spoiler: 1,
              backseat: 1,
              spam: 1,
              offTopic: 1,
            }),
          ],
        }),
      }),
      NOW,
    );
    expect(result.severityScore).toBeCloseTo(11.0, 5);
    expect(result.totalFlagged).toBe(5);
    expect(SEVERITY_WEIGHTS.harassment).toBe(4.0);
    expect(SEVERITY_WEIGHTS.spoiler).toBe(2.5);
    expect(SEVERITY_WEIGHTS.backseat).toBe(2.0);
    expect(SEVERITY_WEIGHTS.spam).toBe(1.5);
    expect(SEVERITY_WEIGHTS.offTopic).toBe(1.0);
  });
});

// ─── D. 閾値ぎりぎり ───────────────────────────────────────────────

describe('D: 閾値ぎりぎり', () => {
  it('normalizedScore ちょうど red 閾値（0.4）かつ totalFlagged>=3 → red', () => {
    // 10 messages, offTopic 4 → severity 4 / normalized 0.4 / totalFlagged 4
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 10, offTopic: 4 })],
        }),
      }),
      NOW,
    );
    expect(result.severityScore).toBeCloseTo(4.0, 5);
    expect(result.level).toBe('red');
  });

  it('red 相当 score だが totalFlagged=2 → yellow に degrade', () => {
    // 5 messages, harassment 1, spoiler 1 → severity 6.5 / normalized 1.3 / totalFlagged 2
    // red score 超過だが totalFlagged < 3 → yellow（yellow 閾値 0.2 超過 + flagged 2>=2）
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [
            mockDaily('2026-05-24', {
              messages: 5,
              harassment: 1,
              spoiler: 1,
            }),
          ],
        }),
      }),
      NOW,
    );
    expect(result.totalFlagged).toBe(2);
    expect(result.level).toBe('yellow');
  });

  it('yellow 相当 score だが totalFlagged=1 → grey に degrade', () => {
    // 10 messages, spoiler 1 → severity 2.5 / normalized 0.25 / totalFlagged 1
    // yellow 閾値 0.2 超過だが totalFlagged < 2 → grey（totalFlagged > 0）
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 10, spoiler: 1 })],
        }),
      }),
      NOW,
    );
    expect(result.totalFlagged).toBe(1);
    expect(result.level).toBe('grey');
  });

  it('normalizedScore が yellow 閾値ちょうど（0.2）かつ totalFlagged>=2 → yellow', () => {
    // 10 messages, offTopic 2 → severity 2 / normalized 0.2 / totalFlagged 2
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 10, offTopic: 2 })],
        }),
      }),
      NOW,
    );
    expect(result.severityScore).toBeCloseTo(2.0, 5);
    expect(result.level).toBe('yellow');
  });

  it('totalFlagged=0 → clean（severityScore=0 で yellow/red 閾値どんなに低くても）', () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 50 })],
        }),
        sensitivity: { yellow: 0, red: 0 },
      }),
      NOW,
    );
    expect(result.level).toBe('clean');
  });
});

// ─── E. 期間別抽出（extractPeriodStats 単体） ───────────────────────

describe('E: extractPeriodStats / 期間別抽出', () => {
  it('7d 期間: 直近 7 日（境界含む）のみ合算、8 日前は除外', () => {
    const stats = mockStats({
      daily: [
        mockDaily('2026-05-24', { messages: 10, spoiler: 1 }), // now
        mockDaily('2026-05-18', { messages: 5, spoiler: 1 }), // 6 日前（含む）
        mockDaily('2026-05-17', { messages: 100, spoiler: 9 }), // 7 日前（除外）
      ],
    });
    const out = extractPeriodStats(input({ stats, period: '7d' }), NOW);
    expect(out.totalMessages).toBe(15);
    expect(out.flaggedCounts.spoiler).toBe(2);
  });

  it('30d 期間: 直近 30 日（now を含む N-1 日前を最古）のみ合算、それ以前は除外', () => {
    // now=2026-05-24, 30d 窓 → 2026-04-25（29 日前、最古ぎりぎり）〜 2026-05-24
    const stats = mockStats({
      daily: [
        mockDaily('2026-05-24', { messages: 10, harassment: 1 }), // now（含む）
        mockDaily('2026-04-25', { messages: 5, harassment: 1 }), // 29 日前（含む、最古）
        mockDaily('2026-04-24', { messages: 100, harassment: 9 }), // 30 日前（除外）
        mockDaily('2026-04-23', { messages: 999, harassment: 99 }), // 31 日前（除外）
      ],
    });
    const out = extractPeriodStats(input({ stats, period: '30d' }), NOW);
    expect(out.totalMessages).toBe(15);
    expect(out.flaggedCounts.harassment).toBe(2);
  });

  it('未来日付（now より後）は除外', () => {
    const stats = mockStats({
      daily: [
        mockDaily('2026-05-24', { messages: 10 }),
        mockDaily('2026-05-25', { messages: 100, spoiler: 5 }), // now の翌日
      ],
    });
    const out = extractPeriodStats(input({ stats, period: '7d' }), NOW);
    expect(out.totalMessages).toBe(10);
    expect(out.flaggedCounts.spoiler).toBe(0);
  });

  it('全カテゴリのカウントが正しく合算される', () => {
    const stats = mockStats({
      daily: [
        mockDaily('2026-05-24', {
          messages: 10,
          spoiler: 1,
          harassment: 2,
          spam: 3,
          offTopic: 4,
          backseat: 5,
        }),
        mockDaily('2026-05-23', {
          messages: 20,
          spoiler: 10,
          harassment: 20,
          spam: 30,
          offTopic: 40,
          backseat: 50,
        }),
      ],
    });
    const out = extractPeriodStats(input({ stats, period: '7d' }), NOW);
    expect(out.totalMessages).toBe(30);
    expect(out.flaggedCounts.spoiler).toBe(11);
    expect(out.flaggedCounts.harassment).toBe(22);
    expect(out.flaggedCounts.spam).toBe(33);
    expect(out.flaggedCounts.offTopic).toBe(44);
    expect(out.flaggedCounts.backseat).toBe(55);
  });

  it("period='session' / sessionStats あり → 該当値を返す（dailyStats は無視）", () => {
    const stats = mockStats({
      daily: [
        // dailyStats は無視されるべき
        mockDaily('2026-05-24', { messages: 999, harassment: 99 }),
      ],
    });
    const out = extractPeriodStats(
      input({
        stats,
        period: 'session',
        sessionStats: mockSession({ messages: 7, backseat: 2 }),
      }),
      NOW,
    );
    expect(out.totalMessages).toBe(7);
    expect(out.flaggedCounts.backseat).toBe(2);
    expect(out.flaggedCounts.harassment).toBe(0);
  });

  it("period='session' / sessionStats 未指定 → 0 件", () => {
    const stats = mockStats({
      daily: [mockDaily('2026-05-24', { messages: 100, harassment: 5 })],
    });
    const out = extractPeriodStats(
      input({ stats, period: 'session' }),
      NOW,
    );
    expect(out.totalMessages).toBe(0);
    expect(out.flaggedCounts).toEqual(emptyFlaggedCounts());
  });

  it('UTC 日付境界: ローカル TZ に依存しない（now が UTC 0:00 直前でも）', () => {
    // 2026-05-23T23:59:59Z は UTC では 2026-05-23、JST では 2026-05-24 8:59:59。
    // UTC ベースで判定するので 2026-05-23 のデータが「now の当日」として含まれ、
    // 7d 窓は 2026-05-17（6 日前、最古）〜 2026-05-23。
    const tzNow = new Date('2026-05-23T23:59:59Z');
    const stats = mockStats({
      daily: [
        mockDaily('2026-05-23', { messages: 10, spoiler: 1 }), // now（含む）
        mockDaily('2026-05-17', { messages: 100, spoiler: 9 }), // 6 日前（含む、最古）
        mockDaily('2026-05-16', { messages: 999, spoiler: 99 }), // 7 日前（除外）
      ],
    });
    const out = extractPeriodStats(input({ stats, period: '7d' }), tzNow);
    expect(out.totalMessages).toBe(110);
    expect(out.flaggedCounts.spoiler).toBe(10);
  });
});

// ─── F. 戻り値フィールド検証 ────────────────────────────────────────

describe('F: 戻り値フィールド検証', () => {
  it('通常判定: level / severityScore / totalMessages / totalFlagged が期待値', () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [
            mockDaily('2026-05-24', { messages: 20, spoiler: 4 }),
          ],
        }),
      }),
      NOW,
    );
    // severity = 4*2.5 = 10, normalized = 0.5, totalFlagged = 4
    expect(result.severityScore).toBeCloseTo(10.0, 5);
    expect(result.totalMessages).toBe(20);
    expect(result.totalFlagged).toBe(4);
    expect(result.level).toBe('red'); // normalized 0.5 >= 0.4 かつ totalFlagged 4>=3
  });

  it('少サンプル特別判定: severityScore = Infinity になる', () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 1, harassment: 1 })],
        }),
      }),
      NOW,
    );
    expect(result.severityScore).toBe(Number.POSITIVE_INFINITY);
    expect(result.totalMessages).toBe(1);
    expect(result.totalFlagged).toBe(1);
    expect(result.level).toBe('yellow');
  });

  it('clean ケース: 全フィールド 0 / clean', () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 50 })],
        }),
      }),
      NOW,
    );
    expect(result.level).toBe('clean');
    expect(result.severityScore).toBe(0);
    expect(result.totalMessages).toBe(50);
    expect(result.totalFlagged).toBe(0);
  });
});

// ─── G. 退化ケース ─────────────────────────────────────────────────

describe('G: 退化ケース', () => {
  it('全 0 DailyStats が複数日 → clean（多日分集計でも全 0 なら clean）', () => {
    const stats = mockStats({
      daily: [
        mockDaily('2026-05-24', { messages: 30 }),
        mockDaily('2026-05-23', { messages: 20 }),
        mockDaily('2026-05-22', { messages: 10 }),
      ],
    });
    const result = evaluateFlagLevel(input({ stats }), NOW);
    expect(result.level).toBe('clean');
    expect(result.totalMessages).toBe(60);
    expect(result.totalFlagged).toBe(0);
  });

  it('空 dailyStats（観測ゼロ）→ grey（少サンプル経路）', () => {
    const result = evaluateFlagLevel(
      input({ stats: mockStats({}) }),
      NOW,
    );
    expect(result.level).toBe('grey');
    expect(result.totalMessages).toBe(0);
  });

  it('感度極端値 yellow=0 / red=0: 任意のフラグありで red（>=3 件あれば）', () => {
    // 10 messages / spam 3 → severity 4.5 / normalized 0.45, totalFlagged 3
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [mockDaily('2026-05-24', { messages: 10, spam: 3 })],
        }),
        sensitivity: { yellow: 0, red: 0 },
      }),
      NOW,
    );
    expect(result.level).toBe('red');
  });

  it('感度極端値 yellow=999 / red=999: 通常範囲では到達不能 → grey', () => {
    // 10 messages / harassment 1 / spoiler 1 → totalFlagged 2 > 0 だが score 6.5/10=0.65 << 999
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          daily: [
            mockDaily('2026-05-24', {
              messages: 10,
              harassment: 1,
              spoiler: 1,
            }),
          ],
        }),
        sensitivity: { yellow: 999, red: 999 },
      }),
      NOW,
    );
    expect(result.level).toBe('grey');
    expect(result.totalFlagged).toBe(2);
  });

  it("period='session' / sessionStats 未指定 → clean（severityScore=0, totalMessages=0 でも少サンプル経路で grey... 実は grey)", () => {
    // session で sessionStats 未指定なら 0 件 → 少サンプル経路 → grey
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({
          // dailyStats は無視されるはず
          daily: [mockDaily('2026-05-24', { messages: 1000, harassment: 99 })],
        }),
        period: 'session',
      }),
      NOW,
    );
    expect(result.level).toBe('grey');
    expect(result.totalMessages).toBe(0);
  });

  it("period='session' / sessionStats 大量 / 全 0 → clean", () => {
    const result = evaluateFlagLevel(
      input({
        stats: mockStats({}),
        period: 'session',
        sessionStats: mockSession({ messages: 100 }),
      }),
      NOW,
    );
    expect(result.level).toBe('clean');
    expect(result.totalMessages).toBe(100);
  });

  it('入力 sessionStats を破壊しない（mutate 禁止）', () => {
    const session = mockSession({ messages: 10, backseat: 2 });
    const snapshot = { ...session, flaggedCounts: { ...session.flaggedCounts } };
    extractPeriodStats(
      input({
        stats: mockStats({}),
        period: 'session',
        sessionStats: session,
      }),
      NOW,
    );
    expect(session).toEqual(snapshot);
  });

  it('入力 stats.dailyStats を破壊しない（mutate 禁止）', () => {
    const stats = mockStats({
      daily: [mockDaily('2026-05-24', { messages: 10, spoiler: 1 })],
    });
    const snapshot = JSON.parse(JSON.stringify(stats.dailyStats));
    evaluateFlagLevel(input({ stats }), NOW);
    expect(stats.dailyStats).toEqual(snapshot);
  });
});

// ─── H. evaluateFlagLevelsForUsers（B7 batch helper） ────────────────

describe('H: evaluateFlagLevelsForUsers', () => {
  it('複数 user を一括評価し、入力順を保持して level を返す', () => {
    const red = mockStats({
      channelId: '@red',
      daily: [mockDaily('2026-05-24', { messages: 10, harassment: 3 })], // severity 12 / norm 1.2 / flagged 3 → red
    });
    const clean = mockStats({
      channelId: '@clean',
      daily: [mockDaily('2026-05-24', { messages: 50 })], // flagged 0 → clean
    });
    const yellow = mockStats({
      channelId: '@yellow',
      daily: [mockDaily('2026-05-24', { messages: 45, harassment: 2, spoiler: 3 })], // norm 0.344 / flagged 5 → yellow（標準感度）
    });

    const out = evaluateFlagLevelsForUsers(
      [red, clean, yellow],
      '7d',
      STANDARD_SENSITIVITY,
      NOW,
    );

    expect(out.map((o) => o.entry.channelId)).toEqual(['@red', '@clean', '@yellow']);
    expect(out[0].result.level).toBe('red');
    expect(out[1].result.level).toBe('clean');
    expect(out[2].result.level).toBe('yellow');
  });

  it('空配列 → 空配列', () => {
    expect(evaluateFlagLevelsForUsers([], '30d', STANDARD_SENSITIVITY, NOW)).toEqual([]);
  });

  it('period によって結果が変わる（30d は古いデータも含む）', () => {
    const user = mockStats({
      channelId: '@u',
      daily: [
        mockDaily('2026-05-24', { messages: 2 }), // now: 7d/30d 両方に含む
        mockDaily('2026-05-10', { messages: 10, harassment: 3 }), // 14 日前: 30d のみ
      ],
    });

    const out7 = evaluateFlagLevelsForUsers([user], '7d', STANDARD_SENSITIVITY, NOW);
    const out30 = evaluateFlagLevelsForUsers([user], '30d', STANDARD_SENSITIVITY, NOW);

    // 7d: 2 messages のみ（少サンプル, harassment 0）→ grey
    expect(out7[0].result.level).toBe('grey');
    expect(out7[0].result.totalMessages).toBe(2);
    // 30d: 12 messages / harassment 3 → red
    expect(out30[0].result.level).toBe('red');
    expect(out30[0].result.totalMessages).toBe(12);
  });

  it('cached の読み書きをしない（純粋計算、entry.cached は不変）', () => {
    const user = mockStats({
      channelId: '@u',
      daily: [mockDaily('2026-05-24', { messages: 10, harassment: 3 })],
    });
    expect(user.cached).toBeNull();
    evaluateFlagLevelsForUsers([user], '7d', STANDARD_SENSITIVITY, NOW);
    // helper は cached を一切触らない（popup 表示専用、所有は content 側）
    expect(user.cached).toBeNull();
  });
});
