/**
 * Phase 3.5（v0.5.0）視聴者統計ストア。
 *
 * chrome.storage.local に **配信者スコープ独立**（`fck_user_stats:{streamerChannelId}`）
 * で `StreamerScopedUserStats` を保存する。同一視聴者であっても配信者を跨いだ
 * 横断同一視はしない（設計文書 改訂2 / プライバシー方針）。
 *
 * 設計 ground truth: `dev-docs/phase-3-5-user-flagging.md` §「ストレージ設計」L208-285。
 *
 * 本モジュールは DOM 非依存だが chrome.storage は使う（B3 で `chrome.*` のみ許容、
 * `document.` / `window.` は使わない）。集計フックの emit 経路 attach は B4 担当、
 * UI 連携は B7/B8 担当。本層は CRUD + 正規化 + 5 秒 windowed flush のみ提供する。
 */

import {
  emptyFlaggedCounts,
  formatDateKey,
  type CachedStats,
  type DailyStats,
  type FlaggedCounts,
  type UserStatsEntry,
} from '@fresh-chat-keeper/judgment-engine';

/** chrome.storage キーの prefix（CLAUDE.md 命名規則 `fck_<category>:{identifier}`）。 */
export const USER_STATS_PREFIX = 'fck_user_stats:' as const;

/** 配信者スコープのストレージキーを組み立てる。 */
export function storeKeyFor(streamerChannelId: string): string {
  return `${USER_STATS_PREFIX}${streamerChannelId}`;
}

/**
 * 1 配信者スコープの保存構造。chrome.storage に JSON 化されて格納される。
 * `users` の key は視聴者 channelId（実態は `@ハンドル名`、改訂2）。
 */
export interface StreamerScopedUserStats {
  streamerChannelId: string;
  streamerDisplayName: string;
  lastUpdated: number;
  users: Record<string, UserStatsEntry>;
}

/** 空（観測ゼロ）の StreamerScopedUserStats を返す。 */
export function emptyStreamerStats(
  streamerChannelId: string,
  streamerDisplayName = '',
): StreamerScopedUserStats {
  return {
    streamerChannelId,
    streamerDisplayName,
    lastUpdated: 0,
    users: {},
  };
}

// ─── 正規化 ─────────────────────────────────────────────────────────

function normalizeFlaggedCounts(raw: unknown): FlaggedCounts {
  const out = emptyFlaggedCounts();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(out) as Array<keyof FlaggedCounts>) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[k] = Math.floor(v);
    }
  }
  return out;
}

function normalizeDailyStats(raw: unknown): DailyStats | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.date !== 'string' || r.date.length === 0) return null;
  const messageCount =
    typeof r.messageCount === 'number' &&
    Number.isFinite(r.messageCount) &&
    r.messageCount >= 0
      ? Math.floor(r.messageCount)
      : 0;
  return {
    date: r.date,
    messageCount,
    flaggedCounts: normalizeFlaggedCounts(r.flaggedCounts),
  };
}

function normalizeCachedStats(raw: unknown): CachedStats | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  // 必須フィールドが壊れていたら丸ごと無効化（B4 で再計算される）
  if (
    typeof r.calculatedAt !== 'number' ||
    !Number.isFinite(r.calculatedAt) ||
    typeof r.totalMessages !== 'number' ||
    typeof r.totalFlagged !== 'number' ||
    typeof r.severityScore !== 'number' ||
    typeof r.period !== 'string' ||
    typeof r.flagLevel !== 'string'
  ) {
    return null;
  }
  const period = r.period;
  if (period !== 'session' && period !== '7d' && period !== '30d') return null;
  const level = r.flagLevel;
  if (level !== 'clean' && level !== 'grey' && level !== 'yellow' && level !== 'red') {
    return null;
  }
  return {
    calculatedAt: r.calculatedAt,
    period,
    totalMessages: Math.max(0, Math.floor(r.totalMessages)),
    flaggedCounts: normalizeFlaggedCounts(r.flaggedCounts),
    totalFlagged: Math.max(0, Math.floor(r.totalFlagged)),
    flagLevel: level,
    severityScore: r.severityScore,
  };
}

