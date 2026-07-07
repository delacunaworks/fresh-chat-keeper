/**
 * comment-extract の純関数テスト（parseTimestampToSeconds）。
 * DOM 依存の extractDisplayText / getReplayTimestampSeconds は repo 方針どおり
 * 手動テスト担保（jsdom 非導入）。
 */
import { describe, it, expect } from 'vitest';
import { parseTimestampToSeconds } from './comment-extract.js';

describe('parseTimestampToSeconds', () => {
  it('m:ss', () => {
    expect(parseTimestampToSeconds('0:00')).toBe(0);
    expect(parseTimestampToSeconds('3:07')).toBe(187);
    expect(parseTimestampToSeconds('59:59')).toBe(3599);
  });

  it('h:mm:ss', () => {
    expect(parseTimestampToSeconds('1:56:15')).toBe(6975);
    expect(parseTimestampToSeconds('10:00:00')).toBe(36000);
  });

  it('配信前オフセット（負）', () => {
    expect(parseTimestampToSeconds('-0:05')).toBe(-5);
    expect(parseTimestampToSeconds('-1:23')).toBe(-83);
  });

  it('前後空白は許容', () => {
    expect(parseTimestampToSeconds('  1:02  ')).toBe(62);
  });

  it('形式外は null（実時刻 AM/PM・文字混じり・秒 1 桁）', () => {
    expect(parseTimestampToSeconds('11:56 PM')).toBeNull();
    expect(parseTimestampToSeconds('午後 11:56')).toBeNull();
    expect(parseTimestampToSeconds('1:2')).toBeNull();
    expect(parseTimestampToSeconds('')).toBeNull();
    expect(parseTimestampToSeconds('abc')).toBeNull();
  });
});
