/**
 * マルチラベル判定における primary 決定の優先順位（深刻度の高い順）。
 *
 * 1つのコメントに複数のラベルが付与されたとき、UI 表示や verdict 計算に使う
 * 主要ラベル（`primary`）はこの配列の先頭から探して最初に見つかったものを採用する。
 *
 * 設計 ground truth: `dev-docs/phase-3-multilabel.md` L240
 * 「primaryは最も深刻なもの: harassment > spoiler > backseat > spam > off_topic > safe」
 *
 * **重要**: この順序は以下の3箇所と完全に揃える必要がある:
 *   1. `prompt-builder.ts` — LLM に渡すシステムプロンプト本文の優先順位記述
 *   2. `judgment-parser.ts` — LLM 応答から primary が欠落していた場合の補完ロジック
 *   3. `categoryToVerdict` 系の verdict 計算（Phase 3 後半で導入予定）
 *
 * これらが drift すると LLM が返した primary とクライアントが推定した primary が
 * 食い違い、誤フィルタの原因になる。本ファイルは「単一の真実」として、他の3箇所は
 * すべてここを import すること。
 */

import type { JudgmentLabel } from '../types.js';

/**
 * 深刻度の高い順に並べた JudgmentLabel 配列。`primary` 決定に使用。
 *
 * 例: labels が `['backseat', 'harassment']` のとき → primary は `'harassment'`
 *     （`'harassment'` の方が配列内で先に出現するため）
 */
export const LABEL_PRECEDENCE: readonly JudgmentLabel[] = [
  'harassment',
  'spoiler',
  'backseat',
  'spam',
  'off_topic',
  'safe',
] as const;

/**
 * LABEL_PRECEDENCE に基づいて labels[] から primary を導出する。
 *
 * - labels が空配列 → `'safe'` を返す（防御的フォールバック）
 * - labels に LABEL_PRECEDENCE のどのラベルも含まれない → `'safe'`
 *   （JudgmentLabel 以外のハルシネーション値が混入したケースの保険）
 *
 * @param labels 1メッセージに付与されたマルチラベル
 * @returns 深刻度が最も高いラベル（labels の中に存在するもの）
 */
export function derivePrimary(labels: readonly JudgmentLabel[]): JudgmentLabel {
  for (const candidate of LABEL_PRECEDENCE) {
    if (labels.includes(candidate)) return candidate;
  }
  return 'safe';
}
