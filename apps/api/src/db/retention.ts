/**
 * Retention（自動削除）ロジック。
 *
 * 設計書 §5.5 に準拠:
 * - judgment_logs: received_at が 90 日 (= 90 * 86400_000 ms) より古い行を DELETE
 * - consent_records: revoked_at が non-null かつ 30 日より古い行を DELETE
 *
 * 設計判断:
 * - 期間境界は **「now - N日」より前**（exclusive）。N 日丁度の行は残す。
 *   論文系の retention 文献では包含が混在するが、Phase 2.5 では「90 日経過した
 *   ログは 91 日目に削除される」読み取りが UX 上わかりやすい。
 * - 削除件数は console.info で出力。Cloudflare Logs から運用監視できる
 *   形式（`[fck-api]` プレフィックスは fail-open warn と整合）
 * - DELETE は 1 トランザクションで両テーブル削除。partial failure を避ける
 */

const DAY_MS = 86_400_000;

export const LOG_RETENTION_DAYS = 90;
export const REVOKED_CONSENT_RETENTION_DAYS = 30;

export interface RetentionResult {
  deletedLogs: number;
  deletedRevokedConsent: number;
  /** 削除に使った now 時刻（テスト用、ログにも出力） */
  evaluatedAt: number;
}

/**
 * 両テーブルの retention を 1 batch で実行する。
 *
 * @param db D1 binding
 * @param nowMs テスト時に注入できる現在時刻。本番は Date.now()
 */
export async function runRetention(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<RetentionResult> {
  const logCutoff = nowMs - LOG_RETENTION_DAYS * DAY_MS;
  const revokedCutoff = nowMs - REVOKED_CONSENT_RETENTION_DAYS * DAY_MS;

  const stmts = [
    db
      .prepare(`DELETE FROM judgment_logs WHERE received_at < ?`)
      .bind(logCutoff),
    db
      .prepare(
        `DELETE FROM consent_records
         WHERE revoked_at IS NOT NULL AND revoked_at < ?`,
      )
      .bind(revokedCutoff),
  ];

  const results = await db.batch(stmts);
  const deletedLogs = results[0]?.meta?.changes ?? 0;
  const deletedRevokedConsent = results[1]?.meta?.changes ?? 0;

  console.info(
    `[fck-api] retention: deleted ${deletedLogs} judgment_logs (>${LOG_RETENTION_DAYS}d) ` +
      `and ${deletedRevokedConsent} revoked consent_records (>${REVOKED_CONSENT_RETENTION_DAYS}d) ` +
      `at ${new Date(nowMs).toISOString()}`,
  );

  return { deletedLogs, deletedRevokedConsent, evaluatedAt: nowMs };
}
