/**
 * B8 / B9: stage-dispatch 純関数のユニットテスト。
 * archive.ts 本体（DOM/chrome 依存）は手動テスト担保、判断ロジックは
 * 純関数に切り出してここで保護する。
 */

import { describe, it, expect } from 'vitest';
import {
  shouldRunStage1_5,
  isAnyNewCategoryEnabled,
  shouldTryGameplayHintStage2,
  ensureGameplayHintsForCategories,
  GAMEPLAY_HINTS_TEMPLATE_ID,
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

describe('B9: ensureGameplayHintsForCategories', () => {
  it('新カテゴリ全 OFF → 入力配列を変更せず同一参照を返す（自動追加しない）', () => {
    const templates: string[] = [];
    expect(ensureGameplayHintsForCategories(cats(), templates)).toBe(templates);
    const withOthers = ['action-horror'];
    expect(ensureGameplayHintsForCategories(cats(), withOthers)).toBe(withOthers);
  });

  it('categories 未設定（旧ユーザー）→ 入力配列を変更しない', () => {
    const templates = ['action-horror'];
    expect(ensureGameplayHintsForCategories(undefined, templates)).toBe(templates);
  });

  it('各新カテゴリ単独 ON で gameplay-hints 未選択 → 末尾に追加', () => {
    for (const key of ['harassment', 'spam', 'offTopic', 'backseat'] as const) {
      const result = ensureGameplayHintsForCategories(cats({ [key]: true }), []);
      expect(result).toEqual([GAMEPLAY_HINTS_TEMPLATE_ID]);
    }
  });

  it('既存の他テンプレが残った状態で末尾に追加（既存テンプレを壊さない）', () => {
    const result = ensureGameplayHintsForCategories(
      cats({ backseat: true }),
      ['action-horror', 'rpg'],
    );
    expect(result).toEqual(['action-horror', 'rpg', GAMEPLAY_HINTS_TEMPLATE_ID]);
  });

  it('新カテゴリ ON でも既に gameplay-hints 含む → 重複追加せず同一参照', () => {
    const templates = ['action-horror', GAMEPLAY_HINTS_TEMPLATE_ID];
    expect(
      ensureGameplayHintsForCategories(cats({ harassment: true }), templates),
    ).toBe(templates);
  });

  it('複数新カテゴリ ON でも 1 つだけ追加（冪等）', () => {
    const result = ensureGameplayHintsForCategories(
      cats({ harassment: true, spam: true, offTopic: true, backseat: true }),
      [],
    );
    expect(result).toEqual([GAMEPLAY_HINTS_TEMPLATE_ID]);
  });

  it('自動削除しない: 新カテゴリ全 OFF へ戻しても gameplay-hints は残る', () => {
    const templates = ['action-horror', GAMEPLAY_HINTS_TEMPLATE_ID];
    const result = ensureGameplayHintsForCategories(cats(), templates);
    expect(result).toBe(templates);
    expect(result).toContain(GAMEPLAY_HINTS_TEMPLATE_ID);
  });

  it('入力配列を破壊しない（mutate 禁止）', () => {
    const templates = ['action-horror'];
    const snapshot = [...templates];
    ensureGameplayHintsForCategories(cats({ backseat: true }), templates);
    expect(templates).toEqual(snapshot);
  });
});
