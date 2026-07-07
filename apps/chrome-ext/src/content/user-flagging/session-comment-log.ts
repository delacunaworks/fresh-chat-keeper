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
  /** 記録順序用の Unix ms（内部・React key 用。表示には使わない）。 */
  time: number;
  /**
   * 動画の再生位置（秒）。コメント行の `#timestamp`（リプレイ時刻）優先、
   * 取れなければ記録時の `<video>.currentTime`。表示はこれを h:mm:ss で出す。
   * 取得不能（video 無し等）なら undefined。
   */
  videoTime?: number;
  /**
   * 判定パイプライン側の text（`textContent` ベース・絵文字なし）。表示用 text と
   * 異なる場合のみ格納し、{@link markSessionComment} の照合キーに使う。
   */
  matchKey?: string;
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
/** 重複排除で遡って比較する末尾件数（シーク再放出は直近に固まる）。 */
const DEDUPE_SCAN_WINDOW = 30;
/** videoTime が取れない場合の重複排除ウィンドウ（実時間 ms）。 */
const DEDUPE_WALLCLOCK_MS = 10_000;

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
 * @param text   コメント本文（表示用。絵文字 alt 込み）。
 * @param opts.time 記録順序用の時刻（既定 Date.now()。テスト用に注入可）。
 * @param opts.videoTime 動画の再生位置（秒）。表示・重複排除に使う。取得不能なら省略。
 * @param opts.matchKey 判定パイプライン側 text（表示用と異なる場合のみ）。
 */
export function recordSessionComment(
  author: string,
  text: string,
  opts?: { time?: number; videoTime?: number; matchKey?: string },
): void {
  if (!author) return;
  const time = opts?.time ?? Date.now();
  const videoTime = opts?.videoTime;

  // author を Map 末尾へ移動（LRU 更新）。
  let arr = byAuthor.get(author);
  if (arr) {
    byAuthor.delete(author);
  } else {
    arr = [];
  }
  byAuthor.set(author, arr);

  // ── 重複排除: チャットリプレイはシーク巻き戻しで同じコメント行を DOM に再放出する
  // ため、Observer が新規と誤認して二重記録される。リプレイ時刻（videoTime）は再放出
  // でも同じ値なので「同一内容 + ほぼ同一 videoTime」を重複とみなして落とす。
  // 正当な連投コピペ（別時刻の同文スパム）は時刻が違うので残る。
  const newKey = opts?.matchKey ?? text;
  const scanFrom = Math.max(0, arr.length - DEDUPE_SCAN_WINDOW);
  for (let i = arr.length - 1; i >= scanFrom; i--) {
    const e = arr[i];
    const eKey = e.matchKey ?? e.text;
    if (eKey !== newKey && e.text !== text) continue;
    if (videoTime !== undefined && e.videoTime !== undefined) {
      if (Math.abs(e.videoTime - videoTime) < 1) return; // 同一リプレイ時刻 → 重複
    } else if (videoTime === undefined && e.videoTime === undefined) {
      if (time - e.time < DEDUPE_WALLCLOCK_MS) return; // fallback: 直近の実時間ウィンドウ
    }
  }

  arr.push({
    text,
    time,
    ...(videoTime !== undefined ? { videoTime } : {}),
    ...(opts?.matchKey !== undefined && opts.matchKey !== text ? { matchKey: opts.matchKey } : {}),
  });
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
    // 判定パイプラインは絵文字なし text で呼ぶため、matchKey（あれば）でも照合する。
    if (arr[i].text !== text && arr[i].matchKey !== text) continue;
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
 * 指定 author の配信内コメントを **再生位置順**（videoTime 昇順、無いものは末尾・
 * 記録順維持）で返す（コピー）。シークで記録順が前後しても配信の時系列で表示する。
 * StatsPanel open 時のみ呼ばれる低頻度パス。
 */
export function getSessionComments(author: string): SessionComment[] {
  const arr = byAuthor.get(author);
  if (!arr) return [];
  return arr
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const av = a.c.videoTime;
      const bv = b.c.videoTime;
      if (av !== undefined && bv !== undefined && av !== bv) return av - bv;
      if (av === undefined && bv !== undefined) return 1;
      if (av !== undefined && bv === undefined) return -1;
      return a.i - b.i; // 安定: 記録順
    })
    .map(({ c }) => ({ ...c }));
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
