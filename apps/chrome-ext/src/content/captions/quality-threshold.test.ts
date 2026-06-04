/**
 * Phase 5 P5-B4c: qualityThresholdToNumber の単体テスト。
 *
 * 設定 UI プリセット（loose/standard/strict）→ 数値しきい値（0..1）への
 * マッピングを保護する。値が大きいほど厳格。
 */

import { describe, it, expect } from 'vitest';
import { qualityThresholdToNumber } from './quality-threshold.js';

describe('qualityThresholdToNumber', () => {
  it('loose → 0.3', () => {
    expect(qualityThresholdToNumber('loose')).toBe(0.3);
  });

  it('standard → 0.4（provider archive 既定と同値）', () => {
    expect(qualityThresholdToNumber('standard')).toBe(0.4);
  });

  it('strict → 0.5（provider live 既定と同値）', () => {
    expect(qualityThresholdToNumber('strict')).toBe(0.5);
  });

  it('厳格度が単調増加（loose < standard < strict）', () => {
    expect(qualityThresholdToNumber('loose')).toBeLessThan(qualityThresholdToNumber('standard'));
    expect(qualityThresholdToNumber('standard')).toBeLessThan(qualityThresholdToNumber('strict'));
  });
});