function normalizeUserEntry(raw: unknown, fallbackId: string): UserStatsEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const channelId =
    typeof r.channelId === 'string' && r.channelId.length > 0 ? r.channelId : fallbackId;
  const displayNameLatest =
    typeof r.displayNameLatest === 'string' ? r.displayNameLatest : '';
  const displayNameFirstSeen =
    typeof r.displayNameFirstSeen === 'string' ? r.displayNameFirstSeen : displayNameLatest;
  const firstSeenAt =
    typeof r.firstSeenAt === 'number' && Number.isFinite(r.firstSeenAt) ? r.firstSeenAt : 0;
  const lastSeenAt =
    typeof r.lastSeenAt === 'number' && Number.isFinite(r.lastSeenAt) ? r.lastSeenAt : 0;
  const dailyStats: Record<string, DailyStats> = {};
  if (
    typeof r.dailyStats === 'object' &&
    r.dailyStats !== null &&
    !Array.isArray(r.dailyStats)
  ) {
    for (const [date, val] of Object.entries(r.dailyStats as Record<string, unknown>)) {
      const ds = normalizeDailyStats(val);
      if (ds !== null) dailyStats[date] = ds;
    }
  }
  return {
    channelId,
    displayNameLatest,
    displayNameFirstSeen,
    firstSeenAt,
    lastSeenAt,
    dailyStats,
    cached: normalizeCachedStats(r.cached),
  };
}

/**
 * 不正な保存値に強い正規化（user-blocks.ts の fail-safe パターン踏襲）。
 * 別拡張・手動編集・旧バグでの型崩れに耐え、トップレベル不一致なら空構造を返す。
 */
export function normalizeStreamerStats(
  raw: unknown,
  streamerChannelId: string,
): StreamerScopedUserStats {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return emptyStreamerStats(streamerChannelId);
  }
  const r = raw as Record<string, unknown>;
  const streamerDisplayName =
    typeof r.streamerDisplayName === 'string' ? r.streamerDisplayName : '';
  const lastUpdated =
    typeof r.lastUpdated === 'number' && Number.isFinite(r.lastUpdated) ? r.lastUpdated : 0;
  const users: Record<string, UserStatsEntry> = {};
  if (typeof r.users === 'object' && r.users !== null && !Array.isArray(r.users)) {
    for (const [id, entry] of Object.entries(r.users as Record<string, unknown>)) {
      const u = normalizeUserEntry(entry, id);
      if (u !== null) users[id] = u;
    }
  }
  return {
    streamerChannelId, // 引数を権威ソースに（保存値より優先）
    streamerDisplayName,
    lastUpdated,
    users,
  };
}

// ─── CRUD ───────────────────────────────────────────────────────────

/** 1 配信者分の統計を読み出す。未保存 / 不正値は空構造を返す。 */
export async function loadStreamerStats(
  streamerChannelId: string,
): Promise<StreamerScopedUserStats> {
  const key = storeKeyFor(streamerChannelId);
  const result = await chrome.storage.local.get(key);
  return normalizeStreamerStats(result[key], streamerChannelId);
}

/** 1 配信者分の統計を保存する。 */
export async function saveStreamerStats(stats: StreamerScopedUserStats): Promise<void> {
  const key = storeKeyFor(stats.streamerChannelId);
  await chrome.storage.local.set({ [key]: stats });
}

/** 1 配信者分の統計を削除する。 */
export async function clearStreamerStats(streamerChannelId: string): Promise<void> {
  await chrome.storage.local.remove(storeKeyFor(streamerChannelId));
}

/**
 * 1 視聴者の統計だけを削除する（配信者スコープ内の users から該当エントリを除去）。
 * StatsPanel の「🗑️ この人の統計をリセット」ボタン（B6）から呼ばれる。
 *
 * 該当 user が居なくても例外を投げない（no-op）。配信者スコープ自体は残し、
 * 他の視聴者の統計は影響を受けない。
 */
export async function clearUserStatsFor(
  streamerChannelId: string,
  userChannelId: string,
): Promise<void> {
  const stats = await loadStreamerStats(streamerChannelId);
  if (!stats.users[userChannelId]) return;
  delete stats.users[userChannelId];
  stats.lastUpdated = Date.now();
  await saveStreamerStats(stats);
}

/**
 * すべての `fck_user_stats:*` キーを一括削除する。`fck_settings` 等の他キーは残す。
 * popup の「全消去」ボタン（B8）から呼ばれる。
 */
export async function clearAllUserStats(): Promise<{ removedCount: number }> {
  const all = await chrome.storage.local.get(null);
  const toRemove = Object.keys(all).filter((k) => k.startsWith(USER_STATS_PREFIX));
  if (toRemove.length === 0) return { removedCount: 0 };
  await chrome.storage.local.remove(toRemove);
  return { removedCount: toRemove.length };
}

// ─── cached API（B4/B8 が呼ぶ、本バッチでは骨組みのみ） ───────────────

/** 1 視聴者の cached フィールドだけを更新する。 */
export async function setCached(
  streamerChannelId: string,
  userChannelId: string,
  cached: CachedStats | null,
): Promise<void> {
  const stats = await loadStreamerStats(streamerChannelId);
  const entry = stats.users[userChannelId];
  if (!entry) return; // 該当ユーザーが居なければ no-op（race 時の保護）
  entry.cached = cached;
  stats.lastUpdated = Date.now();
  await saveStreamerStats(stats);
}

