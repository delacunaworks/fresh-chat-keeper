/**
 * 「音声文脈（実験的）」タブ（AR-3）の純粋ヘルパーテスト。
 */

import { describe, it, expect } from 'vitest';
import { mergeAudio } from './AudioContext.js';
import type { AudioContextSettings } from '../../shared/settings.js';

describe('mergeAudio', () => {
  const current: AudioContextSettings = { enabled: false };

  it('enabled を ON に更新した Partial<Settings> を返す', () => {
    expect(mergeAudio(current, { enabled: true })).toEqual({ audioContext: { enabled: true } });
  });

  it('enabled を OFF に更新', () => {
    expect(mergeAudio({ enabled: true }, { enabled: false })).toEqual({
      audioContext: { enabled: false },
    });
  });

  it('partial 空なら現在値を保持', () => {
    expect(mergeAudio({ enabled: true }, {})).toEqual({ audioContext: { enabled: true } });
  });
});
