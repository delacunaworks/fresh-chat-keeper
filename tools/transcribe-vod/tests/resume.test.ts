import { describe, it, expect } from 'vitest';
import {
  chunkCacheFileName,
  parseCachedChunkIndices,
  chunksNeedingTranscription,
} from '../src/resume.js';
import { planChunks } from '../src/plan.js';

describe('chunkCacheFileName', () => {
  it('3 桁ゼロ埋め', () => {
    expect(chunkCacheFileName(0)).toBe('chunk-000.json');
    expect(chunkCacheFileName(42)).toBe('chunk-042.json');
    expect(chunkCacheFileName(123)).toBe('chunk-123.json');
  });
});

describe('parseCachedChunkIndices', () => {
  it('chunk-NNN.json だけを拾って index 集合にする', () => {
    const set = parseCachedChunkIndices([
      'chunk-000.json',
      'chunk-005.json',
      'audio.bestaudio',
      'chunk-abc.json',
      'chunk-012.wav',
    ]);
    expect([...set].sort((a, b) => a - b)).toEqual([0, 5]);
  });
});

describe('chunksNeedingTranscription', () => {
  it('キャッシュ済みを除外し未転写だけ返す（レジューム）', () => {
    const plan = planChunks(1800); // 3 チャンク（0,1,2）
    const cached = new Set([0, 2]);
    const todo = chunksNeedingTranscription(plan, cached);
    expect(todo.map((c) => c.index)).toEqual([1]);
  });

  it('全キャッシュ済みなら空', () => {
    const plan = planChunks(1200);
    expect(chunksNeedingTranscription(plan, new Set([0, 1]))).toEqual([]);
  });
});
