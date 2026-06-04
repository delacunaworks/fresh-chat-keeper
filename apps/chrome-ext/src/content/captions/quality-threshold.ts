/**
 * Phase 5（v0.6.0 / P5-B4c）字幕品質しきい値プリセット → 数値変換（純粋関数）。
 *
 * 設計 ground truth: `dev-docs/phase-5-audio-context.md`
 *   §「caption MVP スコープと前提の訂正」/ バッチ表 P5-B4c 行。
 *
 * `CaptionQualityThreshold`（loose/standard/strict、設定 UI のプリセット）を
 * `evaluateCaptionQuality` の useable しきい値（0..1）に変換する。値が大きいほど
 * 厳格（低品質字幕を弾く）。`provider.getRecentContext` の threshold 引数に渡す。
 *
 * mode 由来の既定（YouTubeCaptionProvider の live 0.5 / archive 0.4）に対し、
 * **ユーザー設定が勝つ**（settings.captionContext.qualityThreshold が指定されたら
 * それを使う）。本関数を chrome-ext 側（captions/）に置くのは、judgment-engine の
 * 純粋ロジック層を「設定 UI のプリセット名」に依存させないため
 * （judgment-engine は数値しきい値しか知らない）。
 */

import type { CaptionQualityThreshold } from '../../shared/settings.js';

/**
 * 品質しきい値プリセットを数値（0..1）に変換する。
 *
 * - `loose`   → 0.3（低品質字幕も比較的通す）
 * - `standard`→ 0.4（provider archive 既定と同値）
 * - `strict`  → 0.5（provider live 既定と同値。高品質字幕のみ）
 */
export function qualityThresholdToNumber(threshold: CaptionQualityThreshold): number {
  switch (threshold) {
    case 'loose':
      return 0.3;
    case 'standard':
      return 0.4;
    case 'strict':
      return 0.5;
  }
}
