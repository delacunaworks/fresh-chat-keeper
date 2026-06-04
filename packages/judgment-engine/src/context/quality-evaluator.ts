/**
 * Phase 5（v0.6.0）字幕品質の評価（純粋関数）。
 *
 * 設計 ground truth: `dev-docs/phase-5-audio-context.md` §「字幕品質の評価」。
 *
 * 取得した字幕がすべて有用とは限らない（自動生成字幕は固有名詞の文字化け・
 * 短時間発言・言語認識エラー・ゲーム音声混入などの問題を抱える）。本関数は
 * セグメント配列を純粋変換し、5 つのチェックで総合スコア（0..1）を減衰させて
 * 品質を評価する。DOM / chrome.* 非依存。
 */

import type {
  CaptionSegment,
  CaptionQuality,
  CaptionQualityIssue,
} from './types.js';

/**
 * `useable` 判定の既定しきい値。`overallScore >= これ` で利用可能とみなす。
 *
 * 呼び出し側で上書き可能（ライブは 0.4 / アーカイブは 0.5 等、字幕品質の
 * 期待値に応じて切り替えるため）。設計文書の元実装は 0.4 固定だった。
 */
export const DEFAULT_USEABLE_THRESHOLD = 0.4;

/** 文字化け率がこの値を超えると `corrupted_text`。 */
const CORRUPTED_RATIO_THRESHOLD = 0.3;
/** セグメント間ギャップ（秒）がこの値を超えると「大きいギャップ」。 */
const LARGE_GAP_SECONDS = 15;
/** 総文字数がこの値未満で `too_short`。 */
const MIN_TOTAL_TEXT_LENGTH = 20;
/** セグメント数がこの値未満で `few_segments`。 */
const MIN_SEGMENT_COUNT = 2;

/**
 * 字幕セグメント配列の品質を評価する。
 *
 * 5 つのチェック（情報量 / セグメント数 / 文字化け率 / 繰り返し / 時間ギャップ）で
 * `score`（初期 1.0）を乗算減衰させ、検出した問題を `issues` に列挙する。
 * `useable = overallScore >= threshold`。
 *
 * 純粋関数: 入力 `segments` を変更せず、時刻生成等の副作用も持たない。
 *
 * @param segments 評価対象の字幕セグメント（直近 windowSeconds 秒分の想定）
 * @param windowSeconds 収集窓（秒）。現状ロジックでは閾値計算に直接使わないが、
 *   元実装の signature を維持（将来「窓に対するセグメント密度」等で使う余地）。
 * @param threshold `useable` 判定のしきい値（既定 {@link DEFAULT_USEABLE_THRESHOLD}）
 */
export function evaluateCaptionQuality(
  segments: CaptionSegment[],
  windowSeconds: number,
  threshold: number = DEFAULT_USEABLE_THRESHOLD,
): CaptionQuality {
  void windowSeconds; // 元 signature 維持。現ロジックでは未使用（将来の密度評価用）。

  const issues: CaptionQualityIssue[] = [];
  let score = 1.0;

  // 1. 情報量チェック
  const totalText = segments.map((s) => s.text).join(' ');
  if (totalText.length < MIN_TOTAL_TEXT_LENGTH) {
    issues.push('too_short');
    score *= 0.3;
  }

  // 2. セグメント数チェック
  if (segments.length < MIN_SEGMENT_COUNT) {
    issues.push('few_segments');
    score *= 0.5;
  }

  // 3. 文字化けチェック（制御文字や異常な記号列）
  //    日本語（ひらがな/カタカナ/漢字 　-鿿）・英数字・空白・基本約物は許容。
  //    空文字のときは 0 除算を避けて ratio=0（文字化けなし扱い）。
  const weirdMatches = totalText.match(/[^\w\s　-鿿々ー、。！？]/g) ?? [];
  const weirdCharRatio = totalText.length > 0 ? weirdMatches.length / totalText.length : 0;
  if (weirdCharRatio > CORRUPTED_RATIO_THRESHOLD) {
    issues.push('corrupted_text');
    score *= 0.4;
  }

  // 4. 同じフレーズの繰り返し（字幕エンジンのループ問題）
  const uniquePhrases = new Set(segments.map((s) => s.text));
  if (uniquePhrases.size < segments.length * 0.5) {
    issues.push('repetitive');
    score *= 0.6;
  }

  // 5. 時間的な連続性（ギャップが大きすぎないか）
  const gaps = segments.slice(1).map((s, i) => s.timestamp - segments[i].timestamp);
  const largeGaps = gaps.filter((g) => g > LARGE_GAP_SECONDS).length;
  if (largeGaps > gaps.length * 0.5) {
    issues.push('large_gaps');
    score *= 0.7;
  }

  return {
    overallScore: score,
    issues,
    useable: score >= threshold,
  };
}