/** 1 視聴者の cached を無効化（null セット）。新フラグ発生時等で B4 が呼ぶ。 */
export async function invalidateCachedFor(
  streamerChannelId: string,
  userChannelId: string,
): Promise<void> {
  await setCached(streamerChannelId, userChannelId, null);
}

/**
 * 全配信者・全ユーザーの cached を一括無効化する。
 * 感度設定 / scope 設定の変更時（B8）にまとめて呼ぶ。
 */
export async function clearAllCached(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(USER_STATS_PREFIX)) continue;
    const stats = normalizeStreamerStats(v, k.slice(USER_STATS_PREFIX.length));
    let mutated = false;
    for (const entry of Object.values(stats.users)) {
      if (entry.cached !== null) {
        entry.cached = null;
        mutated = true;
      }
    }
    if (mutated) {
      stats.lastUpdated = Date.now();
      updates[k] = stats;
    }
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

// ─── 5 秒 windowed batching による recordJudgment ─────────────────

/**
 * windowed flush の窓幅（ms）。5 秒に固定（テスト性のため exports しないが
 * 値は B3 設計判断として明示）。
 */
const FLUSH_WINDOW_MS = 5000;

/** 1 視聴者あたりの pending デルタ。flush 時に dailyStats に加算合成する。 */
interface PendingUserDelta {
  displayName: string;
  messageCountDelta: number;
  flaggedDelta: FlaggedCounts;
  /** 最初に観測した時刻（複数 record の最古、firstSeenAt 設定に使う） */
  firstObservedAt: number;
  /** 最後に観測した時刻（lastSeenAt 更新に使う） */
  lastObservedAt: number;
  /** day key ごとの内訳（同 5s 窓内で日付跨ぎが起きても正しく振り分けるため） */
  byDate: Map<string, { messages: number; flagged: FlaggedCounts }>;
}

