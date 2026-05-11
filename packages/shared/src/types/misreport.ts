import type { UserProgress } from './chat.js';

/**
 * ユーザーが「誤判定」と報告したコメントの記録。
 * chrome.storage に最大 100 件保存し、将来的にサーバーへ送信することを想定した型定義。
 */
export interface MisreportEntry {
  /** 誤判定と報告されたコメント本文 */
  text: string;
  /** Stage 2 LLM が判定したカテゴリ。Stage 1 のみでブロックされた場合は null */
  spoilerCategory: string | null;
  /** 判定時のゲームID */
  gameId: string;
  /** 判定時のゲーム進行状況。未設定の場合は null */
  progress: Omit<UserProgress, 'gameId'> | null;
  /** 判定時のフィルタモード */
  filterMode: string;
  /** 報告日時（ISO 8601） */
  timestamp: string;

  // ─── Phase 2.5 拡張（v0.3.5、optional で破壊的変更なし）────────
  /**
   * apps/api の /v1/ingest にサーバー送信済みかどうか。
   * - undefined / false: 未送信（opt-in 前 or 送信失敗）
   * - true: opt-in 中に並行送信済み
   * 既存ユーザーの保存値は undefined のまま自然に扱える（破壊的変更なし）。
   */
  synced?: boolean;
  /** 送信時にクライアントが発行した SpoilerJudgmentLog.logId（UUID v4） */
  syncedLogId?: string;
}
