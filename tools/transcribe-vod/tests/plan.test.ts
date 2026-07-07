import { describe, it, expect } from 'vitest';
import {
  planChunks,
  estimateCostUsd,
  formatDuration,
  CHUNK_SECONDS,
  SCRIBE_USD_PER_HOUR,
} from '../src/plan.js';

describe('planChunks', () => {
  it('割り切れる長さ（2 チャンク）', () => {
    const chunks = planChunks(1200);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ index: 0, startSec: 0, durationSec: 600 });
    expect(chunks[1]).toEqual({ index: 1, startSec: 600, durationSec: 600 });
  });

  it('端数は最後のチャンクが短くなる', () => {
    const chunks = planChunks(1500); // 25 分 → 600+600+300
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toEqual({ index: 2, startSec: 1200, durationSec: 300 });
  });

  it('チャンク幅は AR-1 のバケット（600s）と一致', () => {
    expect(CHUNK_SECONDS).toBe(600);
  });

  it('0 / 負 / 非有限は空配列', () => {
    expect(planChunks(0)).toEqual([]);
    expect(planChunks(-100)).toEqual([]);
    expect(planChunks(NaN)).toEqual([]);
  });

  it('600 未満は 1 チャンク', () => {
    expect(planChunks(59)).toEqual([{ index: 0, startSec: 0, durationSec: 59 }]);
  });
});

describe('estimateCostUsd', () => {
  it('1 時間 = $0.22', () => {
    expect(estimateCostUsd(3600)).toBeCloseTo(SCRIBE_USD_PER_HOUR, 5);
  });
  it('5 時間 = $1.10', () => {
    expect(estimateCostUsd(5 * 3600)).toBeCloseTo(1.1, 5);
  });
  it('負値は 0', () => {
    expect(estimateCostUsd(-1)).toBe(0);
  });
});

describe('formatDuration', () => {
  it('H:MM:SS', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(59)).toBe('0:00:59');
    expect(formatDuration(600)).toBe('0:10:00');
  });
});
