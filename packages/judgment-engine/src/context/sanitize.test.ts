/**
 * Phase 5 P5-B5 hotfix: 字幕テキスト sanitize / dedupe の単体テスト。
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeCaptionText,
  dedupeRepeatedPhrases,
  collapseRollingPrefixes,
} from './sanitize.js';

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

describe('collapseRollingPrefixes', () => {
  it('接頭辞成長を最長（最後）に畳む', () => {
    expect(
      collapseRollingPrefixes([
        'なんかさ、',
        'なんかさ、行っ',
        'なんかさ、行ったり来たり戻ってんだよね。',
      ]),
    ).toEqual(['なんかさ、行ったり来たり戻ってんだよね。']);
  });

  it('実機例: 7 段の逐次成長が 1 つに畳まれる', () => {
    const grown = [
      'なんかさ、',
      'なんかさ、行っ',
      'なんかさ、行ったり来',
      'なんかさ、行ったり来たり',
      'なんかさ、行ったり来たり戻っ',
      'なんかさ、行ったり来たり戻ってんだよ',
      'なんかさ、行ったり来たり戻ってんだよね',
      'なんかさ、行ったり来たり戻ってんだよね。',
    ];
    expect(collapseRollingPrefixes(grown)).toEqual([
      'なんかさ、行ったり来たり戻ってんだよね。',
    ]);
  });

  it('接頭辞関係のない別発話は両方残す', () => {
    expect(collapseRollingPrefixes(['おはよう', 'こんにちは'])).toEqual([
      'おはよう',
      'こんにちは',
    ]);
  });

  it('後者が前者の接頭辞（短い）なら後者を捨てて前者（最長）を残す', () => {
    expect(
      collapseRollingPrefixes(['なんかさ、行ったり来たり', 'なんかさ、行っ', 'なんかさ、']),
    ).toEqual(['なんかさ、行ったり来たり']);
  });

  it('成長 → 別発話 → 成長 が混在しても各グループを最長に畳む', () => {
    expect(
      collapseRollingPrefixes([
        'あのね',
        'あのねこれ',
        'あのねこれ面白い',
        'ところで',
        'ところで腹減った',
      ]),
    ).toEqual(['あのねこれ面白い', 'ところで腹減った']);
  });

  it('空配列 / 空文字混在 / 単一要素', () => {
    expect(collapseRollingPrefixes([])).toEqual([]);
    expect(collapseRollingPrefixes(['', '  ', 'やあ'])).toEqual(['やあ']);
    expect(collapseRollingPrefixes(['ひとつだけ'])).toEqual(['ひとつだけ']);
  });

  it('完全一致の連続は最長＝同一に畳まれる（startsWith は同値も真）', () => {
    expect(collapseRollingPrefixes(['同じ', '同じ', '同じ'])).toEqual(['同じ']);
  });
});
