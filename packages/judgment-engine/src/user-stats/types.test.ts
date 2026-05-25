/**
 * Phase 3.5 B3 supplement: user-stats/types.ts のヘルパー単体テスト。
 *
 * `primaryToCountKey` は LABEL_PRECEDENCE → FlaggedCounts キーの変換を担い、
 * `off_topic` ↔ `offTopic` のような snake_case ↔ camelCase 差や `safe` の
 * 集計対象外（null）処理が要。`JudgmentLabel` 拡張時の網羅性は型レベル
 * `_exhaustive: never` で担保しているが、ランタイム挙動も全 6 ラベルで確認。
 */

import { describe, it, expect } from 'vitest';
import { primaryToCountKey, emptyFlaggedCounts } from './types.js';

describe('B3 supplement: primaryToCountKey', () => {
  it("'safe' → null（集計対象外）", () => {
    expect(primaryToCountKey('safe')).toBeNull();
  });

  it("'spoiler' → 'spoiler'", () => {
    expect(primaryToCountKey('spoiler')).toBe('spoiler');
  });

  it("'harassment' → 'harassment'", () => {
    expect(primaryToCountKey('harassment')).toBe('harassment');
  });

  it("'spam' → 'spam'", () => {
    expect(primaryToCountKey('spam')).toBe('spam');
  });

  it("'off_topic' → 'offTopic'（snake_case ↔ camelCase 差を吸収）", () => {
    expect(primaryToCountKey('off_topic')).toBe('offTopic');
  });

  it("'backseat' → 'backseat'", () => {
    expect(primaryToCountKey('backseat')).toBe('backseat');
  });

  it('null 以外の戻り値は emptyFlaggedCounts のキーとして使える', () => {
    const counts = emptyFlaggedCounts();
    const key = primaryToCountKey('off_topic');
    expect(key).not.toBeNull();
    if (key !== null) {
      counts[key] = 3;
      expect(counts.offTopic).toBe(3);
    }
  });
});
