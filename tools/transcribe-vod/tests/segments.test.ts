import { describe, it, expect } from 'vitest';
import { wordsToSegments, buildSegmentsForChunk, SEGMENT_SECONDS } from '../src/segments.js';
import type { TranscribeWord } from '@fresh-chat-keeper/api/lib/scribe';

function w(text: string, start: number, end: number, type = 'word'): TranscribeWord {
  return { text, start, end, type };
}

describe('wordsToSegments', () => {
  it('20 秒窓でグルーピングし、t は絶対秒（チャンクオフセット + 語の start）', () => {
    // チャンク 3（開始 1800s）。窓 0（0-20s）と窓 1（20-40s）。
    const words: TranscribeWord[] = [
      w('こんにちは', 1, 2),
      w(' ', 2, 2.1, 'spacing'),
      w('皆さん', 2.1, 3),
      w('次は', 25, 26),
      w('ボス戦', 26, 27),
    ];
    const segs = wordsToSegments(words, 1800);
    expect(segs).toHaveLength(2);
    // 窓0: spacing トークンがあるので空白保持 → 'こんにちは 皆さん'。t=1800+1=1801
    expect(segs[0]).toEqual({ t: 1801, text: 'こんにちは 皆さん' });
    // 窓1: spacing トークンが無いので連結（日本語は空白なしが自然）。t=1800+25=1825
    expect(segs[1]).toEqual({ t: 1825, text: '次はボス戦' });
  });

  it('空の words は空配列', () => {
    expect(wordsToSegments([], 0)).toEqual([]);
  });

  it('start 昇順でなくても整列して処理する', () => {
    const words = [w('B', 5, 6), w('A', 1, 2)];
    const segs = wordsToSegments(words, 0);
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe('AB'); // 整列後 A,B を連結（spacing なし）
    expect(segs[0].t).toBe(1); // 最小 start=1 を floor
  });

  it('t は最小 start を floor した整数秒', () => {
    const segs = wordsToSegments([w('x', 3.9, 4.0)], 600);
    expect(segs[0].t).toBe(603); // 600 + floor(3.9)=600+3
  });

  it('空白のみになる窓は落とす', () => {
    const segs = wordsToSegments([w('   ', 1, 2, 'spacing')], 0);
    expect(segs).toEqual([]);
  });

  it('SEGMENT_SECONDS は 15〜30 の範囲', () => {
    expect(SEGMENT_SECONDS).toBeGreaterThanOrEqual(15);
    expect(SEGMENT_SECONDS).toBeLessThanOrEqual(30);
  });
});

describe('buildSegmentsForChunk', () => {
  it('words があれば wordsToSegments を使う', () => {
    const segs = buildSegmentsForChunk({ text: 'A B', words: [w('A', 1, 2), w('B', 2, 3)] }, 600);
    expect(segs).toHaveLength(1);
    expect(segs[0].t).toBe(601);
  });

  it('words が無ければチャンク単位 fallback（t=チャンク開始）', () => {
    const segs = buildSegmentsForChunk({ text: '  全文テキスト  ' }, 1200);
    expect(segs).toEqual([{ t: 1200, text: '全文テキスト' }]);
  });

  it('words も text も空なら空配列', () => {
    expect(buildSegmentsForChunk({ text: '   ' }, 0)).toEqual([]);
    expect(buildSegmentsForChunk({ text: '', words: [] }, 0)).toEqual([]);
  });
});
