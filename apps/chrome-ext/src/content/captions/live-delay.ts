/**
 * Phase 5（v0.6.0）ライブ字幕の遅延補正。
 *
 * 設計 ground truth: `dev-docs/phase-5-audio-context.md` §「課題1: 字幕の遅延」。
 *
 * YouTube ライブの自動字幕は実発話より 5〜15 秒遅れる。視聴者コメントは字幕表示前に
 * 発話を聞いて書かれるため、字幕とコメントの時系列がズレる。`estimatedSpeechTime`
 * に「字幕の `timestamp`（= 表示時点の currentTime）から固定オフセットを引いた推定
 * 発話時刻」を入れて補正する（MVP は固定 7 秒、適応推定は将来）。
 *
 * アーカイブ（VOD）は字幕と再生位置がほぼ一致するため補正ゼロ
 * （`estimatedSpeechTime = timestamp`）。
 *
 * DOM / chrome.* 非依存の純粋関数。
 */

import type { CaptionSegment } from '@fresh-chat-keeper/judgment-engine';

/** ライブ自動字幕の推定遅延（秒）。設計文書 `ESTIMATED_LIVE_CAPTION_DELAY_SECONDS`。 */
export const ESTIMATED_LIVE_CAPTION_DELAY_SECONDS = 7;

/**
 * セグメントに `estimatedSpeechTime`（遅延補正後の推定発話時刻、秒）を埋めて返す。
 *
 * - `mode === 'live'`: `timestamp - ESTIMATED_LIVE_CAPTION_DELAY_SECONDS`
 *   （負になる場合は 0 にクランプ。配信冒頭の字幕で timestamp が小さいケース）
 * - `mode === 'archive'`: `timestamp`（補正なし）
 *
 * 入力 `segment` は変更せず新オブジェクトを返す（純粋）。
 */
export function adjustForLiveDelay(
  segment: CaptionSegment,
  mode: 'live' | 'archive',
): CaptionSegment {
  if (mode === 'archive') {
    return { ...segment, estimatedSpeechTime: segment.timestamp };
  }
  const corrected = segment.timestamp - ESTIMATED_LIVE_CAPTION_DELAY_SECONDS;
  return { ...segment, estimatedSpeechTime: Math.max(0, corrected) };
}
