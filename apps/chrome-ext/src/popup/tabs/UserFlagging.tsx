/**
 * 「フラグ視聴者」タブ（Phase 3.5 / B7）。
 *
 * 配信サマリ（現在の配信の red/yellow 視聴者）+ 設定（ON/OFF・追跡期間・表示
 * スタイル・感度）+ ストレージ使用量 + 全削除 + 一括ブロックを提供する。
 *
 * データ源は `fck_user_stats:*`（B3 user-stats-store）。popup は content の
 * `getCurrentStreamerChannelId()` を呼べないため、起動時に全 streamer を読み込み
 * `lastUpdated` 最新の配信者を「現在の配信」とみなす（B6 G-5 の MVP 方針。将来は
 * content からの broadcast に切り替える余地あり）。
 *
 * フラグ評価は `evaluateFlagLevelsForUsers`（純粋計算、cached I/O なし、B7
 * supplement）。popup は表示専用で cached を所有しない。scope='session' は popup に
 * sessionStats が無いので '30d' にフォールバックして集計する。
 *
 * 設定変更は App.tsx と同じ `onUpdate`（saveSettings 経由）。content 側は既存
 * onChanged listener（ui-overlay / archive）で勝手に追随する。
 */

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  evaluateFlagLevelsForUsers,
  type FlagEvaluationResult,
  type UserStatsEntry,
} from '@fresh-chat-keeper/judgment-engine';
import {
  USER_STATS_PREFIX,
  normalizeStreamerStats,
  clearAllUserStats,
  type StreamerScopedUserStats,
} from '../../shared/user-stats-store.js';
import {
  USER_BLOCKS_KEY,
  normalizeUserBlockStore,
} from '../../shared/user-blocks.js';
import {
  type Settings,
  type UserFlaggingSettings,
  type UserFlaggingScope,
  type UserFlaggingDisplayStyle,
} from '../../shared/settings.js';

interface UserFlaggingProps {
  settings: Settings;
  onUpdate: (partial: Partial<Settings>) => void;
}

// ─── 純粋ヘルパー（テスト対象） ─────────────────────────────────────

/**
 * 感度スライダー値（= red 閾値）から `{ red, yellow }` を導出する。
 * yellow は red の半分（設計文書 L442-443）。1 本のスライダーで invariant
 * （yellow <= red）を保証する（B6 G-3）。
 */
export function sensitivityFromRed(red: number): { yellow: number; red: number } {
  return { red, yellow: red / 2 };
}

/** 感度プリセット（緩め←→厳格、red 閾値）。設計文書 L437-440。 */
export const SENSITIVITY_PRESETS: { value: string; label: string; red: number }[] = [
  { value: '0.8', label: '緩め', red: 0.8 },
  { value: '0.6', label: 'やや緩め', red: 0.6 },
  { value: '0.4', label: '標準', red: 0.4 },
  { value: '0.3', label: 'やや厳格', red: 0.3 },
  { value: '0.2', label: '厳格', red: 0.2 },
];

/** 現在の red 閾値に最も近いプリセット value を返す（スライダー選択状態の復元用）。 */
export function presetValueForRed(red: number): string {
  let best = SENSITIVITY_PRESETS[0];
  let bestDiff = Math.abs(best.red - red);
  for (const p of SENSITIVITY_PRESETS) {
    const diff = Math.abs(p.red - red);
    if (diff < bestDiff) {
      best = p;
      bestDiff = diff;
    }
  }
  return best.value;
}

/**
 * popup の集計に使う実 period。scope='session' は popup には sessionStats が
 * 無いので '30d' にフォールバック（content 専用スコープ）。
 */
export function effectivePeriodForPopup(scope: UserFlaggingScope): '7d' | '30d' {
  return scope === 'session' ? '30d' : scope;
}

