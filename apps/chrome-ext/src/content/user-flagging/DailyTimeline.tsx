/**
 * Phase 3.5 B6: 日別タイムライン（直近 3 週間グリッド）。
 *
 * 設計文書 §「統計詳細パネル」L862-910。曜日ヘッダ M T W T F S S と、
 * 「先々週 / 先週 / 今週」3 行 × 7 セル = 21 日。`dailyStats` に
 * 観測のない日は薄灰 □、観測ありフラグなしは □、フラグありは ▮（赤/黄、
 * 強度に応じて）。
 *
 * `now` は UTC 基準でテスト固定可能（B2 と同方針）。週の開始は **Monday**
 * （ISO 8601 に揃え、JS の `getUTCDay()` 0=Sun を 1=Mon 開始に変換）。
 */

import type { DailyStats, FlaggedCounts } from '@fresh-chat-keeper/judgment-engine';

interface DailyTimelineProps {
  /** UserStatsEntry.dailyStats（key は "YYYY-MM-DD" UTC） */
  dailyStats: Record<string, DailyStats>;
  /** テスト固定用。本番省略時は `new Date()` */
  now?: Date;
}

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'] as const;
const ROW_LABELS = ['先々週', '先週', '今週'] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function utcDateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Monday=0, Tuesday=1, ..., Sunday=6 に変換（getUTCDay は Sun=0）。 */
function mondayIndex(d: Date): number {
  const dow = d.getUTCDay();
  return (dow + 6) % 7;
}

function totalFlagged(fc: FlaggedCounts): number {
  return fc.spoiler + fc.harassment + fc.spam + fc.offTopic + fc.backseat;
}

/**
 * 1 日分のセル状態を分類する。
 * - 'empty': 観測なし（dailyStats に entry なし）
 * - 'clean': 観測あり、フラグなし
 * - 'low': フラグ比率 < 20% → 黄相当
 * - 'high': フラグ比率 >= 20% → 赤相当
 */
function classify(daily: DailyStats | undefined): 'empty' | 'clean' | 'low' | 'high' {
  if (!daily) return 'empty';
  const flagged = totalFlagged(daily.flaggedCounts);
  if (flagged === 0) return 'clean';
  const ratio = daily.messageCount > 0 ? flagged / daily.messageCount : 0;
  return ratio >= 0.2 ? 'high' : 'low';
}

function cellTitle(dateKey: string, daily: DailyStats | undefined): string {
  if (!daily) return `${dateKey}: 観測なし`;
  const flagged = totalFlagged(daily.flaggedCounts);
  return `${dateKey}: ${daily.messageCount} msgs, ${flagged} flagged`;
}

export function DailyTimeline({ dailyStats, now = new Date() }: DailyTimelineProps) {
  // 今週の月曜日（UTC）を基準に、過去 3 週間分を組み立てる。
  const todayMondayOffset = mondayIndex(now);
  // ms 単位で「今週の月曜 00:00 UTC」を算出
  const thisMondayMs =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    todayMondayOffset * MS_PER_DAY;

  // 3 行（先々週・先週・今週）× 7 セル
  const rows: Array<{ label: string; cells: Array<{ dateKey: string; daily: DailyStats | undefined }> }> = [];
  for (let weekOffset = 2; weekOffset >= 0; weekOffset--) {
    const cells: Array<{ dateKey: string; daily: DailyStats | undefined }> = [];
    for (let dayInWeek = 0; dayInWeek < 7; dayInWeek++) {
      const dayMs = thisMondayMs - weekOffset * 7 * MS_PER_DAY + dayInWeek * MS_PER_DAY;
      const dateKey = utcDateKey(new Date(dayMs));
      cells.push({ dateKey, daily: dailyStats[dateKey] });
    }
    rows.push({ label: ROW_LABELS[2 - weekOffset], cells });
  }

  return (
    <div className="fck-daily-timeline" role="table" aria-label="直近 3 週間の日別フラグ推移">
      <div className="fck-daily-header" role="row">
        <div className="fck-daily-row-label" role="rowheader" aria-hidden="true" />
        {WEEKDAYS.map((dow) => (
          <div key={dow} className="fck-daily-dow" role="columnheader">
            {dow}
          </div>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.label} className="fck-daily-row" role="row">
          <div className="fck-daily-row-label" role="rowheader">
            {row.label}
          </div>
          {row.cells.map((cell) => {
            const cls = classify(cell.daily);
            return (
              <div
                key={cell.dateKey}
                className={`fck-daily-cell fck-daily-${cls}`}
                role="cell"
                title={cellTitle(cell.dateKey, cell.daily)}
                aria-label={cellTitle(cell.dateKey, cell.daily)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

export const __test__ = { classify, mondayIndex, utcDateKey };
