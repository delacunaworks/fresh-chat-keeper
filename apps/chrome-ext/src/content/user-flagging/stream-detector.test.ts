/**
 * Phase 3.5 B4: stream-detector のテスト。
 *
 * 検証観点:
 * - 初期 channelId が getChannelIdFromDom 戻り値と一致
 * - 変化検出時に sessionTracker.startNewSession が呼ばれる
 * - null → 値 遷移で startNewSession
 * - 値 → null 遷移では startNewSession を呼ばない（DOM 一時欠落で session reset 抑止）
 * - disposeStreamDetector 後は polling 停止 + 状態リセット
 * - getCurrentStreamerDisplayName が document.title から抽出
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initStreamDetector,
  getCurrentStreamerChannelId,
  getCurrentStreamerDisplayName,
  disposeStreamDetector,
  __test__,
} from './stream-detector.js';
import { SessionTracker } from './session-tracker.js';
import * as authorExtract from '../author-extract.js';

describe('stream-detector', () => {
  let tracker: SessionTracker;
  let getChannelIdSpy: ReturnType<typeof vi.spyOn>;
  let startSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tracker = new SessionTracker();
    getChannelIdSpy = vi
      .spyOn(authorExtract, 'getChannelIdFromDom')
      .mockReturnValue('');
    startSpy = vi.spyOn(tracker, 'startNewSession');
    __test__.setStateForTest(null, '');
  });

  afterEach(() => {
    disposeStreamDetector();
    getChannelIdSpy.mockRestore();
    startSpy.mockRestore();
  });

  it('初期 channelId が getChannelIdFromDom 戻り値と一致', () => {
    getChannelIdSpy.mockReturnValue('UC_first');
    initStreamDetector(tracker);
    expect(getCurrentStreamerChannelId()).toBe('UC_first');
    expect(startSpy).toHaveBeenCalledWith('UC_first');
  });

  it('null → 値 で startNewSession が呼ばれる', () => {
    // 初期は空（null）
    getChannelIdSpy.mockReturnValue('');
    initStreamDetector(tracker);
    expect(getCurrentStreamerChannelId()).toBeNull();
    expect(startSpy).not.toHaveBeenCalled();

    // DOM が利用可能になった
    getChannelIdSpy.mockReturnValue('UC_arrived');
    __test__.pollOnce();
    expect(getCurrentStreamerChannelId()).toBe('UC_arrived');
    expect(startSpy).toHaveBeenCalledWith('UC_arrived');
  });

  it('値 → 別の値 で新セッション開始', () => {
    getChannelIdSpy.mockReturnValue('UC_a');
    initStreamDetector(tracker);
    expect(startSpy).toHaveBeenLastCalledWith('UC_a');

    getChannelIdSpy.mockReturnValue('UC_b');
    __test__.pollOnce();
    expect(getCurrentStreamerChannelId()).toBe('UC_b');
    expect(startSpy).toHaveBeenLastCalledWith('UC_b');
  });

  it('値 → null（DOM 一時欠落）では startNewSession を呼ばない', () => {
    getChannelIdSpy.mockReturnValue('UC_a');
    initStreamDetector(tracker);
    startSpy.mockClear();

    getChannelIdSpy.mockReturnValue('');
    __test__.pollOnce();
    expect(getCurrentStreamerChannelId()).toBeNull();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('同じ ID が連続して取れても startNewSession は呼ばれない（変化なし）', () => {
    getChannelIdSpy.mockReturnValue('UC_a');
    initStreamDetector(tracker);
    startSpy.mockClear();

    __test__.pollOnce();
    __test__.pollOnce();
    __test__.pollOnce();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('disposeStreamDetector で polling 停止 + 状態リセット', () => {
    getChannelIdSpy.mockReturnValue('UC_a');
    initStreamDetector(tracker);
    expect(__test__.getIntervalHandle()).not.toBeNull();

    disposeStreamDetector();
    expect(__test__.getIntervalHandle()).toBeNull();
    expect(getCurrentStreamerChannelId()).toBeNull();
    expect(getCurrentStreamerDisplayName()).toBe('');
  });

  it('initStreamDetector を 2 回呼んでも interval は二重起動しない', () => {
    getChannelIdSpy.mockReturnValue('UC_a');
    initStreamDetector(tracker);
    const firstHandle = __test__.getIntervalHandle();
    initStreamDetector(tracker);
    const secondHandle = __test__.getIntervalHandle();
    expect(firstHandle).toBe(secondHandle);
  });

  it('displayName は getStreamerDisplayName helper 経由で取得される（B5 supplement）', async () => {
    // B5 で stream-detector の displayName 抽出は author-extract の
    // getStreamerDisplayName に寄せた。chat iframe context でも parent から取れる
    // よう window.parent?.document 経由になっており、node 環境では catch で空文字に
    // 倒れる。本テストでは helper を spy して期待戻り値を流し込む。
    const authorExtract = await import('../author-extract.js');
    const displayNameSpy = vi
      .spyOn(authorExtract, 'getStreamerDisplayName')
      .mockReturnValue('すごいゲーム実況');
    try {
      getChannelIdSpy.mockReturnValue('UC_a');
      initStreamDetector(tracker);
      expect(getCurrentStreamerDisplayName()).toBe('すごいゲーム実況');
    } finally {
      displayNameSpy.mockRestore();
    }
  });
});
