/**
 * LABEL_PRECEDENCE / derivePrimary の単体テスト。
 *
 * 順序の drift 検出が主目的（設計書 L240 と完全一致させること）。
 */

import { describe, it, expect } from 'vitest';
import {
  LABEL_PRECEDENCE,
  derivePrimary,
} from '../../src/stage2/label-precedence.js';
import type { JudgmentLabel } from '../../src/types.js';

describe('LABEL_PRECEDENCE', () => {
  it('深刻度の高い順: harassment > spoiler > backseat > spam > off_topic > safe', () => {
    expect(LABEL_PRECEDENCE).toEqual([
      'harassment',
      'spoiler',
      'backseat',
      'spam',
      'off_topic',
      'safe',
    ]);
  });

  it('6 ラベルすべてが含まれる（過不足なし）', () => {
    const set = new Set(LABEL_PRECEDENCE);
    expect(set.size).toBe(6);
    expect(set.has('harassment')).toBe(true);
    expect(set.has('spoiler')).toBe(true);
    expect(set.has('backseat')).toBe(true);
    expect(set.has('spam')).toBe(true);
    expect(set.has('off_topic')).toBe(true);
    expect(set.has('safe')).toBe(true);
  });
});

describe('derivePrimary', () => {
  it('単一ラベルはそのまま primary', () => {
    expect(derivePrimary(['safe'])).toBe('safe');
    expect(derivePrimary(['spoiler'])).toBe('spoiler');
    expect(derivePrimary(['harassment'])).toBe('harassment');
  });

  it('複数ラベルでは harassment が最優先', () => {
    expect(derivePrimary(['harassment', 'spoiler'])).toBe('harassment');
    expect(derivePrimary(['spoiler', 'harassment'])).toBe('harassment');
    expect(derivePrimary(['backseat', 'harassment', 'off_topic'])).toBe('harassment');
  });

  it('harassment 不在で spoiler があれば spoiler が primary', () => {
    expect(derivePrimary(['spoiler', 'backseat'])).toBe('spoiler');
    expect(derivePrimary(['off_topic', 'spoiler'])).toBe('spoiler');
  });

  it('harassment / spoiler 不在で backseat があれば backseat', () => {
    expect(derivePrimary(['backseat', 'spam', 'off_topic'])).toBe('backseat');
  });

  it('spam vs off_topic では spam', () => {
    expect(derivePrimary(['spam', 'off_topic'])).toBe('spam');
    expect(derivePrimary(['off_topic', 'spam'])).toBe('spam');
  });

  it('safe 単独 → safe', () => {
    expect(derivePrimary(['safe'])).toBe('safe');
  });

  it('空配列 → safe（防御的フォールバック）', () => {
    expect(derivePrimary([])).toBe('safe');
  });

  it('JudgmentLabel 以外の値が混入 → safe にフォールバック', () => {
    expect(derivePrimary(['unknown', 'garbage'] as unknown as JudgmentLabel[])).toBe('safe');
  });

  it('既知ラベル + 不正ラベル混在 → 既知ラベルが採用される', () => {
    expect(
      derivePrimary(['unknown', 'spoiler'] as unknown as JudgmentLabel[]),
    ).toBe('spoiler');
  });
});
