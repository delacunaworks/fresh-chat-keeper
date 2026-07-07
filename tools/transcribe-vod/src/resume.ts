/**
 * レジューム判定（AR-2・純ロジック）。
 *
 * チャンクごとの転写結果を作業ディレクトリに `chunk-<NNN>.json` でキャッシュし、
 * 再実行時は未転写チャンクだけ Scribe を呼ぶ（長尺 VOD の中断・二重課金対策）。
 * ファイル I/O は呼び出し側（index.ts）が行い、ここは純粋な判定のみ。
 */

import type { Chunk } from './plan.js';

/** キャッシュファイル名（例: chunk-007.json）。 */
export function chunkCacheFileName(index: number): string {
  return `chunk-${String(index).padStart(3, '0')}.json`;
}

/** ファイル名リストからキャッシュ済みチャンク index の集合を作る。 */
export function parseCachedChunkIndices(fileNames: string[]): Set<number> {
  const set = new Set<number>();
  for (const name of fileNames) {
    const m = /^chunk-(\d+)\.json$/.exec(name);
    if (m) set.add(Number(m[1]));
  }
  return set;
}

/** 計画のうち、まだキャッシュされていない（転写が必要な）チャンクを返す。 */
export function chunksNeedingTranscription(plan: Chunk[], cached: Set<number>): Chunk[] {
  return plan.filter((c) => !cached.has(c.index));
}
