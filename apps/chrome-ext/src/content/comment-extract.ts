/**
 * F-1 表示用のコメント抽出ヘルパー。
 *
 * - {@link extractDisplayText}: `#message` のテキスト＋絵文字/スタンプ（`<img alt>`）を
 *   連結した「表示用テキスト」。判定パイプラインの text（`textContent`、絵文字なし）とは
 *   別物として扱う（パイプライン挙動は変えない）。
 * - {@link getReplayTimestampSeconds}: コメント行自身が持つリプレイ時刻（`#timestamp`、
 *   例 "1:56:15"）を秒で返す。DOM 出現時の `video.currentTime` と違い、
 *   (a) コメント毎に正確 (b) シークで再放出されても同じ値 → 重複排除キーに使える。
 *
 * DOM 依存関数は repo の方針どおり手動テスト担保（jsdom 非導入）。純関数
 * {@link parseTimestampToSeconds} のみ unit test 対象。
 */

/** nodeType 定数（グローバル Node に依存しない）。 */
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** `#message` 配下のテキスト + 絵文字 alt を文書順で連結（表示用）。 */
export function extractDisplayText(messageEl: Element): string {
  let out = '';
  const walk = (node: globalThis.Node): void => {
    if (node.nodeType === TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as Element;
    if (el.tagName === 'IMG') {
      // YouTube のカスタムスタンプは alt にショートカット（例 ":_スバル草草の草:"）、
      // 標準絵文字は alt に Unicode 文字が入る。
      const alt = (el as HTMLImageElement).alt;
      if (alt) out += alt;
      return;
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  };
  for (let c = messageEl.firstChild; c; c = c.nextSibling) walk(c);
  return out.replace(/\s+/g, ' ').trim();
}

/** "h:mm:ss" / "m:ss" / 先頭 "-"（配信前オフセット）を秒にパース。形式外は null。 */
export function parseTimestampToSeconds(raw: string): number | null {
  const m = raw.trim().match(/^(-)?(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const a = Number(m[2]);
  const b = Number(m[3]);
  const c = m[4] !== undefined ? Number(m[4]) : null;
  const secs = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  return m[1] ? -secs : secs;
}

/** コメント renderer 行のルート候補（#timestamp を持つ祖先）。 */
const RENDERER_SELECTOR =
  'yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer';

/**
 * コメント行の `#timestamp`（リプレイ時刻表示）を秒で返す。無し/形式外は null。
 *
 * 注意: ライブで「タイムスタンプ表示」を有効にした場合は実時刻（例 "23:56"）が
 * 入り区別できないため、呼び出し側で `video.currentTime` との乖離ガード
 * （±15 分以内のみ採用）を掛けること。リプレイのコメントは再生位置近傍にしか
 * 描画されないため、このガードで実時刻の誤採用を弾ける。
 */
export function getReplayTimestampSeconds(messageEl: Element): number | null {
  const root = messageEl.closest(RENDERER_SELECTOR);
  const raw = root?.querySelector('#timestamp')?.textContent;
  if (!raw) return null;
  return parseTimestampToSeconds(raw);
}