/** 1 配信者あたりの pending 状態。タイマー + 視聴者 Map を保持。 */
interface PendingStreamer {
  streamerChannelId: string;
  streamerDisplayName: string;
  users: Map<string, PendingUserDelta>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** streamerChannelId → 蓄積状態 */
const pendingByStreamer = new Map<string, PendingStreamer>();

/**
 * 1 判定結果を pending に積む。**chrome.storage には即時書かない**：
 * - 第 1 record で +5 秒後の flush タイマー設定
 * - 5s 内の record はメモリ Map に蓄積（同 user は加算合成）
 * - 別 streamerChannelId は独立タイマー
 *
 * `flagged` は LABEL_PRECEDENCE で導出した primary を {@link primaryToCountKey}
 * 経由でキー変換した「カテゴリ別 1 件のみ立つ」想定（safe 判定の場合は `{}`）。
 * messageCount は record ごとに +1 される（safe / flag 問わず）。
 *
 * @param timestamp 観測時刻（ミリ秒 epoch）。省略時は `Date.now()`。
 */
export function recordJudgment(
  streamerChannelId: string,
  streamerDisplayName: string,
  user: { channelId: string; displayName: string },
  flagged: Partial<FlaggedCounts>,
  timestamp: number = Date.now(),
): void {
  const dateKey = formatDateKey(new Date(timestamp));

  let p = pendingByStreamer.get(streamerChannelId);
  if (!p) {
    p = {
      streamerChannelId,
      streamerDisplayName,
      users: new Map(),
      timer: null,
    };
    pendingByStreamer.set(streamerChannelId, p);
  } else if (!p.streamerDisplayName && streamerDisplayName) {
    // B5-hotfix: 既存 pending の displayName が空（初回 record 時に DOM がまだ
    // 準備できていなかった場合）で、後続 record で取得できたら上書きする。
    // 取得済みを意図せず空文字で潰さないため「空 → 非空」のみ許可。
    p.streamerDisplayName = streamerDisplayName;
  }

  let u = p.users.get(user.channelId);
  if (!u) {
    u = {
      displayName: user.displayName,
      messageCountDelta: 0,
      flaggedDelta: emptyFlaggedCounts(),
      firstObservedAt: timestamp,
      lastObservedAt: timestamp,
      byDate: new Map(),
    };
    p.users.set(user.channelId, u);
  } else {
    // 最新の displayName を保持（B5 で名前変更が発生したら最新側を保存）
    u.displayName = user.displayName;
    if (timestamp < u.firstObservedAt) u.firstObservedAt = timestamp;
    if (timestamp > u.lastObservedAt) u.lastObservedAt = timestamp;
  }
  u.messageCountDelta += 1;
  for (const k of Object.keys(u.flaggedDelta) as Array<keyof FlaggedCounts>) {
    const v = flagged[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) u.flaggedDelta[k] += v;
  }
  const byDate = u.byDate.get(dateKey) ?? {
    messages: 0,
    flagged: emptyFlaggedCounts(),
  };
  byDate.messages += 1;
  for (const k of Object.keys(byDate.flagged) as Array<keyof FlaggedCounts>) {
    const v = flagged[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) byDate.flagged[k] += v;
  }
  u.byDate.set(dateKey, byDate);

  if (p.timer === null) {
    p.timer = setTimeout(() => {
      void flushStreamer(streamerChannelId);
    }, FLUSH_WINDOW_MS);
  }
}

/** 1 配信者分の pending を chrome.storage に flush する（タイマー満了時の本体）。 */
async function flushStreamer(streamerChannelId: string): Promise<void> {
  const p = pendingByStreamer.get(streamerChannelId);
  if (!p) return;
  // タイマー参照は早めにクリア（flush 中の race を回避）
  if (p.timer !== null) {
    clearTimeout(p.timer);
    p.timer = null;
  }
  const pendingUsers = p.users;
  if (pendingUsers.size === 0) {
    pendingByStreamer.delete(streamerChannelId);
    return;
  }
  // pending を取り出してから storage に書く（書き込み中の新 record は次回 flush へ）
  p.users = new Map();

  const stats = await loadStreamerStats(streamerChannelId);
  const now = Date.now();
  stats.lastUpdated = now;

  // B5-hotfix: 既存ストアの streamerDisplayName が空（旧データ / DOM 抽出失敗で
  // 過去 flush 時に空のまま保存されたケース）で、今回 pending が値を持っていれば
  // refresh する。「空 → 非空」のみ許可（取得済みの値を空文字で潰さない）。
  if (!stats.streamerDisplayName && p.streamerDisplayName) {
    stats.streamerDisplayName = p.streamerDisplayName;
  }

  for (const [userId, delta] of pendingUsers) {
    let entry = stats.users[userId];
    if (!entry) {
      entry = {
        channelId: userId,
        displayNameLatest: delta.displayName,
        displayNameFirstSeen: delta.displayName,
        firstSeenAt: delta.firstObservedAt,
        lastSeenAt: delta.lastObservedAt,
        dailyStats: {},
        cached: null,
      };
      stats.users[userId] = entry;
    } else {
      entry.displayNameLatest = delta.displayName;
      if (entry.firstSeenAt === 0 || delta.firstObservedAt < entry.firstSeenAt) {
        entry.firstSeenAt = delta.firstObservedAt;
      }
      if (delta.lastObservedAt > entry.lastSeenAt) {
        entry.lastSeenAt = delta.lastObservedAt;
      }
      // 新フラグが入ったので cached を無効化（B4 が後で再計算）
      entry.cached = null;
    }
    for (const [date, dayDelta] of delta.byDate) {
      const existing = entry.dailyStats[date];
      if (existing) {
        existing.messageCount += dayDelta.messages;
        for (const k of Object.keys(existing.flaggedCounts) as Array<keyof FlaggedCounts>) {
          existing.flaggedCounts[k] += dayDelta.flagged[k];
        }
      } else {
        entry.dailyStats[date] = {
          date,
          messageCount: dayDelta.messages,
          flaggedCounts: { ...dayDelta.flagged },
        };
      }
    }
  }

  await saveStreamerStats(stats);

  // 書き込み中に新 record が再度入っていた場合は users が空でない。
  // 次の record が timer を立てるのでここでは何もしない（pending は再生成済）。
  if (p.users.size === 0 && p.timer === null) {
    pendingByStreamer.delete(streamerChannelId);
  }
}

/**
 * すべての pending を即時 flush する（テスト・拡張シャットダウン時用）。
 * 内部状態を完全に空にする（Map / タイマー含む）。
 */
export async function flushAll(): Promise<void> {
  // pending streamer のスナップショットを取ってから走査（flush 中の再 record を許容）
  const ids = [...pendingByStreamer.keys()];
  for (const id of ids) {
    const p = pendingByStreamer.get(id);
    if (p?.timer !== null && p?.timer !== undefined) {
      clearTimeout(p.timer);
      p.timer = null;
    }
    await flushStreamer(id);
  }
}

/**
 * テスト用: pending 状態を初期化する（タイマー停止 + Map クリア）。
 * 本番コードからは呼ばない。
 */
export const __test__ = {
  resetPending(): void {
    for (const p of pendingByStreamer.values()) {
      if (p.timer !== null) clearTimeout(p.timer);
    }
    pendingByStreamer.clear();
  },
  getPendingSnapshot(): Map<string, PendingStreamer> {
    return pendingByStreamer;
  },
  FLUSH_WINDOW_MS,
};
