/**
 * Phase 3.5 B8: 視聴者統計データのバックグラウンドクリーンアップ。
 *
 * `fck_user_stats:*`（B3 user-stats-store）は無限に溜まるため、background の
 * chrome.alarms で 1 日 1 回:
 * 1. 保持期間（scope に応じ 7d / 30d）超過の dailyStats を削除
 * 2. dailyStats が空になった user entry を削除
 * 3. 配信者ごとのユーザー数上限（{@link MAX_USERS_PER_STREAMER}）強制
 * 4. 配信者スコープ数上限（{@link MAX_STREAMERS_TRACKED}）強制
 *
 * 設計方針（プロジェクト慣習）: 純粋関数（chrome 非依存・テスト容易、now/cutoff を
 * 引数で受ける）と chrome.storage を触る薄い glue を分離する。プルーニングは重い
 * 全走査なので **background 専任**（popup には持たせない、B7 G-3）。
 *
 * 設計 ground truth: `dev-docs/phase-3-5-user-flagging.md` §「ストレージ管理」L1335-1436。
 */

import { addDays, formatDateKey } from '@fresh-chat-keeper/judgment-engine';
import {
  USER_STATS_PREFIX,
  normalizeStreamerStats,
  type StreamerScopedUserStats,
} from '../shared/user-stats-store.js';
import { loadSettings } from '../shared/settings-loader.js';

/** 追跡する配信者スコープ数の上限（設計文書 L1405）。超過分は lastUpdated 古い順に削除。 */
export const MAX_STREAMERS_TRACKED = 50;
/** 1 配信者あたりの追跡ユーザー数の上限（設計文書 L1406）。超過分は lastSeenAt 古い順に削除。 */
export const MAX_USERS_PER_STREAMER = 1000;
/** chrome.alarms のアラーム名。 */
export const CLEANUP_ALARM_NAME = 'fck-user-stats-cleanup';

// ─── 純粋関数（chrome 非依存、テスト固定可能） ──────────────────────

/**
 * 1 配信者スコープから保持期間外の dailyStats を削除し、dailyStats が空に
 * なった user entry も削除する。
 *
 * `cutoffDateKey` 未満（UTC "YYYY-MM-DD" 文字列比較、B3 と同じ）の day key を破棄。
 * 入力 `stats` は変更せず新オブジェクトを返す（純粋）。何も変わらなければ
 * `modified: false` を返し、呼び出し側は save をスキップできる。
 *
 * 注: dailyStats を削った user は集計が変わるので cached も無効化（null）する。
 */
export function pruneStreamerStats(
  stats: StreamerScopedUserStats,
  cutoffDateKey: string,
): { cleaned: StreamerScopedUserStats; modified: boolean } {
  let modified = false;
  const nextUsers: StreamerScopedUserStats['users'] = {};

  for (const [userId, user] of Object.entries(stats.users)) {
    const keptDaily: typeof user.dailyStats = {};
    let userModified = false;
    for (const [dateKey, daily] of Object.entries(user.dailyStats)) {
      if (dateKey < cutoffDateKey) {
        userModified = true; // 古い day key を捨てる
      } else {
        keptDaily[dateKey] = daily;
      }
    }

    // dailyStats が空になった user は丸ごと削除
    if (Object.keys(keptDaily).length === 0) {
      modified = true;
      continue;
    }

    if (userModified) {
      modified = true;
      // dailyStats を削ったので集計が変わる → cached 無効化
      nextUsers[userId] = { ...user, dailyStats: keptDaily, cached: null };
    } else {
      nextUsers[userId] = user;
    }
  }

  if (!modified) {
    return { cleaned: stats, modified: false };
  }
  return { cleaned: { ...stats, users: nextUsers }, modified: true };
}

/**
 * 1 配信者スコープの user 数が `maxUsers` を超えていたら、lastSeenAt 降順で
 * 上位 `maxUsers` 件のみ残す（古いものを削除）。純粋。
 *
 * 同数 lastSeenAt は元の Object.entries 順を保つ（安定ソート、V8 の Array.sort は
 * 安定なのでタイは入力順）。
 */
