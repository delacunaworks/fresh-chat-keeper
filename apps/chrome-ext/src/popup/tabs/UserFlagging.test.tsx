/**
 * Phase 3.5 B7: UserFlagging タブの純関数 + 静的 markup テスト。
 *
 * jsdom 非導入のため、副作用ロジック（useEffect 内の chrome.storage 読み込み）は
 * テストせず、純関数（感度変換 / レベル分類 / streamer 選択 / bytes 整形 / 抽出）と
 * 「初期 markup（機能 OFF 案内）」を renderToStaticMarkup で検証する
 * （StatsPanel.test.tsx と同方針）。
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  UserFlagging,
  sensitivityFromRed,
  presetValueForRed,
  effectivePeriodForPopup,
  formatBytes,
  extractStreamerStatsFromAll,
  pickCurrentStreamer,
  groupByLevel,
  estimateUserStatsBytes,
} from './UserFlagging.js';
import { emptyStreamerStats, storeKeyFor } from '../../shared/user-stats-store.js';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings.js';
import type {
  FlagEvaluationResult,
  UserStatsEntry,
} from '@fresh-chat-keeper/judgment-engine';

function settingsWith(uf: Partial<Settings['userFlagging']>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    userFlagging: { ...DEFAULT_SETTINGS.userFlagging, ...uf },
  };
}

function entry(channelId: string): UserStatsEntry {
  return {
    channelId,
    displayNameLatest: channelId.replace('@', ''),
    displayNameFirstSeen: channelId.replace('@', ''),
    firstSeenAt: 0,
    lastSeenAt: 0,
    dailyStats: {},
    cached: null,
  };
}

function leveled(channelId: string, level: FlagEvaluationResult['level']): {
  entry: UserStatsEntry;
  result: FlagEvaluationResult;
} {
  return {
    entry: entry(channelId),
    result: { level, severityScore: 1, totalMessages: 10, totalFlagged: 2 },
  };
}

describe('UserFlagging: 純関数', () => {
  it('sensitivityFromRed: yellow は red の半分', () => {
    expect(sensitivityFromRed(0.4)).toEqual({ red: 0.4, yellow: 0.2 });
    expect(sensitivityFromRed(0.8)).toEqual({ red: 0.8, yellow: 0.4 });
    expect(sensitivityFromRed(0.2)).toEqual({ red: 0.2, yellow: 0.1 });
  });

  it('presetValueForRed: 最も近いプリセット value を返す', () => {
    expect(presetValueForRed(0.4)).toBe('0.4');
    expect(presetValueForRed(0.41)).toBe('0.4');
    expect(presetValueForRed(0.8)).toBe('0.8');
    // 0.25 は 0.2 / 0.3 と等距離 → 配列で先に出る 0.3 が優先（同距離は先勝ち）
    expect(presetValueForRed(0.25)).toBe('0.3');
    expect(presetValueForRed(0.24)).toBe('0.2'); // 0.2 寄り
  });

  it('effectivePeriodForPopup: session → 30d フォールバック、他はそのまま', () => {
    expect(effectivePeriodForPopup('session')).toBe('30d');
    expect(effectivePeriodForPopup('7d')).toBe('7d');
    expect(effectivePeriodForPopup('30d')).toBe('30d');
  });

  it('formatBytes: B / KB / MB の単位で整形', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(145408)).toBe('142 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MB');
  });

  it('extractStreamerStatsFromAll: fck_user_stats:* のみ抽出して正規化', () => {
    const all = {
      [storeKeyFor('UC_a')]: emptyStreamerStats('UC_a', 'A'),
      [storeKeyFor('UC_b')]: emptyStreamerStats('UC_b', 'B'),
      fck_settings: { enabled: true },
      fck_user_blocks: { channelIds: [] },
    };
    const out = extractStreamerStatsFromAll(all);
    expect(out.length).toBe(2);
    expect(out.map((s) => s.streamerChannelId).sort()).toEqual(['UC_a', 'UC_b']);
  });

  it('pickCurrentStreamer: lastUpdated 最新を返す / 空なら null', () => {
    expect(pickCurrentStreamer([])).toBeNull();
    const a = { ...emptyStreamerStats('UC_a', 'A'), lastUpdated: 100 };
    const b = { ...emptyStreamerStats('UC_b', 'B'), lastUpdated: 999 };
    const c = { ...emptyStreamerStats('UC_c', 'C'), lastUpdated: 500 };
    expect(pickCurrentStreamer([a, b, c])?.streamerChannelId).toBe('UC_b');
  });

  it('groupByLevel: red / yellow のみ抽出（clean / grey は除外）', () => {
    const result = groupByLevel([
      leveled('@r1', 'red'),
      leveled('@y1', 'yellow'),
      leveled('@c1', 'clean'),
      leveled('@g1', 'grey'),
      leveled('@r2', 'red'),
    ]);
    expect(result.red.map((l) => l.entry.channelId)).toEqual(['@r1', '@r2']);
    expect(result.yellow.map((l) => l.entry.channelId)).toEqual(['@y1']);
  });

  it('estimateUserStatsBytes: fck_user_stats:* のみ集計', () => {
    const all = {
      [storeKeyFor('UC_a')]: emptyStreamerStats('UC_a', 'A'),
      fck_settings: { enabled: true, big: 'x'.repeat(10000) },
    };
    const bytes = estimateUserStatsBytes(all);
    // fck_settings の 10KB は含まれない（fck_user_stats: のみ）
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1000);
  });
});

describe('UserFlagging: 機能 OFF 時の markup', () => {
  it('enabled=false → オプトイン案内 + 有効化トグルのみ（配信サマリ非表示）', () => {
    const html = renderToStaticMarkup(
      <UserFlagging settings={settingsWith({ enabled: false })} onUpdate={() => undefined} />,
    );
    expect(html).toContain('初期状態では OFF');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="視聴者フラグ機能を有効化"');
    // 配信サマリ・ストレージセクションは出ない
    expect(html).not.toContain('ストレージ使用量');
    expect(html).not.toContain('一括ブロック');
  });
});

describe('UserFlagging: 一括ブロック対象は red のみ', () => {
  it('groupByLevel の red のみが一括ブロック対象（yellow は含まれない）', () => {
    const grouped = groupByLevel([
      leveled('@r1', 'red'),
      leveled('@y1', 'yellow'),
      leveled('@y2', 'yellow'),
    ]);
    // 一括ブロックは grouped.red を対象にする実装なので、red の件数のみ
    expect(grouped.red.length).toBe(1);
    // yellow は対象外
    expect(grouped.red.some((l) => l.result.level === 'yellow')).toBe(false);
  });
});
