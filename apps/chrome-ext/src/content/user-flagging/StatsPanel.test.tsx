/**
 * Phase 3.5 B6: StatsPanel の純関数 / 静的 markup テスト。
 *
 * jsdom 非導入のため、副作用ロジック（useEffect 内の loadStreamerStats /
 * resolveFlagLevel）はテストせず、純関数（flagLevelBadge /
 * formatObservationRange）と「初期表示の static markup に必要な要素が含まれるか」を
 * collection-consent-modal.test.tsx と同方針で renderToStaticMarkup により検証。
 *
 * ボタン挙動（onClose / blockUser / clearUserStatsFor）は副作用ありの
 * useEffect / event handler 経由のため、user-stats-store と stats-panel-entry の
 * 単体テストで API 動作を保護することで担保する。
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatsPanel, __test__ as panelTest } from './StatsPanel.js';
import { SessionTracker } from './session-tracker.js';

const { flagLevelBadge, formatObservationRange, SCOPE_LABEL, CATEGORY_LABELS } = panelTest;

describe('StatsPanel: 純関数', () => {
  it('flagLevelBadge: 各 level に対応するテキストとクラス', () => {
    expect(flagLevelBadge('red').cls).toContain('red');
    expect(flagLevelBadge('yellow').cls).toContain('yellow');
    expect(flagLevelBadge('grey').cls).toContain('grey');
    expect(flagLevelBadge('clean').cls).toContain('clean');
    expect(flagLevelBadge('red').text).toContain('🔴');
    expect(flagLevelBadge('clean').text).toContain('問題なし');
  });

  it('formatObservationRange: firstSeenAt / lastSeenAt → "YYYY-MM-DD 〜 YYYY-MM-DD"', () => {
    const result = formatObservationRange({
      channelId: '@a',
      displayNameLatest: 'A',
      displayNameFirstSeen: 'A',
      firstSeenAt: new Date('2026-05-20T00:00:00Z').getTime(),
      lastSeenAt: new Date('2026-05-25T00:00:00Z').getTime(),
      dailyStats: {},
      cached: null,
    });
    expect(result).toBe('2026-05-20 〜 2026-05-25');
  });

  it('formatObservationRange: 0 のときは "観測情報なし"', () => {
    const result = formatObservationRange({
      channelId: '@a',
      displayNameLatest: 'A',
      displayNameFirstSeen: 'A',
      firstSeenAt: 0,
      lastSeenAt: 0,
      dailyStats: {},
      cached: null,
    });
    expect(result).toBe('観測情報なし');
  });

  it('SCOPE_LABEL: session / 7d / 30d それぞれ日本語ラベルあり', () => {
    expect(SCOPE_LABEL.session).toContain('セッション');
    expect(SCOPE_LABEL['7d']).toContain('7');
    expect(SCOPE_LABEL['30d']).toContain('30');
  });

  it('CATEGORY_LABELS: 5 カテゴリすべて含む（harassment / spoiler / backseat / spam / offTopic）', () => {
    const keys = CATEGORY_LABELS.map(([k]) => k);
    expect(keys).toEqual(
      expect.arrayContaining(['harassment', 'spoiler', 'backseat', 'spam', 'offTopic']),
    );
    expect(keys.length).toBe(5);
  });
});

describe('StatsPanel: 初期 markup（loading 状態）', () => {
  it('header / close ボタン / footer のブロック・リセットボタンが描画される', () => {
    const tracker = new SessionTracker();
    // 注意: useEffect は renderToStaticMarkup では発火しないので、
    // loading=true のままの初期表示を検証する（chrome.storage stub も不要）
    const html = renderToStaticMarkup(
      <StatsPanel
        streamerChannelId="UC_x"
        userChannelId="@viewer"
        userDisplayName="@viewer"
        sessionTracker={tracker}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="fck-stats-panel-title"');
    expect(html).toContain('@viewer'); // title
    expect(html).toContain('aria-label="閉じる"'); // × ボタン
    expect(html).toContain('🚫 ブロック');
    expect(html).toContain('🗑️ この人の統計をリセット');
    expect(html).toContain('読み込み中');
  });

  it('overlay は role="presentation"、panel は role="dialog"', () => {
    const tracker = new SessionTracker();
    const html = renderToStaticMarkup(
      <StatsPanel
        streamerChannelId="UC_x"
        userChannelId="@viewer"
        userDisplayName="@viewer"
        sessionTracker={tracker}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('role="presentation"');
    expect(html).toContain('class="fck-stats-overlay"');
    expect(html).toContain('class="fck-stats-panel"');
  });
});
