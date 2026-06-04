/**
 * Phase 5 P5-B3: createAudioContextProvider の単体テスト。
 */

import { describe, it, expect } from 'vitest';
import { createAudioContextProvider } from './factory.js';
import { YouTubeCaptionProvider } from './provider.js';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings.js';

describe('createAudioContextProvider', () => {
  const settings: Settings = { ...DEFAULT_SETTINGS };

  it('MVP は常に YouTubeCaptionProvider を返す（archive）', () => {
    const p = createAudioContextProvider(settings, 'archive');
    expect(p).toBeInstanceOf(YouTubeCaptionProvider);
    expect(p.getName()).toBe('youtube-caption');
  });

  it('MVP は常に YouTubeCaptionProvider を返す（live）', () => {
    const p = createAudioContextProvider(settings, 'live');
    expect(p).toBeInstanceOf(YouTubeCaptionProvider);
  });

  it('mode に応じた useable しきい値の provider を返す', () => {
    const live = createAudioContextProvider(settings, 'live') as YouTubeCaptionProvider;
    const archive = createAudioContextProvider(settings, 'archive') as YouTubeCaptionProvider;
    expect(live.__test__.getThreshold()).toBe(0.5);
    expect(archive.__test__.getThreshold()).toBe(0.4);
  });
});