export function enforceUserLimit(
  stats: StreamerScopedUserStats,
  maxUsers: number,
): { cleaned: StreamerScopedUserStats; modified: boolean } {
  const entries = Object.entries(stats.users);
  if (entries.length <= maxUsers) {
    return { cleaned: stats, modified: false };
  }
  // lastSeenAt 降順。安定ソートでタイは入力順を維持。
  const sorted = entries
    .map(([id, user], idx) => ({ id, user, idx }))
    .sort((a, b) => b.user.lastSeenAt - a.user.lastSeenAt || a.idx - b.idx);
  const nextUsers: StreamerScopedUserStats['users'] = {};
  for (const { id, user } of sorted.slice(0, maxUsers)) {
    nextUsers[id] = user;
  }
  return { cleaned: { ...stats, users: nextUsers }, modified: true };
}

/**
 * 配信者スコープ数が `maxStreamers` を超えていたら、lastUpdated 降順で上位
 * `maxStreamers` 件を残し、**削除すべき storage キー一覧**を返す。純粋。
 *
 * 上限以下なら空配列。同数 lastUpdated は入力順で安定。
 */
export function selectStreamerKeysToEvict(
  entries: Array<{ key: string; lastUpdated: number }>,
  maxStreamers: number,
): string[] {
  if (entries.length <= maxStreamers) return [];
  const sorted = entries
    .map((e, idx) => ({ ...e, idx }))
    .sort((a, b) => b.lastUpdated - a.lastUpdated || a.idx - b.idx);
  return sorted.slice(maxStreamers).map((e) => e.key);
}

// ─── chrome glue（薄い、storage を触る） ────────────────────────────

/**
 * 全 `fck_user_stats:*` にプルーニング + 上限強制を適用する。
 *
 * - `userFlagging.enabled === false` なら **no-op**（設計 L1357。機能 OFF の
 *   ユーザーのデータは触らない＝そもそも溜まっていない想定だが念のため）
 * - `retentionDays = scope === '7d' ? 7 : 30`（session / 30d は 30）
 * - `cutoffDateKey = formatDateKey(addDays(now, -(retentionDays - 1)))`
 *   （B3 と同じ「直近 N 日（now 含む）」窓。最古日 = now の N-1 日前）
 *
 * @param now テスト固定用。省略時は `new Date()`
 */
export async function runUserStatsCleanup(now: Date = new Date()): Promise<void> {
  const settings = await loadSettings();
  if (!settings.userFlagging.enabled) return;

  const retentionDays = settings.userFlagging.scope === '7d' ? 7 : 30;
  const cutoffDateKey = formatDateKey(addDays(now, -(retentionDays - 1)));

  const all = await chrome.storage.local.get(null);
  const streamerKeys = Object.keys(all).filter((k) => k.startsWith(USER_STATS_PREFIX));
  if (streamerKeys.length === 0) return;

  // 正規化したスコープを 1 度だけ作って使い回す（normalizeStreamerStats は
  // 不正値に強く、保存値の型崩れにも耐える）
  const scoped = streamerKeys.map((key) => ({
    key,
    stats: normalizeStreamerStats(all[key], key.slice(USER_STATS_PREFIX.length)),
  }));

  // 1. 配信者数上限: 古い順に evict
  const evictKeys = selectStreamerKeysToEvict(
    scoped.map((s) => ({ key: s.key, lastUpdated: s.stats.lastUpdated })),
    MAX_STREAMERS_TRACKED,
  );
  if (evictKeys.length > 0) {
    await chrome.storage.local.remove(evictKeys);
  }
  const evictSet = new Set(evictKeys);

  // 2. 残ったスコープにプルーニング + ユーザー数上限
  for (const { key, stats } of scoped) {
    if (evictSet.has(key)) continue; // 既に削除済み
    const pruned = pruneStreamerStats(stats, cutoffDateKey);
    const limited = enforceUserLimit(pruned.cleaned, MAX_USERS_PER_STREAMER);
    if (pruned.modified || limited.modified) {
      const next: StreamerScopedUserStats = {
        ...limited.cleaned,
        lastUpdated: limited.cleaned.lastUpdated,
      };
      await chrome.storage.local.set({ [key]: next });
    }
  }
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = {
  MAX_STREAMERS_TRACKED,
  MAX_USERS_PER_STREAMER,
  CLEANUP_ALARM_NAME,
};
