/**
 * Phase 5 P5-B5: CaptionContext タブの純関数 + 静的 markup テスト。
 *
 * jsdom 非導入のため、純関数（mergeCaption / parseWindowSeconds / 選択肢配列）と
 * renderToStaticMarkup による状態別 markup を検証する（UserFlagging.test.tsx 同方針）。
 * クリックイベントの発火は DOM 環境が要るためテストせず、ハンドラが通す純粋な
 * マージ（mergeCaption）を直接検証することで「選択 → 正しい captionContext が
 * onUpdate に渡る」ことを担保する。
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CaptionContext,
  mergeCaption,
  parseWindowSeconds,
  WINDOW_OPTIONS,
  QUALITY_OPTIONS,
} from './CaptionContext.js';
import { DEFAULT_SETTINGS, type Settings, type CaptionContextSettings } from '../../shared/settings.js';

function settingsWith(cc: Partial<CaptionContextSettings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    captionContext: { ...DEFAULT_SETTINGS.captionContext, ...cc },
  };
}

describe('CaptionContext: 純関数', () => {
  it('mergeCaption: current に partial を重ねて Partial<Settings> を作る', () => {
    const current: CaptionContextSettings = {
      enabled: false,
      windowSeconds: 60,
      qualityThreshold: 'standard',
    };
    expect(mergeCaption(current, { enabled: true })).toEqual({
      captionContext: { enabled: true, windowSeconds: 60, qualityThreshold: 'standard' },
    });
    expect(mergeCaption(current, { windowSeconds: 120 })).toEqual({
      captionContext: { enabled: false, windowSeconds: 120, qualityThreshold: 'standard' },
    });
    expect(mergeCaption(current, { qualityThreshold: 'strict' })).toEqual({
      captionContext: { enabled: false, windowSeconds: 60, qualityThreshold: 'strict' },
    });
  });

  it('mergeCaption: 元オブジェクトを変更しない（純粋）', () => {
    const current: CaptionContextSettings = {
      enabled: false,
      windowSeconds: 30,
      qualityThreshold: 'loose',
    };
    mergeCaption(current, { enabled: true });
    expect(current.enabled).toBe(false);
  });

  it('parseWindowSeconds: 30/60/120 を narrowing、不正値は 60 にフォールバック', () => {
    expect(parseWindowSeconds('30')).toBe(30);
    expect(parseWindowSeconds('60')).toBe(60);
    expect(parseWindowSeconds('120')).toBe(120);
    expect(parseWindowSeconds('999')).toBe(60);
    expect(parseWindowSeconds('abc')).toBe(60);
  });

  it('選択肢配列: 窓長 3 件（60 が推奨表記）/ 品質 3 件', () => {
    expect(WINDOW_OPTIONS.map((o) => o.value)).toEqual(['30', '60', '120']);
    expect(WINDOW_OPTIONS.find((o) => o.value === '60')?.label).toContain('推奨');
    expect(QUALITY_OPTIONS.map((o) => o.value)).toEqual(['loose', 'standard', 'strict']);
  });
});

describe('CaptionContext: markup', () => {
  it('enabled=false → オプトイン案内 + 窓長/しきい値は薄く操作不可', () => {
    const html = renderToStaticMarkup(
      <CaptionContext settings={settingsWith({ enabled: false })} onUpdate={() => undefined} />,
    );
    expect(html).toContain('初期状態では OFF');
    expect(html).toContain('aria-label="字幕連動を有効化"');
    expect(html).toContain('aria-checked="false"');
    // 窓長/しきい値ブロックは dim + pointer-events-none で操作不可
    expect(html).toContain('pointer-events-none');
    // 静的ガイダンスは常に表示
    expect(html).toContain('YouTube の字幕');
    expect(html).toContain('直近の発話テキストのみ');
  });

  it('enabled=true → 操作可能（dim なし）、窓長・しきい値の選択肢が出る', () => {
    const html = renderToStaticMarkup(
      <CaptionContext
        settings={settingsWith({ enabled: true, windowSeconds: 60, qualityThreshold: 'standard' })}
        onUpdate={() => undefined}
      />,
    );
    expect(html).not.toContain('初期状態では OFF');
    expect(html).not.toContain('pointer-events-none');
    expect(html).toContain('60秒（推奨）');
    expect(html).toContain('厳格');
    // enabled トグルは ON
    expect(html).toContain('aria-checked="true"');
  });

  it('windowSeconds=120 / qualityThreshold=strict の選択状態が markup に反映', () => {
    const html = renderToStaticMarkup(
      <CaptionContext
        settings={settingsWith({ enabled: true, windowSeconds: 120, qualityThreshold: 'strict' })}
        onUpdate={() => undefined}
      />,
    );
    // 選択中の radio は aria-checked="true"（120秒 と 厳格 が選択）
    expect(html).toMatch(/aria-checked="true"[^>]*>120秒/);
    expect(html).toMatch(/aria-checked="true"[^>]*>厳格/);
  });
});
