/**
 * Phase 3.5（v0.5.0）視聴者統計の **インメモリ** セッショントラッカー。
 *
 * `scope: 'session'` のフラグ判定（{@link evaluateFlagLevel} の period='session'）が
 * 参照する `SessionUserStats` を構築する。配信切替（B4 担当）で `startNewSession` を
 * 呼んで破棄する。chrome.storage / DOM には触らない（content script の単一プロセス
 * 内で完結）。
 *
 * 設計 ground truth: `dev-docs/phase-3-5-user-flagging.md` §「セッション追跡」L286-332。
 *
 * 配置: content script ライフサイクル所属。chrome.* / document.* / window.* は使用しない。
 */

import {
  emptyFlaggedCounts,
  type FlaggedCounts,
  type SessionUserStats,
} from '@fresh-chat-keeper/judgment-engine';

export class SessionTracker {
  private sessionStartTime: number = Date.now();
  private streamerChannelId: string | null = null;
  private sessionStatsMap = new Map<string, SessionUserStats>();

  /**
   * 新しいセッションを開始する（配信切替検出時に B4 が呼ぶ）。
   * 旧セッションの統計とタイマー基準を全消去する。
   *
   * @param streamerChannelId B4 の {@link getStreamerChannelId} で利用する識別子
   */
  startNewSession(streamerChannelId: string): void {
    this.sessionStartTime = Date.now();
    this.streamerChannelId = streamerChannelId;
    this.sessionStatsMap.clear();
  }

  /**
   * 1 判定結果をセッション集計に積む。
   * `flagged` は LABEL_PRECEDENCE で導出した primary を `primaryToCountKey` 経由で
   * キー変換した「カテゴリ別 1 件のみ立つ」想定。`safe` の場合は `{}` を渡し、
   * messageCount のみ +1 する。
   *
   * `timestamp` 引数は将来の「セッション開始前の record は無視」等の整合チェック
   * 用に保持（B4 で利用するかは設計判断）。本層では現状参照していない。
   */
  recordMessage(
    userId: string,
    flagged: Partial<FlaggedCounts>,
    _timestamp: number = Date.now(),
  ): void {
    void _timestamp;
    let entry = this.sessionStatsMap.get(userId);
    if (!entry) {
      entry = {
        userId,
        messageCount: 0,
        flaggedCounts: emptyFlaggedCounts(),
      };
      this.sessionStatsMap.set(userId, entry);
    }

    entry.messageCount += 1;
    for (const k of Object.keys(entry.flaggedCounts) as Array<keyof FlaggedCounts>) {
      const v = flagged[k];
      // 負数 / NaN / Infinity は無視（safe input validation。recordJudgment 側と整合）
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        entry.flaggedCounts[k] += v;
      }
    }
  }

  /** 該当 user の session 統計を返す。未観測なら null。 */
  getSessionStats(userId: string): SessionUserStats | null {
    return this.sessionStatsMap.get(userId) ?? null;
  }

  /** セッション開始時刻（ミリ秒 epoch）。 */
  getSessionStartTime(): number {
    return this.sessionStartTime;
  }

  /**
   * 現在の配信者 ID（{@link startNewSession} で渡したもの）。
   * セッション未開始時は `null`。B4 が配信切替検出のフラグとして利用する。
   */
  getStreamerChannelId(): string | null {
    return this.streamerChannelId;
  }

  /**
   * セッション集計の全エントリを Map で返す（popup の iterate 用、B8 担当）。
   *
   * 内部 Map をそのまま返さず **コピーを返す**（B8 が誤って mutate しても
   * SessionTracker 内部が壊れないように）。
   */
  getAllSessionStats(): Map<string, SessionUserStats> {
    return new Map(this.sessionStatsMap);
  }
}
