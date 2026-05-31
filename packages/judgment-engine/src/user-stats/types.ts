/**
 * Phase 3.5（v0.5.0）視聴者フラグ機能の型定義。
 *
 * 設計 ground truth: `dev-docs/phase-3-5-user-flagging.md` §「データ構造」
 *
 * このモジュールは judgment-engine の他層と同じく **DOM / chrome.* 非依存**。
 * chrome.storage への永続化・author 識別子抽出・session 管理は chrome-ext 側
 * （B3 以降のバッチ）で扱う。本層はカウント集計とフラグレベル判定の
 * 純粋データ・純粋ロジックのみを提供する。
 */

import type { JudgmentLabel } from '../types.js';

/** 視聴者フラグの 4 段階レベル。{@link evaluateFlagLevel} の戻り値。 */
export type FlagLevel = 'clean' | 'grey' | 'yellow' | 'red';

/**
 * カテゴリ別フラグ件数。LABEL_PRECEDENCE（harassment > spoiler > backseat >
 * spam > off_topic > safe）で derive された primary ラベルごとにインクリメント
 * される想定（safe は集計対象外）。フィールド名は {@link SEVERITY_WEIGHTS} と
 * 一致させ、JudgmentLabel の snake_case（off_topic）を camelCase（offTopic）に
 * 寄せる（chrome-ext 既存 settings の `categories.offTopic` と同じ表記）。
 */
export interface FlaggedCounts {
  spoiler: number;
  harassment: number;
  spam: number;
  offTopic: number;
  backseat: number;
}

/** 日別の発言数 + カテゴリ別フラグ件数。`date` は **UTC** ベースの "YYYY-MM-DD"。 */
export interface DailyStats {
  /** ISO 8601 日付（UTC、"YYYY-MM-DD"）。期間抽出時のキーとも一致させる。 */
  date: string;
  messageCount: number;
  flaggedCounts: FlaggedCounts;
}

/**
 * `UserStatsEntry.cached` に保存する派生情報。再計算コスト削減のためのキャッシュで、
 * 期間/感度/新フラグ発生で無効化する（無効化ロジックは B3 以降）。
 */
export interface CachedStats {
  /** ミリ秒 epoch。キャッシュ TTL 判定用。 */
  calculatedAt: number;
  period: 'session' | '7d' | '30d';
  totalMessages: number;
  flaggedCounts: FlaggedCounts;
  totalFlagged: number;
  flagLevel: FlagLevel;
  severityScore: number;
}

/**
 * 配信者スコープ（`fck_user_stats:{streamerChannelId}`）下に保持される
 * 1 視聴者分の集計エントリ。
 *
 * **`channelId` の実態**: 2026-05 以降の YouTube DOM 変更（TROUBLESHOOTING #010、
 * `dev-docs/phase-3-5-user-flagging.md` 改訂2）により、本フィールドの値は実装上
 * **`@ハンドル名`**（例: `@example_handle`）になる。スキーマフィールド名は
 * `channelId` で維持（既存 `fck_user_blocks` と同じ。型の上は単なる文字列）。
 * 同一配信者ページ内では一貫するためセッション・配信者単位の判定は問題なく
 * 動作するが、ハンドル名変更で追跡が切れる / 別配信間で同じハンドルでも
 * **横断同一視はしない**（配信者スコープ独立保存）。
 */
export interface UserStatsEntry {
  /**
   * 視聴者の識別子。実体は `@ハンドル名`（改訂2 参照）。
   * 配信者スコープ内で一意。
   */
  channelId: string;
  /** 最新観測時の表示名（変更追跡用）。 */
  displayNameLatest: string;
  /** 初回観測時の表示名（鯖落ち時の照合用）。 */
  displayNameFirstSeen: string;
  /** 初回観測時刻（ミリ秒 epoch）。 */
  firstSeenAt: number;
  /** 最新観測時刻（ミリ秒 epoch）。 */
  lastSeenAt: number;
  /**
   * 日別集計マップ。key は "YYYY-MM-DD"（UTC）。
   * 期間選択（session / 7d / 30d）はこのマップを合算して導出する。
   */
  dailyStats: Record<string, DailyStats>;
  /** 派生情報のキャッシュ。未計算 or 無効化済みなら null。 */
  cached: CachedStats | null;
}

/**
 * セッション中（インメモリ）の視聴者集計。配信切替で破棄される。
 * `period: 'session'` 判定時の入力。`userId` は同じく `@ハンドル名`。
 */
export interface SessionUserStats {
  userId: string;
  messageCount: number;
  flaggedCounts: FlaggedCounts;
}

/**
 * {@link evaluateFlagLevel} の入力。
 *
 * - `period === 'session'`: `sessionStats` から集計を取り出す
 *   （未指定なら 0 件扱い → grey/clean に倒れる）
 * - `period === '7d' | '30d'`: `stats.dailyStats` から `now` 起点で N 日分を合算
 *
 * `sensitivity` は感度スライダーの値（緩め 0.8 / 標準 0.4 / 厳格 0.2 など）。
 * `yellow` 閾値は `red` の半分が標準だが、本層は両方を独立に受ける。
 */
export interface FlagEvaluationInput {
  stats: UserStatsEntry;
  period: 'session' | '7d' | '30d';
  sensitivity: {
    /** normalizedScore がこの値以上で yellow（要 totalFlagged>=2）。 */
    yellow: number;
    /** normalizedScore がこの値以上で red（要 totalFlagged>=3）。 */
    red: number;
  };
  /** セッション開始時刻（B3 以降の SessionTracker と整合させるため optional 維持）。 */
  sessionStartTime?: number;
  /** `period === 'session'` のとき必須。それ以外では無視される。 */
  sessionStats?: SessionUserStats;
}

/**
 * {@link evaluateFlagLevel} の戻り値。
 *
 * 少サンプル特別判定（totalMessages < 3 で harassment あり）では
 * {@link severityScore} に {@link Number.POSITIVE_INFINITY} を入れる
 * （通常の正規化スコアと比較しても確実に上位になる衛兵値）。
 */
export interface FlagEvaluationResult {
  level: FlagLevel;
  severityScore: number;
  totalMessages: number;
  totalFlagged: number;
}

/** 空の {@link FlaggedCounts} を返すヘルパー。全カテゴリ 0。 */
export function emptyFlaggedCounts(): FlaggedCounts {
  return {
    spoiler: 0,
    harassment: 0,
    spam: 0,
    offTopic: 0,
    backseat: 0,
  };
}

/**
 * LABEL_PRECEDENCE で導出された primary ラベル（`JudgmentLabel`）を
 * {@link FlaggedCounts} のキー（camelCase）に変換する。`'safe'` は集計対象外
 * なので **null** を返す（呼び出し側がスキップ）。
 *
 * - `off_topic` → `offTopic`（snake_case ↔ camelCase の差を吸収）
 * - 他のラベルは同名（`spoiler` / `harassment` / `spam` / `backseat`）
 *
 * `_exhaustive: never` で `JudgmentLabel` 拡張時のチェック漏れを型レベルで阻止。
 * 新しいラベルを `JudgmentLabel` に追加したら本関数も更新が必要になる。
 */
export function primaryToCountKey(
  label: JudgmentLabel,
): keyof FlaggedCounts | null {
  switch (label) {
    case 'safe':
      return null;
    case 'spoiler':
      return 'spoiler';
    case 'harassment':
      return 'harassment';
    case 'spam':
      return 'spam';
    case 'off_topic':
      return 'offTopic';
    case 'backseat':
      return 'backseat';
    default: {
      const _exhaustive: never = label;
      void _exhaustive;
      return null;
    }
  }
}
