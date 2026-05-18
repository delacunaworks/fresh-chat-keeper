/**
 * B8: stage-dispatch 純関数のユニットテスト。
 * archive.ts 本体（DOM/chrome 依存）は手動テスト担保、判断ロジックは
 * 純関数に切り出してここで保護する。
 */

import { describe, it, expect } from 'vitest';
import {
  shouldRunStage1_5,
  isAnyNewCategoryEnabled,
} from '../src/content/stage-dispatch.js';
import type { CategorySettings } from '../src/shared/settings.js';

function cats(p: Partial<{
  harassment: boolean;
  spam: boolean;
  offTopic: boolean;
  backseat: boolean;
}> = {}): CategorySettings {
  return {
    harassment: { enabled: p.harassment ?? false, strength: 'standard' },
    spam: { enabled: p.spam ?? false },
    offTopic: { enabled: p.offTopic ?? false, strength: 'standard' },
    backseat: { enabled: p.backseat ?? false, strength: 'standard' },
  };
}

describe('B8a: shouldRunStage1_5', () => {
  it('通常の新規流入（isReprocess=false）→ Stage 1.5 実行', () => {
    expect(shouldRunStage1_5(false)).toBe(true);
  });
  it('遡及一括再処理（isReprocess=true）→ Stage 1.5 スキップ', () => {
    expect(shouldRunStage1_5(true)).toBe(false);
  });
});

describe('B8b: isAnyNewCategoryEnabled', () => {
  it('categories 未設定（旧ユーザー）→ false', () => {
    expect(isAnyNewCategoryEnabled(undefined)).toBe(false);
  });
  it('全 OFF → false', () => {
    expect(isAnyNewCategoryEnabled(cats())).toBe(false);
  });
  it('各カテゴリ単独 ON → true', () => {
    expect(isAnyNewCategoryEnabled(cats({ harassment: true }))).toBe(true);
    expect(isAnyNewCategoryEnabled(cats({ spam: true }))).toBe(true);
    expect(isAnyNewCategoryEnabled(cats({ offTopic: true }))).toBe(true);
    expect(isAnyNewCategoryEnabled(cats({ backseat: true }))).toBe(true);
  });
  it('複数 ON → true', () => {
    expect(
      isAnyNewCategoryEnabled(cats({ harassment: true, backseat: true })),
    ).toBe(true);
  });
});
