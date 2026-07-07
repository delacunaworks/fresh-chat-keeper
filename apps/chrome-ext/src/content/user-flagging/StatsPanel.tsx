/**
 * Phase 3.5 B6: 視聴者統計詳細パネル（クリックモーダル）。
 *
 * 設計文書 §「統計詳細パネル」L710-983。改訂1 で Hover-Safe Pattern は撤回され
 * **クリック駆動の React モーダル一本**。menu-manager の `onStats` 経由で
 * archive.ts から `openStatsPanel(...)` で開かれる。
 *
 * 内部ロジック:
 * 1. mount 時に `loadStreamerStats(streamerChannelId)` で entry 取得
 * 2. user 未存在 → 「統計データなし」メッセージ
 * 3. `resolveFlagLevel(...)` で level / totalMessages / totalFlagged / severityScore
 * 4. `extractPeriodStats(...)` で flaggedCounts breakdown を計算
 *    （B4 D-5 の決定により resolver の戻り値に breakdown は含まれない）
 *
 * a11y: `role="dialog" aria-modal="true"`、ESC / × / overlay クリックで閉じる、
 * focus trap は use-modal-a11y を popup から再利用（pure React hook、
 * popup-specific deps なし）。
 */

import { useEffect, useRef, useState } from 'react';
import { useModalA11y } from '../../popup/use-modal-a11y.js';
import { loadStreamerStats, clearUserStatsFor } from '../../shared/user-stats-store.js';
import { loadSettings } from '../../shared/settings-loader.js';
import { resolveFlagLevel } from './flag-level-resolver.js';
import { blockUser } from '../user-blocking/blocking.js';
import { showBlockUndoToast } from '../user-blocking/undo-toast.js';
import type { SessionTracker } from './session-tracker.js';
import { DailyTimeline } from './DailyTimeline.js';
import { getSessionComments, PER_USER_MAX, type SessionComment } from './session-comment-log.js';
import {
  extractPeriodStats,
  type FlaggedCounts,
  type FlagEvaluationResult,
  type JudgmentLabel,
  type UserStatsEntry,
} from '@fresh-chat-keeper/judgment-engine';

interface StatsPanelProps {
  streamerChannelId: string;
  userChannelId: string;
  /** 表示用の視聴者名（menu-manager の ActionMenuTarget.authorDisplayName） */
  userDisplayName: string;
  /** archive.ts module-scope の SessionTracker singleton（session スコープ判定 + breakdown） */
  sessionTracker: SessionTracker;
  onClose: () => void;
}

interface PanelData {
  entry: UserStatsEntry | null;
  result: FlagEvaluationResult | null;
  breakdown: FlaggedCounts | null;
  scope: 'session' | '7d' | '30d';
}

const SCOPE_LABEL: Record<PanelData['scope'], string> = {
  session: 'このセッション',
  '7d': '直近 7 日',
  '30d': '直近 30 日',
};

const CATEGORY_LABELS: Array<[keyof FlaggedCounts, string]> = [
  ['harassment', '暴言・誹謗中傷'],
  ['spoiler', 'ネタバレ'],
  ['backseat', '指示厨・攻略押付'],
  ['spam', 'スパム・連投'],
  ['offTopic', '無関係・他配信者'],
];

/**
 * F-1: 配信内コメントのマーカー（JudgmentLabel → 表示名）。
 * 'safe' は「FCK がフィルタ/フラグしていない」意なのでマーカーを付けない。
 */
const JUDGMENT_LABEL_JP: Partial<Record<JudgmentLabel, string>> = {
  harassment: '暴言',
  spoiler: 'ネタバレ',
  backseat: '指示厨',
  spam: 'スパム',
  off_topic: '無関係',
};

/**
 * 動画の再生位置（秒）を h:mm:ss / m:ss に整形（F-1 表示用）。
 * アーカイブでは「配信のどの地点のコメントか」を示す。取得不能なら '—'。
 */
