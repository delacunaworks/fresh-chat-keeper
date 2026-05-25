/**
 * Phase 3.5 B3: SessionTracker のテスト。
 *
 * 検証観点（設計文書 §「セッション追跡」L286-332）:
 * - 新セッション開始で map / sessionStartTime / streamerChannelId が更新される
 * - 同一 userId への複数 record が累積（messageCount + flaggedCounts）
 * - 異なる userId の独立性
 * - `flagged = {}` でも messageCount は +1（safe メッセージの記録）
 * - 初期値 streamerChannelId === null
 * - getAllSessionStats は内部 Map のコピーを返す（mutate 保護）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionTracker } from './session-tracker.js';

describe('SessionTracker', () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
  });

  it('初期値: streamerChannelId は null、sessionStartTime は構築時刻', () => {
    const before = Date.now();
    const t = new SessionTracker();
    const after = Date.now();
    expect(t.getStreamerChannelId()).toBeNull();
    expect(t.getSessionStartTime()).toBeGreaterThanOrEqual(before);
    expect(t.getSessionStartTime()).toBeLessThanOrEqual(after);
    expect(t.getAllSessionStats().size).toBe(0);
  });

  it('startNewSession で sessionStartTime / streamerChannelId / map がリセット', () => {
    vi.useFakeTimers({ now: new Date('2026-05-24T10:00:00Z').getTime() });
    try {
      tracker.recordMessage('@viewer_a', { spoiler: 1 });
      expect(tracker.getAllSessionStats().size).toBe(1);

      vi.setSystemTime(new Date('2026-05-24T11:00:00Z').getTime());
      tracker.startNewSession('UC_new_streamer');

      expect(tracker.getStreamerChannelId()).toBe('UC_new_streamer');
      expect(tracker.getSessionStartTime()).toBe(
        new Date('2026-05-24T11:00:00Z').getTime(),
      );
      expect(tracker.getAllSessionStats().size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同一 userId への複数 record は累積', () => {
    tracker.recordMessage('@viewer_a', { spoiler: 1 });
    tracker.recordMessage('@viewer_a', { harassment: 1 });
    tracker.recordMessage('@viewer_a', {});

    const stats = tracker.getSessionStats('@viewer_a');
    expect(stats).not.toBeNull();
    expect(stats?.messageCount).toBe(3);
    expect(stats?.flaggedCounts.spoiler).toBe(1);
    expect(stats?.flaggedCounts.harassment).toBe(1);
    expect(stats?.flaggedCounts.spam).toBe(0);
  });

  it('異なる userId は独立して集計される', () => {
    tracker.recordMessage('@viewer_a', { spoiler: 1 });
    tracker.recordMessage('@viewer_b', { harassment: 1 });
    tracker.recordMessage('@viewer_a', { spoiler: 1 });

    const a = tracker.getSessionStats('@viewer_a');
    const b = tracker.getSessionStats('@viewer_b');
    expect(a?.messageCount).toBe(2);
    expect(a?.flaggedCounts.spoiler).toBe(2);
    expect(a?.flaggedCounts.harassment).toBe(0);
    expect(b?.messageCount).toBe(1);
    expect(b?.flaggedCounts.harassment).toBe(1);
    expect(b?.flaggedCounts.spoiler).toBe(0);
  });

  it('flagged={} でも messageCount は +1（safe メッセージ）', () => {
    tracker.recordMessage('@viewer_a', {});
    tracker.recordMessage('@viewer_a', {});

    const stats = tracker.getSessionStats('@viewer_a');
    expect(stats?.messageCount).toBe(2);
    expect(stats?.flaggedCounts.spoiler).toBe(0);
    expect(stats?.flaggedCounts.harassment).toBe(0);
  });

  it('未観測 userId への getSessionStats は null を返す', () => {
    expect(tracker.getSessionStats('@unknown')).toBeNull();
  });

  it('getAllSessionStats は内部 Map のコピーを返す（mutate 保護）', () => {
    tracker.recordMessage('@viewer_a', { spoiler: 1 });
    const snapshot = tracker.getAllSessionStats();
    expect(snapshot.size).toBe(1);

    // snapshot を破壊しても内部状態は不変
    snapshot.delete('@viewer_a');
    expect(tracker.getSessionStats('@viewer_a')).not.toBeNull();
    expect(tracker.getAllSessionStats().size).toBe(1);
  });

  it('flagged の負数・NaN・無限大はカウントに反映されない', () => {
    tracker.recordMessage('@viewer_a', {
      spoiler: -3 as unknown as number,
      harassment: NaN as unknown as number,
      spam: Infinity as unknown as number,
      offTopic: 2,
    });
    const stats = tracker.getSessionStats('@viewer_a');
    expect(stats?.messageCount).toBe(1);
    expect(stats?.flaggedCounts.spoiler).toBe(0);
    expect(stats?.flaggedCounts.harassment).toBe(0);
    expect(stats?.flaggedCounts.spam).toBe(0);
    expect(stats?.flaggedCounts.offTopic).toBe(2);
  });
});
