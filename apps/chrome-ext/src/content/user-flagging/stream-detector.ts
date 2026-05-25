/**
 * Phase 3.5（v0.5.0）配信切替検出。
 *
 * YouTube は SPA で動画ページ間を遷移する。`getChannelIdFromDom()` を 3 秒
 * 周期で polling し、変化があれば `SessionTracker.startNewSession(newId)` を
 * 呼んで session 統計をリセットする。mode-detector.ts には配信切替フックが
 * 存在しない（URL ベース判定のみ）ため、本モジュールが配信切替の単一の真実。
 *
 * 設計判断:
 * - YouTube の SPA 遷移はユーザー操作が伴うため頻繁ではない。3 秒 polling で
 *   実体験ロスは最大 3 秒程度（数件の判定が旧 session に流れる程度）。代替の
 *   MutationObserver は誤発火・再構築コスト高で割に合わない
 * - `getChannelIdFromDom()` は author-extract.ts に既にあるため再利用（B4 では
 *   新規 DOM 抽出ロジックを書かない、改訂2 / 受入基準）
 * - 配信者表示名は `document.title` から最低限抽出（"video title - YouTube" の
 *   "- YouTube" を除く）。完全な display name は B7 statsPanel で個別に取りに
 *   行ければ十分（本モジュールは無理に DOM を漁らない）
 *
 * DOM 依存: `setInterval` / `getChannelIdFromDom`（内部で `window.parent`）/
 * `document.title`。`window` 直接参照は polling timer のみ。
 */

import { getChannelIdFromDom } from '../author-extract.js';
import { SessionTracker } from './session-tracker.js';

/** polling 周期（ミリ秒）。設計判断は JSDoc 冒頭参照。 */
const POLLING_INTERVAL_MS = 3000;

// ─── モジュールスコープ状態 ─────────────────────────────────────

let currentStreamerChannelId: string | null = null;
let currentStreamerDisplayName = '';
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let trackerRef: SessionTracker | null = null;

// ─── 公開 API ─────────────────────────────────────────────────────

/**
 * archive.ts 起動時に 1 度だけ呼ぶ。
 *
 * - 即時に 1 回チェックして初期 streamerChannelId を確定（成功時 SessionTracker
 *   に startNewSession を発火、warn は出さない）
 * - その後 `POLLING_INTERVAL_MS` 周期で polling
 */
export function initStreamDetector(sessionTracker: SessionTracker): void {
  trackerRef = sessionTracker;
  // 即時 1 回チェック（archive.ts 起動直後に streamerChannelId を埋める）
  checkAndApply();
  // 既に polling 中なら二重起動しない
  if (intervalHandle !== null) return;
  intervalHandle = setInterval(checkAndApply, POLLING_INTERVAL_MS);
}

/**
 * 現在の配信者 channel ID（UC ID）。未取得は null。
 * aggregator が `recordJudgment` の宛先決定に使う。
 */
export function getCurrentStreamerChannelId(): string | null {
  return currentStreamerChannelId;
}

/**
 * 現在の配信者表示名。`document.title` から最低限抽出した値。
 * B7 statsPanel が表示するときは fresh に取り直してもよい。
 */
export function getCurrentStreamerDisplayName(): string {
  return currentStreamerDisplayName;
}

/**
 * polling を停止する（拡張シャットダウン / テスト用）。
 * intervalHandle と trackerRef は null に戻す。
 */
export function disposeStreamDetector(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  trackerRef = null;
  currentStreamerChannelId = null;
  currentStreamerDisplayName = '';
}

// ─── 内部 ─────────────────────────────────────────────────────────

/**
 * `getChannelIdFromDom()` を読んで前回値と比較、変化があれば反映する。
 * polling timer の毎回 + initStreamDetector 直後で呼ばれる。
 */
function checkAndApply(): void {
  const detected = getChannelIdFromDom();
  const newId = detected && detected.length > 0 ? detected : null;
  if (newId === currentStreamerChannelId) return;

  currentStreamerChannelId = newId;
  currentStreamerDisplayName = newId ? extractStreamerDisplayName() : '';

  // null → 値 / 値 → 値 のとき SessionTracker を切り替える。
  // 値 → null は「DOM が一時的に空っぽ（描画前など）」を含むので、startNewSession は
  // 呼ばない（無駄な session reset を避ける）。
  if (newId !== null && trackerRef !== null) {
    trackerRef.startNewSession(newId);
  }
}

/**
 * `document.title` から動画タイトル部分を取り出し、配信者表示名の暫定値とする。
 * YouTube のタイトルは `"<動画タイトル> - YouTube"` 形式。動画タイトルが配信者名と
 * 一致するわけではないが、B5/B7 で正確な値を取り直すまでの placeholder として十分。
 */
function extractStreamerDisplayName(): string {
  try {
    // node / 非ブラウザ環境で window / document が未定義のときは catch に落とす。
    // typeof チェックを噛ませてグローバル参照の ReferenceError を回避する。
    const w = typeof window !== 'undefined' ? window : undefined;
    const d = typeof document !== 'undefined' ? document : undefined;
    const title = w?.parent?.document?.title ?? d?.title ?? '';
    // 末尾 " - YouTube" を除去（trim 込み）。タイトル全体が "YouTube" なら空に倒す
    return title.replace(/\s*-\s*YouTube\s*$/, '').trim();
  } catch {
    return '';
  }
}

// ─── テスト用 ───────────────────────────────────────────────────

/** @internal テスト用: 手動で 1 回チェックを発火（polling を待たない）。 */
export const __test__ = {
  pollOnce(): void {
    checkAndApply();
  },
  getIntervalHandle(): ReturnType<typeof setInterval> | null {
    return intervalHandle;
  },
  setStateForTest(id: string | null, displayName: string): void {
    currentStreamerChannelId = id;
    currentStreamerDisplayName = displayName;
  },
  POLLING_INTERVAL_MS,
};
