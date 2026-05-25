/**
 * Phase 3.5（v0.5.0）視聴者統計の集計フック。
 *
 * 判定 emit 経路の **後段 subscriber** として attach される（設計文書 改訂4）。
 * archive.ts の判定結果毎回ここに 1 件渡され、`userFlagging.enabled` が true なら
 * `userStatsStore.recordJudgment` + `sessionTracker.recordMessage` に流す。
 *
 * 構造は `collection-emit.ts` を踏襲: module-scope 状態 + chrome.storage.onChanged
 * 購読 + 最小公開 API（init + record + reset）。**判定ロジックは Phase 2.5 と独立**
 * で、opt-in と userFlagging は独立に ON/OFF できる。
 *
 * 識別子の実態:
 * - `user.channelId` = `getAuthorChannelIdFromElement()` の戻り（@ハンドル名、改訂2）
 * - `streamerChannelId` は stream-detector の {@link getCurrentStreamerChannelId} 経由
 *   （UC ID として安定取得可能）。null（未取得）なら record をスキップ
 */

import {
  primaryToCountKey,
  type FlaggedCounts,
  type JudgmentLabel,
} from '@fresh-chat-keeper/judgment-engine';
import { STORAGE_KEY, type Settings } from '../../shared/settings.js';
import { recordJudgment } from '../../shared/user-stats-store.js';
import { SessionTracker } from './session-tracker.js';
import { getCurrentStreamerChannelId } from './stream-detector.js';

/** 1 判定結果分の最小 input。archive.ts が emit と同じ場所で渡す。 */
export interface RecordAggregateInput {
  user: { channelId: string; displayName: string };
  /**
   * 判定で導出された primary ラベル（safe を含む）。
   * CollectionLabel と JudgmentLabel はメンバー集合が同一なので、archive.ts 側で
   * `as JudgmentLabel` キャストして渡す想定。
   */
  primaryLabel: JudgmentLabel;
  /** 判定時刻（ミリ秒 epoch）。省略時は record 時の Date.now() */
  timestamp?: number;
}

// ─── モジュールスコープ状態 ─────────────────────────────────────

/** userFlagging.enabled のキャッシュ（毎回 chrome.storage を読まない） */
let enabledCached = false;

/** session 追跡用の SessionTracker インスタンス（archive.ts が起動時に渡す） */
let sessionTracker: SessionTracker | null = null;

let storageListenerInstalled = false;

/** streamerChannelId 未取得 warn の重複抑止 */
let warnedMissingStreamerOnce = false;

// ─── 公開 API ─────────────────────────────────────────────────────

/**
 * archive.ts 起動時に 1 度だけ呼ぶ初期化。
 *
 * - 現在の `userFlagging.enabled` 状態をキャッシュ
 * - `chrome.storage.onChanged` を購読し、ON/OFF 切替に追従
 *
 * @param initialSettings loadSettings() の結果
 * @param tracker SessionTracker singleton（archive.ts から渡す）
 */
export function initAggregator(
  initialSettings: Settings,
  tracker: SessionTracker,
): void {
  sessionTracker = tracker;
  enabledCached = initialSettings.userFlagging?.enabled === true;

  if (storageListenerInstalled) return;
  storageListenerInstalled = true;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue as Settings | undefined;
    enabledCached = next?.userFlagging?.enabled === true;
  });
}

/**
 * 1 判定結果を集計する。
 *
 * - `enabled = false` → 早期 return（SessionTracker / pendingMap も汚さない）
 * - `streamerChannelId = null` → スキップ（warn 1 度だけ）
 * - `primaryToCountKey(primary)` で snake_case → camelCase 変換
 *   - `'safe'` → null → `flagged = {}`（messageCount だけ +1）
 *   - 他 → `{ [key]: 1 }`
 */
export function recordAggregate(input: RecordAggregateInput): void {
  if (!enabledCached || sessionTracker === null) return;

  const streamerChannelId = getCurrentStreamerChannelId();
  if (!streamerChannelId) {
    if (!warnedMissingStreamerOnce) {
      warnedMissingStreamerOnce = true;
      console.warn(
        '[FreshChatKeeper] userFlagging: streamerChannelId 未取得のため集計をスキップ（stream-detector 起動待ち / DOM 抽出失敗）',
      );
    }
    return;
  }
  // 一度でも取得できたら warn フラグはリセット（次に欠落したら再警告）
  warnedMissingStreamerOnce = false;

  const flagged: Partial<FlaggedCounts> = buildFlaggedDelta(input.primaryLabel);
  const timestamp = input.timestamp ?? Date.now();

  recordJudgment(streamerChannelId, input.user, flagged, timestamp);
  sessionTracker.recordMessage(input.user.channelId, flagged, timestamp);
}

/**
 * primary label を Partial<FlaggedCounts> に変換する。`safe` は空オブジェクト
 * （messageCount だけ進める、設計判断 B3 持ち越し G-3）。
 */
function buildFlaggedDelta(primary: JudgmentLabel): Partial<FlaggedCounts> {
  const key = primaryToCountKey(primary);
  if (key === null) return {};
  // 立てるキーのみ含む Partial。recordJudgment 側で 0 / 未指定は同等に扱われるため
  // 明示的に立てるキーのみ含めれば十分。
  return { [key]: 1 };
}

// ─── テスト用 ────────────────────────────────────────────────────

/** @internal テスト用: モジュール状態をリセット */
export const __test__ = {
  reset(): void {
    enabledCached = false;
    sessionTracker = null;
    storageListenerInstalled = false;
    warnedMissingStreamerOnce = false;
  },
  isEnabled(): boolean {
    return enabledCached;
  },
  setEnabledForTest(v: boolean): void {
    enabledCached = v;
  },
};
