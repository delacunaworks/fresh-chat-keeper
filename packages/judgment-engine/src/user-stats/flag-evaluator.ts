/**
 * Phase 3.5（v0.5.0）視聴者フラグレベル判定の純粋ロジック。
 *
 * 設計 ground truth: `dev-docs/phase-3-5-user-flagging.md` §「フラグレベル
 * 判定アルゴリズム」L336-427 と「データ構造」L88-141 / 改訂2（識別子）。
 *
 * 本モジュールは DOM / chrome.* / window.* 非依存。Date は `now` 引数で
 * 注入可能にしておりテストで UTC 日付計算を固定できる（B2 受入基準）。
 */

import {
  emptyFlaggedCounts,
  type FlaggedCounts,
  type FlagEvaluationInput,
  type FlagEvaluationResult,
  type FlagLevel,
  type UserStatsEntry,
} from './types.js';

/**
 * カテゴリ別の深刻度重み。`severityScore = Σ(count[k] * SEVERITY_WEIGHTS[k])`。
 *
 * 根拠（設計文書 L356-361）:
 * - harassment（暴言）: 視聴者体験への影響が最大 → 4.0
 * - spoiler（ネタバレ）: 悪意の有無に関わらず体験を損なう → 2.5
 * - backseat（指示厨）: ゲーム配信特有の問題 → 2.0
 * - spam: 流速の問題 → 1.5
 * - offTopic: 許容度が高い → 1.0
 *
 * `Readonly` で運用時の改竄を型レベルで防ぐ（チューニングは定数自体の変更で行う）。
 */
export const SEVERITY_WEIGHTS: Readonly<Record<keyof FlaggedCounts, number>> = {
  harassment: 4.0,
  spoiler: 2.5,
  backseat: 2.0,
  spam: 1.5,
  offTopic: 1.0,
};

/** 少サンプル特別判定の閾値（< これでショートカット）。設計文書 L389。 */
const SMALL_SAMPLE_THRESHOLD = 3;
/** yellow 判定の最小 totalFlagged。設計文書 L418。 */
const YELLOW_MIN_FLAGGED = 2;
/** red 判定の最小 totalFlagged。設計文書 L416。 */
const RED_MIN_FLAGGED = 3;

/** ミリ秒 → 日数換算。{@link extractPeriodStats} の窓計算で使用。 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * UTC 基準で `Date` → "YYYY-MM-DD" 文字列に整形する。
 *
 * `DailyStats.date` の key と一致させるため必ず UTC 系を使うこと
 * （ローカル TZ 依存にするとユーザー環境ごとに日付境界がずれ、集計値が
 * 同じデータでも異なって見える）。
 *
 * B3 supplement で export 化。chrome-ext 側の user-stats-store でも
 * 同じ UTC 日付ポリシーで `DailyStats.date` を生成する必要があるため、
 * 単一の真実をここに集約する。
 */
export function formatDateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * UTC ベースの日数加算。`n` 日後（負なら前）の `Date` を返す。
 *
 * B3 supplement で export 化。chrome-ext 側の保持期間プルーニング
 * （30 日超の `dailyStats` を破棄）等で再利用する。
 */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

/**
 * 期間 N 日分の `DailyStats` を `now` 起点で合算する。
 *
 * 「N 日以内」は **`now` の UTC 日付を含む直近 N 日**（例: N=7, now=2026-05-24
 * → 2026-05-18 〜 2026-05-24 の 7 日分）。境界は日付キーの文字列比較で判定する。
 *
 * `period === 'session'` のときは `dailyStats` を見ず {@link FlagEvaluationInput.sessionStats}
 * から取り出す（B3 SessionTracker の出力）。未指定なら空集計（grey/clean に倒れる）。
 */
export function extractPeriodStats(
  input: FlagEvaluationInput,
  now: Date = new Date(),
): { totalMessages: number; flaggedCounts: FlaggedCounts } {
  if (input.period === 'session') {
    if (!input.sessionStats) {
      return { totalMessages: 0, flaggedCounts: emptyFlaggedCounts() };
    }
    // sessionStats は呼び出し側の所有物なので破壊せずコピーして返す
    return {
      totalMessages: input.sessionStats.messageCount,
      flaggedCounts: { ...input.sessionStats.flaggedCounts },
    };
  }

  const days = input.period === '7d' ? 7 : 30;
  // 「直近 N 日」の最古日 = now の (N-1) 日前。両端含む。
  const oldestKey = formatDateKey(addDays(now, -(days - 1)));
  const newestKey = formatDateKey(now);

  const counts = emptyFlaggedCounts();
  let totalMessages = 0;
  for (const [dateKey, daily] of Object.entries(input.stats.dailyStats)) {
    if (dateKey < oldestKey || dateKey > newestKey) continue;
    totalMessages += daily.messageCount;
    counts.spoiler += daily.flaggedCounts.spoiler;
    counts.harassment += daily.flaggedCounts.harassment;
    counts.spam += daily.flaggedCounts.spam;
    counts.offTopic += daily.flaggedCounts.offTopic;
    counts.backseat += daily.flaggedCounts.backseat;
  }

  return { totalMessages, flaggedCounts: counts };
}