/** バイト数を人間可読文字列に整形（KB / MB）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** chrome.storage.local の全データから fck_user_stats:* を抽出して正規化する。 */
export function extractStreamerStatsFromAll(
  all: Record<string, unknown>,
): StreamerScopedUserStats[] {
  const out: StreamerScopedUserStats[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(USER_STATS_PREFIX)) continue;
    out.push(normalizeStreamerStats(value, key.slice(USER_STATS_PREFIX.length)));
  }
  return out;
}

/** lastUpdated 最新の配信者を「現在の配信」として返す（無ければ null）。 */
export function pickCurrentStreamer(
  streamers: StreamerScopedUserStats[],
): StreamerScopedUserStats | null {
  if (streamers.length === 0) return null;
  return streamers.reduce((latest, s) =>
    s.lastUpdated > latest.lastUpdated ? s : latest,
  );
}

interface LeveledUser {
  entry: UserStatsEntry;
  result: FlagEvaluationResult;
}

/** 評価結果を red / yellow にグルーピングする（clean/grey は表示しない）。 */
export function groupByLevel(leveled: LeveledUser[]): {
  red: LeveledUser[];
  yellow: LeveledUser[];
} {
  const red: LeveledUser[] = [];
  const yellow: LeveledUser[] = [];
  for (const lu of leveled) {
    if (lu.result.level === 'red') red.push(lu);
    else if (lu.result.level === 'yellow') yellow.push(lu);
  }
  return { red, yellow };
}

/** chrome.storage の fck_user_stats:* キーのバイト数を概算する（JSON 長）。 */
export function estimateUserStatsBytes(all: Record<string, unknown>): number {
  let total = 0;
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(USER_STATS_PREFIX)) continue;
    try {
      total += key.length + JSON.stringify(value).length;
    } catch {
      // 循環参照等は無視
    }
  }
  return total;
}

