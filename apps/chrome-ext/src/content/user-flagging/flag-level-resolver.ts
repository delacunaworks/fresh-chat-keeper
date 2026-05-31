/**
 * Phase 3.5（v0.5.0）フラグレベル解決層。
 *
 * 1 視聴者のフラグレベル（`FlagEvaluationResult`）を返す。`UserStatsEntry.cached`
 * を TTL 5 分の範囲で再利用し、期限切れ / period 不一致 / 未計算なら
 * `evaluateFlagLevel` で再計算してから {@link setCached} で書き戻す。
 *
 * 呼び出し元: B5（DOM コメント表示時のフラグ色決定）と B7（StatsPanel）。
 *
 * 設計判断（B3 持ち越し G-1 採用）:
 * - cached 無効化トリガのうち「新フラグ受領時」「設定変更時」は store 側が
 *   担う（recordJudgment 内で cached=null / clearAllCached）。本層が担うのは
 *   **TTL 5 分** + **period 不一致** の判定のみ。設定変更時の同期は archive.ts
 *   onChanged listener が clearAllCached を呼ぶことで担保
 */

import {
  emptyFlaggedCounts,
  evaluateFlagLevel,
  type CachedStats,
  type FlagEvaluationResult,
} from '@fresh-chat-keeper/judgment-engine';
import {
  loadStreamerStats,
  setCached,
} from '../../shared/user-stats-store.js';
import type { Settings } from '../../shared/settings.js';
import { SessionTracker } from './session-tracker.js';

/** cached エントリの TTL（5 分）。設計文書 L460-469 準拠。 */
export const CACHED_TTL_MS = 5 * 60 * 1000;

/**
 * 1 視聴者のフラグレベルを解決する。
 *
 * 流れ:
 * 1. {@link loadStreamerStats} で配信者スコープを読み出し
 * 2. user 未存在（観測ゼロ）→ `clean` を即返し、setCached は呼ばない
 * 3. `entry.cached` が TTL 内かつ scope（period）一致 → cached を返す（再計算なし）
 * 4. それ以外 → evaluateFlagLevel で再計算 → CachedStats 組み立て → setCached
 *
 * @param now テスト固定用。本番省略時は `new Date()`
 */
export async function resolveFlagLevel(
  streamerChannelId: string,
  userChannelId: string,
  settings: Settings,
  sessionTracker: SessionTracker,
  now: Date = new Date(),
): Promise<FlagEvaluationResult> {
  // userFlagging は B5 で非 optional 化されたが、popup から書き戻された素の
  // 値が型上欠落しているケース（古い popup 経路 / 手動編集）に備え optional
  // chaining で扱う。欠落なら clean を即返す（破壊的に動かない）。
  const flagging = settings.userFlagging;
  if (!flagging) {
    return cleanResult();
  }
  const period = flagging.scope;
  const sensitivity = flagging.sensitivity;

  const stats = await loadStreamerStats(streamerChannelId);
  const entry = stats.users[userChannelId];
  if (!entry) {
    // 観測ゼロのユーザー: フラグ判定の意味がないので clean を即返す。
    // setCached しない（ユーザー entry が無いと no-op になるので呼んでも害はないが、
    // 呼ばないことで storage I/O を 1 回減らす）
    return cleanResult();
  }

  // cached 有効性チェック: TTL 内 かつ scope 一致
  if (
    entry.cached &&
    entry.cached.period === period &&
    now.getTime() - entry.cached.calculatedAt < CACHED_TTL_MS
  ) {
    return {
      level: entry.cached.flagLevel,
      severityScore: entry.cached.severityScore,
      totalMessages: entry.cached.totalMessages,
      totalFlagged: entry.cached.totalFlagged,
    };
  }

  // 再計算
  const sessionStats =
    period === 'session'
      ? sessionTracker.getSessionStats(userChannelId) ?? undefined
      : undefined;
  const result = evaluateFlagLevel(
    {
      stats: entry,
      period,
      sensitivity,
      sessionStartTime: sessionTracker.getSessionStartTime(),
      sessionStats,
    },
    now,
  );

  // CachedStats を組み立てて書き戻し。flaggedCounts は extractPeriodStats の窓抽出
  // を再現する必要があるが、本層は evaluator から直接受けないので「集計実数」を
  // 改めて作る代わりに、totalMessages/totalFlagged だけ評価結果から引き取り、
  // flaggedCounts は集計詳細表示用に entry.dailyStats を再合算してもよい設計だが、
  // B5/B7 が必要とするのは flagLevel / totalMessages / totalFlagged が中心なので、
  // ここでは flaggedCounts を空にして保存しても表示には影響しない（next 再計算で
  // 改めて埋まる）。将来 statsPanel で内訳を出すなら別途 derive する。
  const cached: CachedStats = {
    calculatedAt: now.getTime(),
    period,
    totalMessages: result.totalMessages,
    flaggedCounts: emptyFlaggedCounts(),
    totalFlagged: result.totalFlagged,
    flagLevel: result.level,
    severityScore: result.severityScore,
  };
  await setCached(streamerChannelId, userChannelId, cached);

  return result;
}

/** 観測ゼロ視聴者用の clean 結果（severityScore=0 / 全 0）。 */
function cleanResult(): FlagEvaluationResult {
  return { level: 'clean', severityScore: 0, totalMessages: 0, totalFlagged: 0 };
}
