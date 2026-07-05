/**
 * チャンク計画・コスト見積り（AR-2・純ロジック）。
 *
 * VOD を 10 分チャンクに分割する（AR-1 の 10 分バケットと整合させ、チャンク開始
 * オフセット = バケット境界になるようにする）。
 */

/** チャンク幅（秒）。AR-1 の BUCKET_SECONDS=600 と揃える。 */
export const CHUNK_SECONDS = 600;

/** Scribe v2 の料金目安（$/h）。W-Spike 確定値。 */
export const SCRIBE_USD_PER_HOUR = 0.22;

/** 1 チャンクの計画。 */
export interface Chunk {
  /** 0 始まりのチャンク番号。 */
  index: number;
  /** VOD 先頭からの開始秒（= index * CHUNK_SECONDS）。 */
  startSec: number;
  /** チャンクの長さ（秒）。末尾チャンクは端数で短くなる。 */
  durationSec: number;
}

/**
 * 総秒数を 10 分チャンクに分割する。端数は最後のチャンクが短くなる。
 * 0 以下は空配列。
 */
export function planChunks(totalSeconds: number, chunkSeconds = CHUNK_SECONDS): Chunk[] {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return [];
  const chunks: Chunk[] = [];
  let index = 0;
  for (let start = 0; start < totalSeconds; start += chunkSeconds) {
    chunks.push({
      index,
      startSec: start,
      durationSec: Math.min(chunkSeconds, totalSeconds - start),
    });
    index++;
  }
  return chunks;
}

/** 転写コスト見積り（USD）。負値は 0 として扱う。 */
export function estimateCostUsd(totalSeconds: number, usdPerHour = SCRIBE_USD_PER_HOUR): number {
  const sec = Math.max(0, Number.isFinite(totalSeconds) ? totalSeconds : 0);
  return (sec / 3600) * usdPerHour;
}

/** 秒を H:MM:SS 表記にする（見積り表示用）。 */
export function formatDuration(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return `${h}:${mm}:${ss}`;
}
