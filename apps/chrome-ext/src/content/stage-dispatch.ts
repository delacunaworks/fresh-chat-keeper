/**
 * Stage 振り分けの純粋な判断ロジック（B8）。
 *
 * archive.ts の processMessage は DOM / chrome.* / MutationObserver 依存で
 * jsdom 非導入方針のため手動テスト担保だが、B8 の 2 つの判断は副作用の無い
 * 純関数に切り出してユニットテスト可能にする（computeMenuPosition と同方針）。
 *
 * 設計 ground truth: `dev-docs/phase-3-multilabel.md`「実装中の設計改訂」B8。
 */

import type { CategorySettings } from '../shared/settings.js';

/**
 * B8a: Stage 1.5（spam）を実行すべきか。
 *
 * `reprocessAll` 由来の遡及一括再処理（isReprocess=true）では **false**。
 * spam 検出は HistoryStore の到着順・時系列に依存し、既存表示済みを一括
 * ループ再処理すると合成タイムスタンプが短時間連番化して rapid_fire /
 * self_copy が誤爆 → 既存コメント全ブロック（問題1の reprocessAll 一括版）。
 * 通常の新規流入（MutationObserver / 初回スキャン、isReprocess=false）で
 * のみ spam を判定する。Stage 1 / Stage 2 の遡及再判定は別途継続する。
 */
export function shouldRunStage1_5(isReprocess: boolean): boolean {
  return !isReprocess;
}

/**
 * B8b: 新カテゴリ（harassment / spam / off_topic / backseat）が 1 つでも
 * ON か。spoiler は対象外。`categories` 未設定（旧ユーザー）は全 OFF 扱い。
 */
export function isAnyNewCategoryEnabled(
  categories: CategorySettings | undefined,
): boolean {
  if (!categories) return false;
  return (
    categories.harassment?.enabled === true ||
    categories.spam?.enabled === true ||
    categories.offTopic?.enabled === true ||
    categories.backseat?.enabled === true
  );
}

/**
 * B8b: gameplay-hints の `stage2_phrases` マッチコメントを Stage 2 へ
 * 送るべきか（spoiler キーワード単体マッチに当たらなかった gray に対して）。
 *
 * 従来は `gameId !== 'none'` かつジャンルテンプレート選択時のみ。B8b で
 * 「新カテゴリが 1 つでも ON なら gameId を問わず（'none' でも）送る」よう
 * 緩和。`stage2_phrases` マッチ限定（templateCount > 0 前提）は維持し、
 * 無条件で全 gray を Stage 2 に送らない（LLM コスト/月間上限と衝突しない）。
 *
 * @param gameId 現在の gameId（'none' = ゲーム未選択/デフォルト）
 * @param anyNewCategoryEnabled {@link isAnyNewCategoryEnabled} の結果
 * @param templateCount 選択中の gameplay-hints テンプレート数
 *   （0 なら gameplay-hints 経路は無効＝従来どおり）
 */
export function shouldTryGameplayHintStage2(
  gameId: string,
  anyNewCategoryEnabled: boolean,
  templateCount: number,
): boolean {
  if (templateCount <= 0) return false;
  return gameId !== 'none' || anyNewCategoryEnabled;
}
