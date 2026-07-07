/**
 * 計画・見積りの表示整形（AR-2・純ロジック）。--dry-run と通常実行の両方で使う。
 */

import { estimateCostUsd, formatDuration, planChunks, type Chunk } from './plan.js';

/** チャンク計画とコストのサマリ行を作る（副作用なし＝テスト・dry-run 兼用）。 */
export function renderPlanSummary(opts: {
  videoId: string;
  durationSeconds: number;
  chunks?: Chunk[];
}): string {
  const chunks = opts.chunks ?? planChunks(opts.durationSeconds);
  const cost = estimateCostUsd(opts.durationSeconds);
  const lines = [
    `videoId : ${opts.videoId}`,
    `長さ    : ${formatDuration(opts.durationSeconds)} (${Math.round(opts.durationSeconds)}s)`,
    `チャンク: ${chunks.length} 個 × 10 分`,
    `見積り  : $${cost.toFixed(2)}（$0.22/h）`,
  ];
  return lines.join('\n');
}
