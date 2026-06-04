/**
 * Phase 5 P5-B4a: captionCacheSignature の単体テスト。
 *
 * 後方互換の要: hasCaption=false / currentTime 不明は必ず 'nocap'。
 */

import { describe, it, expect } from 'vitest';
import {
  captionCacheSignature,
  CAPTION_CACHE_BUCKET_SECONDS,
} from './cache-signature.js';

describe('captionCacheSignature', () => {
  it('hasCaption=false → nocap（currentTime があっても）', () => {
    expect(captionCacheSignature(false, 65)).toBe('nocap');
    expect(captionCacheSignature(false, 0)).toBe('nocap');
  });

  it('currentTime null/undefined/NaN/Infinity → nocap', () => {
    expect(captionCacheSignature(true, null)).toBe('nocap');
    expect(captionCacheSignature(true, undefined)).toBe('nocap');
    expect(captionCacheSignature(true, NaN)).toBe('nocap');
    expect(captionCacheSignature(true, Infinity)).toBe('nocap');
    expect(captionCacheSignature(true, -Infinity)).toBe('nocap');
  });

  it('hasCaption=true + currentTime → c{bucket}（既定 30 秒粒度）', () => {
    // 65 / 30 = 2.16 → floor 2
    expect(captionCacheSignature(true, 65)).toBe('c2');
    // 0 → c0
    expect(captionCacheSignature(true, 0)).toBe('c0');
  });

  it('同一バケット内は同じシグネチャ（30〜59 → c1）', () => {
    expect(captionCacheSignature(true, 30)).toBe('c1');
    expect(captionCacheSignature(true, 45)).toBe('c1');
    expect(captionCacheSignature(true, 59)).toBe('c1');
    expect(captionCacheSignature(true, 59.999)).toBe('c1');
  });

  it('バケット境界: 59→c1, 60→c2', () => {
    expect(captionCacheSignature(true, 59)).toBe('c1');
    expect(captionCacheSignature(true, 60)).toBe('c2');
  });

  it('bucketSeconds 引数で粒度を変えられる', () => {
    // bucket 10 秒: 65 / 10 = 6.5 → c6
    expect(captionCacheSignature(true, 65, 10)).toBe('c6');
    // bucket 60 秒: 65 / 60 = 1.08 → c1
    expect(captionCacheSignature(true, 65, 60)).toBe('c1');
  });

  it('既定バケット粒度は 30 秒', () => {
    expect(CAPTION_CACHE_BUCKET_SECONDS).toBe(30);
  });

  it('負の currentTime（理論上）も floor で扱う', () => {
    // -5 / 30 = -0.16 → floor -1 → 'c-1'（実運用では currentTime>=0 だが算術の健全性確認）
    expect(captionCacheSignature(true, -5)).toBe('c-1');
  });
});