// ─── 小コンポーネント（CategoryFilters 同様にローカル定義） ──────────

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-checked={checked}
      role="switch"
      aria-label={label}
      className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-indigo-500 focus:outline-none ${
        checked ? 'bg-indigo-600' : 'bg-gray-300'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function SegmentedControl({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
}) {
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = options.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = idx >= last ? 0 : idx + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = idx <= 0 ? last : idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    onChange(options[next].value);
    const btns = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    btns[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="flex rounded-md border border-gray-200 overflow-hidden text-xs"
    >
      {options.map((opt, i) => {
        const checked = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(opt.value)}
            className={`flex-1 py-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 focus:outline-none ${
              i > 0 ? 'border-l border-gray-200' : ''
            } ${
              checked
                ? 'bg-indigo-600 text-white font-medium'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-gray-100">
      <div className="text-xs font-medium text-gray-500 mb-1.5">{label}</div>
      {children}
    </div>
  );
}

const SCOPE_OPTIONS: { value: UserFlaggingScope; label: string }[] = [
  { value: 'session', label: 'セッション' },
  { value: '7d', label: '7日' },
  { value: '30d', label: '30日' },
];

const DISPLAY_STYLE_OPTIONS: { value: UserFlaggingDisplayStyle; label: string }[] = [
  { value: 'icon', label: 'アイコン' },
  { value: 'color', label: '色' },
  { value: 'hover_only', label: 'ホバー' },
  { value: 'red_only', label: '赤のみ' },
];

// ─── メイン ─────────────────────────────────────────────────────────

export function UserFlagging({ settings, onUpdate }: UserFlaggingProps) {
  const flagging = settings.userFlagging;
  const [streamers, setStreamers] = useState<StreamerScopedUserStats[] | null>(null);
  const [storageBytes, setStorageBytes] = useState<number>(0);
  const [confirmBulk, setConfirmBulk] = useState(false);

  // 全 fck_user_stats:* を読み込み（onChanged で content 側の集計増分にも追随）
  useEffect(() => {
    let active = true;
    const load = () => {
      chrome.storage.local.get(null, (all) => {
        if (!active) return;
        setStreamers(extractStreamerStatsFromAll(all));
        setStorageBytes(estimateUserStatsBytes(all));
      });
    };
    load();
    const listener = (
      _changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local') return;
      load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const updateFlagging = (partial: Partial<UserFlaggingSettings>) => {
    onUpdate({ userFlagging: { ...flagging, ...partial } });
  };

  const current = useMemo(
    () => (streamers ? pickCurrentStreamer(streamers) : null),
    [streamers],
  );

  const grouped = useMemo(() => {
    if (!current) return { red: [], yellow: [] };
    const users = Object.values(current.users);
    const period = effectivePeriodForPopup(flagging.scope);
    const leveled = evaluateFlagLevelsForUsers(users, period, flagging.sensitivity);
    return groupByLevel(leveled);
  }, [current, flagging.scope, flagging.sensitivity]);

  // ─── 機能 OFF: オプトイン案内 + 有効化トグルのみ ───
  if (!flagging.enabled) {
    return (
      <div>
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 text-[11px] text-amber-700 leading-snug">
          💡 視聴者フラグ機能は初期状態では OFF です。
        </div>
        <Row label="視聴者フラグ機能">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-gray-500 leading-snug">
              繰り返しフィルタに引っかかる視聴者を 🟡🔴 で可視化します。
              <br />
              有効にすると、視聴中の配信のコメント傾向をローカルに集計します。
            </div>
            <Toggle
              checked={false}
              onChange={(v) => updateFlagging({ enabled: v })}
              label="視聴者フラグ機能を有効化"
            />
          </div>
        </Row>
      </div>
    );
  }

  // 一括ブロックは popup から `fck_user_blocks` を直接マージ書き込みする
  // （UserBlocklist タブの直接書き込みと同パターン）。content の blockUser は
  // module-scope storeCache（初期空）に依存し、popup から呼ぶと既存ブロックを
  // **上書き消失**させるため使わない。content 側は onChanged listener で新規
  // channelId を検知して遡及非表示する（B7 設計差分、完了報告参照）。
  const handleBulkBlock = async () => {
    const targets = grouped.red.map((lu) => lu.entry);
    if (targets.length === 0) {
      setConfirmBulk(false);
      return;
    }
    const result = await chrome.storage.local.get(USER_BLOCKS_KEY);
    const store = normalizeUserBlockStore(result[USER_BLOCKS_KEY]);
    const now = Date.now();
    for (const entry of targets) {
      if (!entry.channelId || store.channelIds.includes(entry.channelId)) continue;
      store.channelIds.push(entry.channelId);
      store.metadata[entry.channelId] = {
        displayNameAtBlock: entry.displayNameLatest || entry.channelId,
        blockedAt: now,
      };
    }
    await chrome.storage.local.set({ [USER_BLOCKS_KEY]: store });
    setConfirmBulk(false);
  };

  const handleClearAll = async () => {
    if (!window.confirm('視聴者統計データをすべて削除します。元に戻せません。よろしいですか？')) {
      return;
    }
    await clearAllUserStats();
    setStreamers([]);
    setStorageBytes(0);
  };

  return (
    <div>
      {/* 配信サマリ */}
      <Row label={current ? `フラグ視聴者（${current.streamerDisplayName || '現在の配信'}）` : 'フラグ視聴者'}>
        {streamers === null ? (
          <div className="text-xs text-gray-400">読み込み中…</div>
        ) : !current || (grouped.red.length === 0 && grouped.yellow.length === 0) ? (
          <div className="text-xs text-gray-400 leading-snug">
            フラグ該当の視聴者はまだいません。
            <br />
            配信を視聴するとここに 🔴🟡 の視聴者が表示されます。
          </div>
        ) : (
          <div className="space-y-3">
            {grouped.red.length > 0 && (
              <FlagUserList title={`🔴 レッド (${grouped.red.length}人)`} users={grouped.red} />
            )}
            {grouped.yellow.length > 0 && (
              <FlagUserList title={`🟡 イエロー (${grouped.yellow.length}人)`} users={grouped.yellow} />
            )}
          </div>
        )}
      </Row>

      {/* 一括ブロック */}
      {grouped.red.length > 0 && (
        <Row label="一括アクション">
          {!confirmBulk ? (
            <button
              type="button"
              onClick={() => setConfirmBulk(true)}
              className="w-full text-xs py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500 focus:outline-none"
            >
              🚫 レッドの視聴者を一括ブロック（{grouped.red.length}人）
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-gray-600 leading-snug">
                以下の {grouped.red.length} 人をブロックします。
              </p>
              <ul className="max-h-32 overflow-y-auto text-xs text-gray-700 border border-gray-100 rounded divide-y divide-gray-50">
                {grouped.red.map((lu) => (
                  <li key={lu.entry.channelId} className="px-2 py-1 flex justify-between gap-2">
                    <span className="truncate">{lu.entry.displayNameLatest || lu.entry.channelId}</span>
                    <span className="text-gray-400 shrink-0">
                      {lu.result.totalFlagged}/{lu.result.totalMessages}件
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmBulk(false)}
                  className="flex-1 text-xs py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-indigo-500 focus:outline-none"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={() => void handleBulkBlock()}
                  className="flex-1 text-xs py-1.5 rounded bg-red-600 text-white font-medium hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500 focus:outline-none"
                >
                  {grouped.red.length}人をブロック
                </button>
              </div>
            </div>
          )}
        </Row>
      )}

      {/* 設定 */}
      <Row label="視聴者フラグ機能">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-gray-600">この機能を有効にする</div>
          <Toggle
            checked={flagging.enabled}
            onChange={(v) => updateFlagging({ enabled: v })}
            label="視聴者フラグ機能"
          />
        </div>
      </Row>

      <Row label="追跡期間">
        <SegmentedControl
          options={SCOPE_OPTIONS}
          value={flagging.scope}
          onChange={(v) => updateFlagging({ scope: v as UserFlaggingScope })}
          ariaLabel="追跡期間"
        />
      </Row>

      <Row label="表示スタイル">
        <SegmentedControl
          options={DISPLAY_STYLE_OPTIONS}
          value={flagging.displayStyle}
          onChange={(v) => updateFlagging({ displayStyle: v as UserFlaggingDisplayStyle })}
          ariaLabel="表示スタイル"
        />
      </Row>

      <Row label="感度（厳しいほど多くフラグ）">
        <SegmentedControl
          options={SENSITIVITY_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          value={presetValueForRed(flagging.sensitivity.red)}
          onChange={(v) => updateFlagging({ sensitivity: sensitivityFromRed(Number(v)) })}
          ariaLabel="感度"
        />
      </Row>

      {/* ストレージ */}
      <Row label="ストレージ使用量">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-gray-500">
            視聴者統計: {formatBytes(storageBytes)}
          </div>
          <button
            type="button"
            onClick={() => void handleClearAll()}
            className="shrink-0 text-xs px-2.5 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500 focus:outline-none"
          >
            全データを削除
          </button>
        </div>
      </Row>
    </div>
  );
}

function FlagUserList({ title, users }: { title: string; users: LeveledUser[] }) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 5;
  const shown = expanded ? users : users.slice(0, LIMIT);
  return (
    <div>
      <div className="text-xs font-medium text-gray-700 mb-1">{title}</div>
      <ul className="text-xs text-gray-700 space-y-0.5">
        {shown.map((lu) => (
          <li key={lu.entry.channelId} className="flex justify-between gap-2">
            <span className="truncate">{lu.entry.displayNameLatest || lu.entry.channelId}</span>
            <span className="text-gray-400 shrink-0">
              {lu.result.totalMessages}件中{lu.result.totalFlagged}件
            </span>
          </li>
        ))}
      </ul>
      {users.length > LIMIT && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 text-[11px] text-indigo-500 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-500 focus:outline-none"
        >
          もっと見る（残り{users.length - LIMIT}人）
        </button>
      )}
    </div>
  );
}

export const __test__ = {
  SCOPE_OPTIONS,
  DISPLAY_STYLE_OPTIONS,
  SENSITIVITY_PRESETS,
};