/**
 * 視聴者のフラグレベル（clean / grey / yellow / red）を判定する。
 *
 * アルゴリズム（設計文書 L382-427）:
 *
 * 1. {@link extractPeriodStats} で期間内の totalMessages / flaggedCounts を抽出
 * 2. **少サンプル特別判定**（totalMessages < 3）: harassment が複数あれば red、
 *    1 件あれば yellow、それ以外は grey。severityScore は通常スコアと判別できる
 *    よう {@link Number.POSITIVE_INFINITY}（衛兵値）
 * 3. 通常判定:
 *    - `severityScore = Σ(count[k] * SEVERITY_WEIGHTS[k])`
 *    - `normalizedScore = severityScore / totalMessages`
 *    - `totalFlagged = Σ(count[k])`
 *    - `normalizedScore >= sensitivity.red && totalFlagged >= 3` → red
 *    - `normalizedScore >= sensitivity.yellow && totalFlagged >= 2` → yellow
 *    - `totalFlagged > 0` → grey
 *    - それ以外 → clean
 *
 * `now` は UTC 日付計算の固定化（テスト容易性）。本番は引数省略で `new Date()`。
 */
export function evaluateFlagLevel(
  input: FlagEvaluationInput,
  now: Date = new Date(),
): FlagEvaluationResult {
  const { totalMessages, flaggedCounts } = extractPeriodStats(input, now);

  // 少サンプル特別判定
  if (totalMessages < SMALL_SAMPLE_THRESHOLD) {
    if (flaggedCounts.harassment >= 2) {
      return {
        level: 'red',
        severityScore: Number.POSITIVE_INFINITY,
        totalMessages,
        totalFlagged: 2,
      };
    }
    if (flaggedCounts.harassment >= 1) {
      return {
        level: 'yellow',
        severityScore: Number.POSITIVE_INFINITY,
        totalMessages,
        totalFlagged: 1,
      };
    }
    return { level: 'grey', severityScore: 0, totalMessages, totalFlagged: 0 };
  }

  const severityScore =
    flaggedCounts.harassment * SEVERITY_WEIGHTS.harassment +
    flaggedCounts.spoiler * SEVERITY_WEIGHTS.spoiler +
    flaggedCounts.backseat * SEVERITY_WEIGHTS.backseat +
    flaggedCounts.spam * SEVERITY_WEIGHTS.spam +
    flaggedCounts.offTopic * SEVERITY_WEIGHTS.offTopic;

  const normalizedScore = severityScore / totalMessages;
  const totalFlagged =
    flaggedCounts.spoiler +
    flaggedCounts.harassment +
    flaggedCounts.spam +
    flaggedCounts.offTopic +
    flaggedCounts.backseat;

  let level: FlagLevel;
  if (normalizedScore >= input.sensitivity.red && totalFlagged >= RED_MIN_FLAGGED) {
    level = 'red';
  } else if (
    normalizedScore >= input.sensitivity.yellow &&
    totalFlagged >= YELLOW_MIN_FLAGGED
  ) {
    level = 'yellow';
  } else if (totalFlagged > 0) {
    level = 'grey';
  } else {
    level = 'clean';
  }

  return { level, severityScore, totalMessages, totalFlagged };
}

/**
 * 複数ユーザーの flag level を純粋計算で一括算出する（storage I/O なし）。
 *
 * popup の配信サマリ用（B7）。各 {@link UserStatsEntry} に対し
 * {@link evaluateFlagLevel} を呼ぶだけで、`cached` の読み書きは一切行わない
 * （popup は表示専用。`cached` の所有は content 側 = flag-level-resolver の責務）。
 *
 * `period: 'session'` は popup には `sessionStats` が無い（content の SessionTracker
 * 専用）ため、呼び出し側で `'7d'` / `'30d'` にフォールバックすること。本関数自体は
 * 渡された period を素直に扱う（session を渡すと sessionStats 無しで grey/clean に
 * 倒れる）。
 *
 * @param users 評価対象の UserStatsEntry 配列（loadStreamerStats の users を渡す想定）
 * @param period 集計期間
 * @param sensitivity 感度しきい値
 * @param now テスト固定用。省略時は `new Date()`
 * @returns 各 entry とその評価結果のペア配列（入力順を保持）
 */
export function evaluateFlagLevelsForUsers(
  users: UserStatsEntry[],
  period: 'session' | '7d' | '30d',
  sensitivity: { yellow: number; red: number },
  now: Date = new Date(),
): Array<{ entry: UserStatsEntry; result: FlagEvaluationResult }> {
  return users.map((entry) => ({
    entry,
    result: evaluateFlagLevel({ stats: entry, period, sensitivity }, now),
  }));
}
