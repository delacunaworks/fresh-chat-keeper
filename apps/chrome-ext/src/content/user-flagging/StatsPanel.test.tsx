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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatsPanel, __test__ as panelTest } from './StatsPanel.js';
import { SessionTracker } from './session-tracker.js';
import type { SessionComment } from './session-comment-log.js';

const {
  flagLevelBadge,
  formatObservationRange,
  SCOPE_LABEL,
  CATEGORY_LABELS,
  SessionCommentsSection,
  formatCommentTime,
} = panelTest;

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

describe('StatsPanel: SessionCommentsSection（F-1）', () => {
  const renderSection = (comments: SessionComment[]): string =>
    renderToStaticMarkup(createElement(SessionCommentsSection, { comments }));

  it('ヘッダ・注記（端末内/非永続/最大 N 件）を表示する', () => {
    const html = renderSection([]);
    expect(html).toContain('この配信でのコメント');
    expect(html).toContain('この配信内のみ');
    expect(html).toContain('保存されません');
    expect(html).toContain('最大 100 件');
  });

  it('コメントゼロなら空メッセージ', () => {
    expect(renderSection([])).toContain('この配信でのコメントはまだありません');
  });

  it('コメントを時刻・本文つきで全表示する（通常コメントも）', () => {
    const html = renderSection([
      { text: '普通のコメント', time: new Date('2026-07-05T12:00:05').getTime() },
      { text: 'safe 判定済み', time: new Date('2026-07-05T12:00:10').getTime(), primary: 'safe' },
    ]);
    expect(html).toContain('普通のコメント');
    expect(html).toContain('safe 判定済み');
    // safe はマーカーを付けない（FCK がフィルタ/フラグしていない意）。
    expect(html).not.toContain('fck-stats-comment-mark');
  });

  it('FCK 判定（非 safe）にはカテゴリ badge を併記する', () => {
    const html = renderSection([
      { text: '一強ですやん', time: 1, primary: 'harassment' },
      { text: '次のボスは炎属性', time: 2, primary: 'spoiler' },
    ]);
    expect(html).toContain('fck-stats-comment-mark');
    expect(html).toContain('暴言');
    expect(html).toContain('ネタバレ');
  });

  it('エクスポート/コピー UI を持たない（ガードレール3・表示のみ）', () => {
    const html = renderSection([{ text: 'x', time: 1 }]);
    expect(html.toLowerCase()).not.toContain('copy');
    expect(html).not.toContain('コピー');
    expect(html).not.toContain('エクスポート');
    expect(html).not.toContain('<button');
  });
});

describe('StatsPanel: formatCommentTime（動画再生位置）', () => {
  it('1 時間未満は m:ss', () => {
    expect(formatCommentTime(0)).toBe('0:00');
    expect(formatCommentTime(7)).toBe('0:07');
    expect(formatCommentTime(3 * 60 + 7)).toBe('3:07');
    expect(formatCommentTime(59 * 60 + 59)).toBe('59:59');
  });
  it('1 時間以上は h:mm:ss', () => {
    expect(formatCommentTime(3600)).toBe('1:00:00');
    expect(formatCommentTime(3600 + 23 * 60 + 45)).toBe('1:23:45');
  });
  it('取得不能（undefined / 負 / NaN）は —', () => {
    expect(formatCommentTime(undefined)).toBe('—');
    expect(formatCommentTime(-1)).toBe('—');
    expect(formatCommentTime(Number.NaN)).toBe('—');
  });
});