function formatCommentTime(videoTime: number | undefined): string {
  if (videoTime === undefined || !Number.isFinite(videoTime) || videoTime < 0) return '—';
  const s = Math.floor(videoTime);
  const p = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

function flagLevelBadge(level: FlagEvaluationResult['level']): {
  text: string;
  cls: string;
} {
  switch (level) {
    case 'red':
      return { text: '🔴 要注意', cls: 'fck-flag-badge-red' };
    case 'yellow':
      return { text: '🟡 注意', cls: 'fck-flag-badge-yellow' };
    case 'grey':
      return { text: '⚪ 軽微', cls: 'fck-flag-badge-grey' };
    case 'clean':
      return { text: '✓ 問題なし', cls: 'fck-flag-badge-clean' };
  }
}

export function StatsPanel({
  streamerChannelId,
  userChannelId,
  userDisplayName,
  sessionTracker,
  onClose,
}: StatsPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<PanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<null | 'block' | 'reset'>(null);
  // F-1: 配信内コメント（メモリバッファの同期スナップショット。mount 時に 1 度読む）。
  const [sessionComments] = useState<SessionComment[]>(() =>
    getSessionComments(userChannelId),
  );

  useModalA11y({ open: true, containerRef, onClose });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await loadSettings();
        const scope = settings.userFlagging.scope;
        const stats = await loadStreamerStats(streamerChannelId);
        const entry = stats.users[userChannelId] ?? null;
        if (!entry) {
          if (!cancelled) {
            setData({ entry: null, result: null, breakdown: null, scope });
            setLoading(false);
          }
          return;
        }
        const result = await resolveFlagLevel(
          streamerChannelId,
          userChannelId,
          settings,
          sessionTracker,
        );
        const { flaggedCounts: breakdown } = extractPeriodStats({
          stats: entry,
          period: scope,
          sensitivity: settings.userFlagging.sensitivity,
          sessionStartTime: sessionTracker.getSessionStartTime(),
          sessionStats: sessionTracker.getSessionStats(userChannelId) ?? undefined,
        });
        if (!cancelled) {
          setData({ entry, result, breakdown, scope });
          setLoading(false);
        }
      } catch (err) {
        console.error('[FreshChatKeeper] StatsPanel load failed:', err);
        if (!cancelled) {
          setData({ entry: null, result: null, breakdown: null, scope: '30d' });
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [streamerChannelId, userChannelId]);

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // overlay 自身のクリックだけで閉じる（内側 panel のクリックは伝播するが、
    // panel 側で stopPropagation するため発火しない）
    if (e.target === e.currentTarget) onClose();
  };

  const handleBlock = async () => {
    if (busyAction !== null) return;
    setBusyAction('block');
    try {
      const settings = await loadSettings();
      const ok = await blockUser(userChannelId, userDisplayName, settings.displayMode);
      if (ok) showBlockUndoToast(userDisplayName, userChannelId);
    } finally {
      setBusyAction(null);
      onClose();
    }
  };

  const handleReset = async () => {
    if (busyAction !== null) return;
    // confirm（content script でも window.confirm は使えるが、a11y 上 React 側で
    // も同等の確認 UI が望ましい。MVP は window.confirm で許容）
    const ok = window.confirm(
      `${userDisplayName} の統計データを削除します。元に戻せません。よろしいですか？`,
    );
    if (!ok) return;
    setBusyAction('reset');
    try {
      await clearUserStatsFor(streamerChannelId, userChannelId);
    } finally {
      setBusyAction(null);
      onClose();
    }
  };

  const badge = data?.result ? flagLevelBadge(data.result.level) : null;
  const observed =
    data?.entry !== null && data?.entry !== undefined
      ? formatObservationRange(data.entry)
      : '';

  return (
    <div
      className="fck-stats-overlay"
      onClick={handleOverlayClick}
      role="presentation"
    >
      <div
        ref={containerRef}
        className="fck-stats-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fck-stats-panel-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="fck-stats-header">
          <h2 id="fck-stats-panel-title" className="fck-stats-title">
            {userDisplayName}
          </h2>
          <button
            type="button"
            className="fck-stats-close"
            aria-label="閉じる"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="fck-stats-body">
          {loading && <p className="fck-stats-loading">読み込み中…</p>}

          {!loading && data && data.entry === null && (
            <p className="fck-stats-empty">この視聴者の統計データはまだありません。</p>
          )}

          {!loading && data && data.entry !== null && (
            <>
              <section className="fck-stats-section">
                <div className="fck-stats-observed">
                  観測期間: {observed}（{SCOPE_LABEL[data.scope]}で集計）
                </div>
                {badge && data.result && (
                  <div className={`fck-stats-badge ${badge.cls}`}>{badge.text}</div>
                )}
              </section>

              {data.result && (
                <section
                  className="fck-stats-section fck-stats-summary"
                  aria-label="期間サマリ"
                >
                  <div>
                    総コメント数: <strong>{data.result.totalMessages}</strong>
                  </div>
                  <div>
                    フラグ該当: <strong>{data.result.totalFlagged}</strong>
                    {data.result.totalMessages > 0 && (
                      <>
                        {' '}
                        （
                        {(
                          (data.result.totalFlagged / data.result.totalMessages) *
                          100
                        ).toFixed(1)}
                        %）
                      </>
                    )}
                  </div>
                </section>
              )}

              {data.breakdown && (
                <section
                  className="fck-stats-section fck-stats-breakdown"
                  aria-label="カテゴリ別内訳"
                >
                  <h3 className="fck-stats-h3">カテゴリ別内訳</h3>
                  <ul>
                    {CATEGORY_LABELS.map(([key, label]) => {
                      const count = data.breakdown![key];
                      return (
                        <li
                          key={key}
                          className={count === 0 ? 'fck-stats-breakdown-zero' : ''}
                        >
                          <span>{label}</span>
                          <span>
                            <strong>{count}</strong> 件
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <section className="fck-stats-section">
                <h3 className="fck-stats-h3">日別推移（直近 3 週間）</h3>
                <DailyTimeline dailyStats={data.entry.dailyStats} />
              </section>
            </>
          )}

          {/* F-1（決定4b）: この配信でのコメント（時刻順・全表示・端末内・非永続）。
              stats entry の有無に関わらず、バッファにコメントがあれば表示する。 */}
          {!loading && (
            <SessionCommentsSection comments={sessionComments} />
          )}
        </div>

        <footer className="fck-stats-footer">
          <button
            type="button"
            className="fck-stats-action fck-stats-block"
            onClick={() => void handleBlock()}
            disabled={busyAction !== null}
          >
            🚫 ブロック
          </button>
          <button
            type="button"
            className="fck-stats-action fck-stats-reset"
            onClick={() => void handleReset()}
            disabled={busyAction !== null}
          >
            🗑️ この人の統計をリセット
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * F-1: 「この配信でのコメント」セクション。
 *
 * バッファ内の対象ユーザーのコメントを **時刻順に全表示**（通常コメントも含む）。
 * FCK が判定/フラグしたものには JP カテゴリ badge を併記（判定の説明責任）。
 * ガードレール: 端末内・非永続・**エクスポート/コピー UI なし**（表示のみ）。
 */
function SessionCommentsSection({ comments }: { comments: SessionComment[] }): JSX.Element {
  return (
    <section className="fck-stats-section fck-stats-comments" aria-label="この配信でのコメント">
      <h3 className="fck-stats-h3">この配信でのコメント</h3>
      <p className="fck-stats-comments-note">
        この配信内のみ・端末内のみ・保存されません（最大 {PER_USER_MAX} 件）
      </p>
      {comments.length === 0 ? (
        <p className="fck-stats-empty">この配信でのコメントはまだありません。</p>
      ) : (
        <ol className="fck-stats-comment-list">
          {comments.map((c, i) => {
            const marker =
              c.primary && c.primary !== 'safe' ? JUDGMENT_LABEL_JP[c.primary] : undefined;
            return (
              <li key={`${c.time}-${i}`} className="fck-stats-comment-item">
                <span className="fck-stats-comment-time">{formatCommentTime(c.videoTime)}</span>
                {marker && <span className="fck-stats-comment-mark">{marker}</span>}
                <span className="fck-stats-comment-text">{c.text}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function formatObservationRange(entry: UserStatsEntry): string {
  const first = entry.firstSeenAt > 0 ? new Date(entry.firstSeenAt) : null;
  const last = entry.lastSeenAt > 0 ? new Date(entry.lastSeenAt) : null;
  if (!first || !last) return '観測情報なし';
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return `${fmt(first)} 〜 ${fmt(last)}`;
}

export const __test__ = {
  flagLevelBadge,
  formatObservationRange,
  SCOPE_LABEL,
  CATEGORY_LABELS,
  SessionCommentsSection,
  JUDGMENT_LABEL_JP,
  formatCommentTime,
};
