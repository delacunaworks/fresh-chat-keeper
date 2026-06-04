/**
 * Phase 5 P5-B4a: buildStage2CacheKey の字幕シグネチャ + 後方互換テスト。
 *
 * buildStage2CacheKey は pure 関数（chrome.* 非依存）なので node で直接テスト可能。
 * 最重要: captionSig 省略 / 'nocap' は v0.5.0 とバイト一致（既存 fck_judge_cache を
 * 無効化しない）。
 */

import { describe, it, expect } from 'vitest';
import { buildStage2CacheKey } from '../src/content/chrome-cache.js';
import type { GameProgress } from '../src/shared/settings.js';

const chapterProgress: GameProgress = {
  progressModel: 'chapter',
  currentChapterId: 'ch3',
};

describe('buildStage2CacheKey: 後方互換（P5-B4a）', () => {
  it('captionSig 省略 と "nocap" 明示はバイト一致', () => {
    expect(buildStage2CacheKey('g', chapterProgress, 'hello')).toBe(
      buildStage2CacheKey('g', chapterProgress, 'hello', 'nocap'),
    );
  });

  it('nocap キーは v0.5.0 形式（${gameId}|${progressKey}|${text}）と完全一致', () => {
    // v0.5.0 の現行実装が生成していた形式をハードコードで固定（リグレッション検出）
    expect(buildStage2CacheKey('ace-attorney-1', chapterProgress, 'コメント本文')).toBe(
      'ace-attorney-1|ch3|コメント本文',
    );
  });

  it('progress なし（none）でも v0.5.0 形式', () => {
    expect(buildStage2CacheKey('g', undefined, 'text')).toBe('g|none|text');
  });

  it('event 進行モデルの nocap キーも従来どおり（順序ソート）', () => {
    const ev: GameProgress = {
      progressModel: 'event',
      completedEventIds: ['e3', 'e1', 'e2'],
    };
    expect(buildStage2CacheKey('g', ev, 'text')).toBe('g|e1,e2,e3|text');
  });
});

describe('buildStage2CacheKey: 字幕シグネチャ（P5-B4a）', () => {
  it('字幕あり（c2）は nocap と異なるキー', () => {
    expect(buildStage2CacheKey('g', chapterProgress, 'hello', 'c2')).not.toBe(
      buildStage2CacheKey('g', chapterProgress, 'hello', 'nocap'),
    );
  });

  it('字幕あり: progressKey と text の間に挿入（g|ch3|c2|hello）', () => {
    expect(buildStage2CacheKey('g', chapterProgress, 'hello', 'c2')).toBe('g|ch3|c2|hello');
  });

  it('同じ captionSig（c2）なら同じキー', () => {
    expect(buildStage2CacheKey('g', chapterProgress, 'hello', 'c2')).toBe(
      buildStage2CacheKey('g', chapterProgress, 'hello', 'c2'),
    );
  });

  it('異なる captionSig（c2 vs c3）で別キー（文脈進行で再判定）', () => {
    expect(buildStage2CacheKey('g', chapterProgress, 'hello', 'c2')).not.toBe(
      buildStage2CacheKey('g', chapterProgress, 'hello', 'c3'),
    );
  });
});
