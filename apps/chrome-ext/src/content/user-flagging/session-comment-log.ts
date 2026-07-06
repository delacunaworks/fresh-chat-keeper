/**
 * 配信内コメントログ（F-1 / 決定4b、2026-07-02）。
 *
 * StatsPanel の「この配信でのコメント」セクション用の **表示専用** メモリバッファ。
 * 測定 #003 の知見（揶揄・煽りの意図はコメント単体では判別不能、同一ユーザーの配信内
 * 発言列を並べると一目で分かる）を、ユーザー自身が StatsPanel から確認できるようにする。
 *
 * **ガードレール（決定4b・実装で厳守）**:
 * 1. 横断なし: 当該配信のスコープのみ（このバッファは content script のセッション内のみ）。
 * 2. 永続化なし: メモリ内のみ。chrome.storage に書かない。teardown（ページ離脱/モード切替）で
 *    {@link clearSessionCommentLog} により破棄。
 * 3. 端末内のみ・表示のみ: 外部送信なし・エクスポート/コピー機能なし（本モジュールは
 *    read API のみ提供し、シリアライズ/コピー用 API を意図的に持たない）。
 * 4. 入口は文脈的に: StatsPanel（⋯メニュー →「📊 統計を見る」）内のセクションからのみ到達。
 *
 * 既存の視聴者フラグ機能（fck_user_stats / flag-evaluator）とは別レイヤー。あちらは永続
 * 集計スコア、こちらは離脱で消える表示用バッファ。
 *
 * パフォーマンス（高流速配信 #001: 459 件/分）: O(1) push + 上限時の安価な eviction。
 * author→リング の Map で per-user 上限、Map の LRU 順で全体上限を守る。
 */

import type { JudgmentLabel } from '@fresh-chat-keeper/judgment-engine';

/** 1 コメントの表示レコード。 */
export interface SessionComment {
  /** コメント本文（フィルタ書き換え前の原文）。 */
  text: string;
  /** 記録時刻（Unix ms）。表示は時刻順。 */
  time: number;
  /**
   * FCK の判定 primary（判定済みのみ）。未判定/通常コメントは undefined。
   * 'safe' も明示的に入りうる（Stage 2 が safe と判定した等）。
   */
  primary?: JudgmentLabel;
}

/** per-user の保持上限（直近 N 件・FIFO）。 */
export const PER_USER_MAX = 100;
/** 全体の保持上限（メモリ境界）。超過時は最古アクティブ author を evict。 */
export const TOTAL_MAX = 30_000;

/**
 * author（@ハンドル）→ 時刻順コメント配列。
 * JS Map は挿入順を保つので、push 毎に author を末尾へ入れ直すことで
 * 「先頭 = 最も長く更新されていない author（LRU）」になる。
 */
const byAuthor = new Map<string, SessionComment[]>();
/** 全 author 合算の件数（全体上限チェック用に O(1) で保持）。 */
let totalCount = 0;

/**
 * コメントを記録する（O(1) push + 上限時 eviction）。
 *
 * @param author 投稿者識別子（@ハンドル）。空なら何もしない（per-user 表示できないため）。
 * @param text   コメント本文。
 * @param opts.time 記録時刻（既定 Date.now()。テスト用に注入可）。
 */
export function recordSessionComment(
  author: string,
  text: string,
  opts?: { time?: number },
): void {
  if (!author) return;
  const time = opts?.time ?? Date.now();

  // author を Map 末尾へ移動（LRU 更新）。
  let arr = byAuthor.get(author);
  if (arr) {
    byAuthor.delete(author);
  } else {
    arr = [];
  }
  byAuthor.set(author, arr);

  arr.push({ text, time });
  totalCount++;

  // per-user 上限: 最古を 1 件落とす。
  if (arr.length > PER_USER_MAX) {
    arr.shift();
    totalCount--;
  }

  // 全体上限: 超過している間、最古アクティブ author（Map 先頭）を丸ごと evict。
  // 直近に触れた author（末尾）は落とさない。
  while (totalCount > TOTAL_MAX) {
    const oldest = byAuthor.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === author) break;
    const removed = byAuthor.get(oldest);
    byAuthor.delete(oldest);
    if (removed) totalCount -= removed.length;
  }
}

/**
 * 記録済みコメントに FCK 判定マーカーを付ける。
 *
 * 判定は記録の直後に確定するため、同一 text の **最新の未マーク** 要素に付与する
 * （同一ユーザーが同文を連投した場合の取り違えを避ける）。見つからなければ最新一致に付与。
 *
 * @param author 投稿者識別子（空なら no-op）。
 * @param text   マーク対象のコメント本文。
 * @param primary 付与する primary ラベル。
 */
export function markSessionComment(author: string, text: string, primary: JudgmentLabel): void {
  if (!author) return;
  const arr = byAuthor.get(author);
  if (!arr) return;
  let latestMatch = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].text !== text) continue;
    if (arr[i].primary === undefined) {
      arr[i].primary = primary;
      return;
    }
    if (latestMatch === -1) latestMatch = i;
  }
  // 全て既マークなら最新一致を上書き（表示の一貫性）。
  if (latestMatch >= 0) arr[latestMatch].primary = primary;
}

/**
 * 指定 author の配信内コメントを時刻順（古い→新しい）で返す（コピー）。
 * StatsPanel open 時のみ呼ばれる低頻度パス。
 */
export function getSessionComments(author: string): SessionComment[] {
  const arr = byAuthor.get(author);
  if (!arr) return [];
  return arr.map((c) => ({ ...c }));
}

/**
 * バッファを全破棄する（teardown = ページ離脱 / モード切替）。
 * 永続化しない設計の中核（決定4b ガードレール2）。
 */
export function clearSessionCommentLog(): void {
  byAuthor.clear();
  totalCount = 0;
}

// ─── テスト用 ───────────────────────────────────────────────────
export const __test__ = {
  totalCount: (): number => totalCount,
  authorCount: (): number => byAuthor.size,
};
