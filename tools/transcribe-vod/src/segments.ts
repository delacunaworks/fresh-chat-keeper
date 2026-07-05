/**
 * Scribe の word タイムスタンプ → 15〜30 秒粒度の segment 整形（AR-2・純ロジック）。
 *
 * - `t` は **VOD 絶対秒**（チャンク開始オフセット + 語の相対 start）。
 * - タイムスタンプが取れない場合は fallback でチャンク単位 1 segment（t=チャンク開始）。
 */

import type { TranscribeWord } from '@fresh-chat-keeper/api/lib/scribe';

/** segment のターゲット粒度（秒）。15〜30 秒の中央。 */
export const SEGMENT_SECONDS = 20;

/** AR-1 の transcript endpoint に渡す segment（{ t, text }）。 */
export interface Segment {
  /** VOD 先頭からの絶対秒。 */
  t: number;
  /** その窓の発話テキスト。 */
  text: string;
}

/**
 * word 列を SEGMENT_SECONDS 窓でグルーピングし、{ t, text } の配列にする。
 *
 * @param words           1 チャンク分の word（start/end はチャンク先頭からの相対秒）
 * @param chunkStartOffset そのチャンクの VOD 絶対開始秒（例: chunk 3 なら 1800）
 * @param segmentSeconds   グルーピング窓（既定 20 秒）
 */
export function wordsToSegments(
  words: TranscribeWord[],
  chunkStartOffset: number,
  segmentSeconds = SEGMENT_SECONDS,
): Segment[] {
  if (words.length === 0) return [];
  // start 昇順に整列（provider は通常整列済みだが保険）。
  const sorted = [...words].sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let windowIndex = -1;
  let buf: TranscribeWord[] = [];
  let bufMinStart = 0;

  const flush = (): void => {
    if (buf.length === 0) return;
    // word.text をそのまま連結（'spacing' の空白も含む）→ 空白正規化。
    const text = buf
      .map((w) => w.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 0) {
      // t = チャンク絶対開始 + この窓の最初の語の相対 start（小数切り捨てで整数秒）。
      segments.push({ t: chunkStartOffset + Math.floor(bufMinStart), text });
    }
    buf = [];
  };

  for (const w of sorted) {
    const wi = Math.floor(w.start / segmentSeconds);
    if (wi !== windowIndex) {
      flush();
      windowIndex = wi;
      bufMinStart = w.start;
    }
    buf.push(w);
  }
  flush();
  return segments;
}

/**
 * チャンク転写結果から segment を作る。
 * words があれば {@link wordsToSegments}、無ければチャンク単位 fallback（t=チャンク開始）。
 */
export function buildSegmentsForChunk(
  result: { text: string; words?: TranscribeWord[] },
  chunkStartOffset: number,
  segmentSeconds = SEGMENT_SECONDS,
): Segment[] {
  if (result.words && result.words.length > 0) {
    return wordsToSegments(result.words, chunkStartOffset, segmentSeconds);
  }
  const text = result.text.trim();
  return text.length > 0 ? [{ t: chunkStartOffset, text }] : [];
}
