/**
 * B8: stage-dispatch 純関数のユニットテスト。
 * archive.ts 本体（DOM/chrome 依存）は手動テスト担保、判断ロジックは
 * 純関数に切り出してここで保護する。
 */

import { describe, it, expect } from 'vitest';
import {
  shouldRunStage1_5,
  isAnyNewCategoryEnabled,
  shouldTryGameplayHintStage2,
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

describe('B8b: shouldTryGameplayHintStage2', () => {
  it('テンプレート未選択（count=0）→ 常に false（gameplay-hints 経路無効）', () => {
    expect(shouldTryGameplayHintStage2('rdr2', true, 0)).toBe(false);
    expect(shouldTryGameplayHintStage2('none', true, 0)).toBe(false);
    expect(shouldTryGameplayHintStage2('other', false, 0)).toBe(false);
  });

  it('従来経路維持: gameId !== none + テンプレ選択 → true（新カテゴリ無関係）', () => {
    expect(shouldTryGameplayHintStage2('rdr2', false, 2)).toBe(true);
    expect(shouldTryGameplayHintStage2('other', false, 1)).toBe(true);
  });

  it('B8b 緩和: gameId=none でも新カテゴリ ON + テンプレ選択 → true', () => {
    expect(shouldTryGameplayHintStage2('none', true, 1)).toBe(true);
  });

  it('B8b: gameId=none かつ新カテゴリ全 OFF → false（従来どおり送らない）', () => {
    expect(shouldTryGameplayHintStage2('none', false, 3)).toBe(false);
  });

  it('結合: gameId=none + backseat ON + テンプレ 1 → Stage 2 へ（B8b 主シナリオ）', () => {
    expect(
      shouldTryGameplayHintStage2(
        'none',
        isAnyNewCategoryEnabled(cats({ backseat: true })),
        1,
      ),
    ).toBe(true);
  });

  it('回帰: spoiler のみ運用（新カテゴリ OFF）で gameId=none は対象外', () => {
    expect(
      shouldTryGameplayHintStage2('none', isAnyNewCategoryEnabled(cats()), 2),
    ).toBe(false);
  });
});
