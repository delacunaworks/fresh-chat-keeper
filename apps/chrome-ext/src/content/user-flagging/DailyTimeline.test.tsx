/**
 * Phase 3.5 B6: DailyTimeline の単体テスト。
 *
 * jsdom 非導入のため React コンポーネントは renderToStaticMarkup で HTML を
 * 生成して文字列マッチで検証する（collection-consent-modal.test.tsx と同方針）。
 * 純関数（classify / mondayIndex / utcDateKey）は直接呼んで境界条件を保護する。
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DailyTimeline, __test__ } from './DailyTimeline.js';
import type { DailyStats, FlaggedCounts } from '@fresh-chat-keeper/judgment-engine';

const { classify, mondayIndex, utcDateKey } = __test__;

function fc(p: Partial<FlaggedCounts> = {}): FlaggedCounts {
  return {
    spoiler: 0,
    harassment: 0,
    spam: 0,
    offTopic: 0,
    backseat: 0,
    ...p,
  };
}

function daily(date: string, messages: number, flagged: Partial<FlaggedCounts> = {}): DailyStats {
  return { date, messageCount: messages, flaggedCounts: fc(flagged) };
}

describe('DailyTimeline: pure helpers', () => {
  it('mondayIndex: Monday=0, Sunday=6（UTC ベース）', () => {
    expect(mondayIndex(new Date('2026-05-25T00:00:00Z'))).toBe(0); // Mon
    expect(mondayIndex(new Date('2026-05-26T00:00:00Z'))).toBe(1); // Tue
    expect(mondayIndex(new Date('2026-05-31T00:00:00Z'))).toBe(6); // Sun
  });

  it('utcDateKey: UTC ベースで YYYY-MM-DD', () => {
    expect(utcDateKey(new Date('2026-05-24T23:59:59Z'))).toBe('2026-05-24');
    expect(utcDateKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
  });

  it('classify: empty / clean / low / high の境界', () => {
    expect(classify(undefined)).toBe('empty');
    expect(classify(daily('2026-05-24', 10))).toBe('clean');
    // ratio < 0.2 → low
    expect(classify(daily('2026-05-24', 100, { spoiler: 10 }))).toBe('low');
    // ratio >= 0.2 → high
    expect(classify(daily('2026-05-24', 10, { harassment: 2 }))).toBe('high');
    // 観測 0 でも flag があれば 0/0 → ratio = 0 だが flagged > 0 → low/high の境界処理
    // 設計上 messageCount > 0 のときのみ ratio 計算、それ以外は flagged=0 を前提
  });
});

describe('DailyTimeline: render', () => {
  it('3 行 21 セル + 曜日ヘッダ + row label が描画される', () => {
    const html = renderToStaticMarkup(
      <DailyTimeline dailyStats={{}} now={new Date('2026-05-27T00:00:00Z')} />,
    );
    expect(html).toContain('role="table"');
    // 7 曜日
    for (const dow of ['月', '火', '水', '木', '金', '土', '日']) {
      expect(html).toContain(`>${dow}<`);
    }
    // 3 週ラベル
    expect(html).toContain('先々週');
    expect(html).toContain('先週');
    expect(html).toContain('今週');
  });

  it('観測ありのフラグなし日は fck-daily-clean クラス', () => {
    const now = new Date('2026-05-27T00:00:00Z'); // 水曜
    const html = renderToStaticMarkup(
      <DailyTimeline
        dailyStats={{
          '2026-05-25': daily('2026-05-25', 20), // 今週の月曜、フラグ 0
        }}
        now={now}
      />,
    );
    expect(html).toContain('fck-daily-clean');
  });

  it('フラグ比率 >= 20% の日は fck-daily-high', () => {
    const now = new Date('2026-05-27T00:00:00Z');
    const html = renderToStaticMarkup(
      <DailyTimeline
        dailyStats={{
          '2026-05-26': daily('2026-05-26', 10, { harassment: 3 }), // ratio 30% → high
        }}
        now={now}
      />,
    );
    expect(html).toContain('fck-daily-high');
  });

  it('フラグ比率 < 20% の日は fck-daily-low', () => {
    const now = new Date('2026-05-27T00:00:00Z');
    const html = renderToStaticMarkup(
      <DailyTimeline
        dailyStats={{
          '2026-05-26': daily('2026-05-26', 100, { spoiler: 5 }), // ratio 5% → low
        }}
        now={now}
      />,
    );
    expect(html).toContain('fck-daily-low');
  });

  it('観測なしの日は fck-daily-empty', () => {
    const html = renderToStaticMarkup(
      <DailyTimeline dailyStats={{}} now={new Date('2026-05-27T00:00:00Z')} />,
    );
    expect(html).toContain('fck-daily-empty');
  });

  it('セルの title 属性に観測情報が入る', () => {
    const now = new Date('2026-05-27T00:00:00Z');
    const html = renderToStaticMarkup(
      <DailyTimeline
        dailyStats={{
          '2026-05-26': daily('2026-05-26', 7, { spoiler: 1 }),
        }}
        now={now}
      />,
    );
    expect(html).toContain('2026-05-26: 7 msgs, 1 flagged');
    expect(html).toContain('2026-05-27: 観測なし');
  });
});
