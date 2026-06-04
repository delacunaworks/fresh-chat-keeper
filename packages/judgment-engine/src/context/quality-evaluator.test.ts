/**
 * Phase 5 P5-B2: evaluateCaptionQuality の単体テスト。
 *
 * 設計文書のテスト例（良質→高スコア / too_short / repetitive）+ 境界
 * （空配列・しきい値前後・各 issue 単独・閾値引数）を網羅する。純粋関数なので
 * DOM 不要、配列 in / オブジェクト out のみ。
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateCaptionQuality,
  DEFAULT_USEABLE_THRESHOLD,
} from './quality-evaluator.js';
import type { CaptionSegment } from './types.js';

const RECEIVED = 1_700_000_000_000;

function seg(text: string, timestamp: number): CaptionSegment {
  return { text, timestamp, receivedAt: RECEIVED };
}

describe('evaluateCaptionQuality: 設計文書の例', () => {
  it('良質な字幕は高スコア + useable', () => {
    const segments = [
      seg('これから次のエリアに進むよ', 100),
      seg('ここのボス強いけど頑張る', 110),
    ];
    const quality = evaluateCaptionQuality(segments, 60);
    expect(quality.overallScore).toBeGreaterThan(0.7);
    expect(quality.useable).toBe(true);
    expect(quality.issues).toEqual([]);
  });

  it('短すぎる字幕は too_short + useable=false', () => {
    const segments = [seg('え', 100)];
    const quality = evaluateCaptionQuality(segments, 60);
    expect(quality.issues).toContain('too_short');
    expect(quality.useable).toBe(false);
  });

  it('繰り返し字幕は repetitive', () => {
    const segments = Array.from({ length: 10 }, (_, i) => seg('同じ言葉', 100 + i));
    const quality = evaluateCaptionQuality(segments, 60);
    expect(quality.issues).toContain('repetitive');
  });
});

describe('evaluateCaptionQuality: 各 issue 単独', () => {
  it('too_short: 総文字数 < 20', () => {
    // 2 セグ・各短文（連結 19 文字以内）。few_segments を避けるため 2 件にする
    const segments = [seg('あいうえお', 100), seg('かきくけこ', 105)];
    // 連結 "あいうえお かきくけこ" = 11 文字 < 20
    const quality = evaluateCaptionQuality(segments, 60);
    expect(quality.issues).toContain('too_short');
    expect(quality.issues).not.toContain('few_segments');
  });

  it('few_segments: セグメント 1 件（だが長文で too_short は回避）', () => {
    const long = 'これは十分に長い字幕テキストで二十文字を超えています本当に';
    const segments = [seg(long, 100)];
    const quality = evaluateCaptionQuality(segments, 60);
    expect(quality.issues).toContain('few_segments');
    expect(quality.issues).not.toContain('too_short');
  });

  it('corrupted_text: 異常記号の比率が高い', () => {
    // 制御記号主体（許容セットに無い記号を多用）。長さ 20 以上で too_short 回避
    const garbage = '◆◇■□▲△▼▽◎●○★☆※＃＄％＆＠';
    const segments = [seg(garbage, 100), seg(garbage + '×', 105)];
    const quality = evaluateCaptionQuality(segments, 60);
    expect(quality.issues).toContain('corrupted_text');
  });

  it('repetitive: ユニーク率 < 50%', () => {
    const segments = [
      seg('おなじ', 100),
      seg('おなじ', 101),
      seg('おなじ', 102),
      seg('ちがう', 103),
    ];
    // unique 2 / total 4 = 0.5、 2 < 4*0.5=2 → false。1 件減らして検証
    const dup = [seg('A', 100), seg('A', 101), seg('A', 102)];
    const quality = evaluateCaptionQuality(dup, 60);
    expect(quality.issues).toContain('repetitive');
    void segments;
  });

  it('large_gaps: ギャップ > 15 秒が過半', () => {
    // 十分長い 3 セグ。timestamp ギャップを大きく（20s, 30s）
    const segments = [
      seg('これは長めの字幕テキストです', 0),
      seg('かなり時間が空いた次の発話', 20),
      seg('さらに時間が空いた発話です', 50),
    ];
    const quality = evaluateCaptionQuality(segments, 60);
    expect(quality.issues).toContain('large_gaps');
  });
});

describe('evaluateCaptionQuality: 境界条件', () => {
  it('空配列: too_short + few_segments、useable=false、例外なし', () => {
    const quality = evaluateCaptionQuality([], 60);
    expect(quality.issues).toContain('too_short');
    expect(quality.issues).toContain('few_segments');
    expect(quality.useable).toBe(false);
    // 1.0 * 0.3 * 0.5 = 0.15
    expect(quality.overallScore).toBeCloseTo(0.15, 5);
  });

  it('空配列でも weirdCharRatio の 0 除算で NaN にならない', () => {
    const quality = evaluateCaptionQuality([], 60);
    expect(Number.isFinite(quality.overallScore)).toBe(true);
    expect(quality.issues).not.toContain('corrupted_text');
  });

  it('overallScore は常に 0..1 の範囲', () => {
    const allBad = [seg('×', 0), seg('×', 100)]; // 短い + 繰り返し + 文字化け + gap
    const quality = evaluateCaptionQuality(allBad, 60);
    expect(quality.overallScore).toBeGreaterThanOrEqual(0);
    expect(quality.overallScore).toBeLessThanOrEqual(1);
  });

  it('1 セグメントは gaps 計算で例外を出さない（slice(1) 空）', () => {
    const quality = evaluateCaptionQuality([seg('単独セグメントだが長文にしておく二十文字超', 100)], 60);
    expect(quality.issues).not.toContain('large_gaps');
  });
});

describe('evaluateCaptionQuality: threshold 引数', () => {
  it('既定しきい値は 0.4（DEFAULT_USEABLE_THRESHOLD）', () => {
    expect(DEFAULT_USEABLE_THRESHOLD).toBe(0.4);
  });

  it('しきい値ちょうど（score === threshold）は useable=true（>=）', () => {
    // few_segments のみ → score 0.5。threshold 0.5 ちょうどで useable
    const long = 'これは十分長い単独字幕テキストで二十文字超えます確実に';
    const segments = [seg(long, 100)];
    const q = evaluateCaptionQuality(segments, 60, 0.5);
    expect(q.overallScore).toBeCloseTo(0.5, 5);
    expect(q.useable).toBe(true);
  });

  it('厳格しきい値（アーカイブ 0.5）で few_segments=0.5 は通り、より低いと落ちる', () => {
    const long = 'これは十分長い単独字幕テキストで二十文字超えます確実に';
    const oneSeg = [seg(long, 100)]; // score 0.5
    expect(evaluateCaptionQuality(oneSeg, 60, 0.5).useable).toBe(true);
    expect(evaluateCaptionQuality(oneSeg, 60, 0.6).useable).toBe(false);
  });

  it('緩いしきい値（0.1）なら too_short 単独（0.3）でも useable', () => {
    const segments = [seg('短い', 100), seg('文だ', 105)]; // too_short のみ → 0.3
    const q = evaluateCaptionQuality(segments, 60, 0.1);
    expect(q.issues).toContain('too_short');
    expect(q.useable).toBe(true);
  });

  it('良質字幕は windowSeconds の値に依存しない（現ロジックでは未使用）', () => {
    const segments = [seg('次のエリアに進むよ準備はいい', 100), seg('ボス戦に備えて回復する', 110)];
    const q1 = evaluateCaptionQuality(segments, 30);
    const q2 = evaluateCaptionQuality(segments, 120);
    expect(q1.overallScore).toBe(q2.overallScore);
    expect(q1.issues).toEqual(q2.issues);
  });
});

describe('evaluateCaptionQuality: 入力不変', () => {
  it('入力 segments を破壊しない（純粋）', () => {
    const segments = [seg('あいうえおかきくけこ', 100), seg('さしすせそ', 120)];
    const snapshot = JSON.parse(JSON.stringify(segments));
    evaluateCaptionQuality(segments, 60);
    expect(segments).toEqual(snapshot);
  });
});
