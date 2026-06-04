/**
 * Phase 5 P5-B3: adjustForLiveDelay の単体テスト。
 */

import { describe, it, expect } from 'vitest';
import {
  adjustForLiveDelay,
  ESTIMATED_LIVE_CAPTION_DELAY_SECONDS,
} from './live-delay.js';
import type { CaptionSegment } from '@fresh-chat-keeper/judgment-engine';

function seg(timestamp: number): CaptionSegment {
  return { text: 'テスト発話', timestamp, receivedAt: 1_700_000_000_000 };
}

describe('adjustForLiveDelay', () => {
  it('ライブ: estimatedSpeechTime = timestamp - 7（固定遅延補正）', () => {
    const out = adjustForLiveDelay(seg(100), 'live');
    expect(out.estimatedSpeechTime).toBe(100 - ESTIMATED_LIVE_CAPTION_DELAY_SECONDS);
    expect(ESTIMATED_LIVE_CAPTION_DELAY_SECONDS).toBe(7);
  });

  it('ライブ: 補正後が負なら 0 にクランプ（配信冒頭）', () => {
    const out = adjustForLiveDelay(seg(3), 'live');
    expect(out.estimatedSpeechTime).toBe(0);
  });

  it('アーカイブ: 補正なし（estimatedSpeechTime = timestamp）', () => {
    const out = adjustForLiveDelay(seg(250), 'archive');
    expect(out.estimatedSpeechTime).toBe(250);
  });

  it('入力 segment を破壊しない（純粋、他フィールド保持）', () => {
    const s = seg(120);
    const snapshot = { ...s };
    const out = adjustForLiveDelay(s, 'live');
    expect(s).toEqual(snapshot); // 入力不変
    expect(out.text).toBe('テスト発話');
    expect(out.receivedAt).toBe(s.receivedAt);
    expect(out.timestamp).toBe(120);
  });
});
