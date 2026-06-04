/**
 * Phase 5 P5-B5 hotfix: 字幕テキスト sanitize / dedupe の単体テスト。
 */

import { describe, it, expect } from 'vitest';
import { sanitizeCaptionText, dedupeRepeatedPhrases } from './sanitize.js';

describe('sanitizeCaptionText', () => {
  it('効果音/状況注釈 [叫び声] [笑い] [荒い息] を除去する', () => {
    expect(sanitizeCaptionText('[叫び声] よし来た [笑い] 次の部屋 [荒い息]')).toBe(
      'よし来た 次の部屋',
    );
  });

  it('複数の [..] と連続空白を整理する', () => {
    expect(sanitizeCaptionText('[音楽]   こんにちは   [拍手]  みんな')).toBe('こんにちは みんな');
  });

  it('前後の空白を trim する', () => {
    expect(sanitizeCaptionText('  おはよう  ')).toBe('おはよう');
  });

  it('注釈の無いテキストは（空白整理を除き）不変', () => {
    expect(sanitizeCaptionText('次のボスは炎属性だよ')).toBe('次のボスは炎属性だよ');
  });

  it('空入力 → 空文字', () => {
    expect(sanitizeCaptionText('')).toBe('');
    expect(sanitizeCaptionText('   ')).toBe('');
  });

  it('20 文字を超える角括弧内は本文とみなし除去しない（安全弁）', () => {
    const long = '[' + 'あ'.repeat(21) + ']';
    expect(sanitizeCaptionText(long)).toBe(long);
  });
});

describe('dedupeRepeatedPhrases', () => {
  it('連続して重複する文を 1 つに畳む（A A B → A B）', () => {
    expect(dedupeRepeatedPhrases('やは。やは。よしよし。')).toBe('やは。よしよし。');
  });

  it('全体が短周期の繰り返しなら 1 周期に縮約（A B C A B C → A B C）', () => {
    expect(dedupeRepeatedPhrases('やは。よしよし。来た来た。やは。よしよし。来た来た。')).toBe(
      'やは。よしよし。来た来た。',
    );
  });

  it('A B A B → A B（周期 2）', () => {
    expect(dedupeRepeatedPhrases('おはよう。元気。おはよう。元気。')).toBe('おはよう。元気。');
  });

  it('重複の無いテキストは不変', () => {
    expect(dedupeRepeatedPhrases('おはよう。元気ですか？')).toBe('おはよう。元気ですか？');
  });

  it('区切りを持たない単一テキストはそのまま（trim のみ）', () => {
    expect(dedupeRepeatedPhrases('  やあやあ  ')).toBe('やあやあ');
  });

  it('空入力 → 空文字', () => {
    expect(dedupeRepeatedPhrases('')).toBe('');
  });

  it('感嘆符・疑問符・改行も文区切りとして扱う', () => {
    expect(dedupeRepeatedPhrases('すごい！すごい！')).toBe('すごい！');
    expect(dedupeRepeatedPhrases('本当？本当？')).toBe('本当？');
  });
});
