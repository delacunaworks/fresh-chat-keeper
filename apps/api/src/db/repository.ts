/**
 * D1 アクセス層。
 *
 * 設計方針:
 * - SQL は本ファイルに集約し、ルートハンドラが直接クエリを書かない
 * - 一括挿入は D1 の `prepare().bind()` + `batch()` で transaction 化（partial failure 回避）
 * - 例外は呼び出し側（ハンドラ）でキャッチして適切な HTTP ステータスに変換
 */

import type { JudgmentLogRow, ConsentVersionRow } from './schema.js';

// ─── judgment_logs ───────────────────────────────────────────

const INSERT_JUDGMENT_LOG_SQL = `
INSERT INTO judgment_logs (
  log_id, recorded_at, consent_version,
  video_id, channel_id, game_title, stream_progress_hint, time_into_stream,
  judgment_mode,
  target_body, target_author_channel_id, target_timestamp,
  target_is_member, target_is_moderator, target_is_verified,
  preceding_messages_json, following_messages_json,
  stage_a_category, stage_a_confidence,
  labels_json, primary_label, confidence, stage, reason_ja,
  label_source, reviewed_by_human, user_feedback_json,
  extension_version, user_token_hashed, received_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

/**
 * judgment_logs に N 件を一括挿入する。
 *
 * D1 の `batch()` API は内部で SQLite transaction として実行されるため、
 * 1 件でも CHECK 制約違反があれば全体がロールバックされる。設計書 §5.4 の
 * 「partial accept はしない」方針と整合。
 */
export async function insertJudgmentLogs(
  db: D1Database,
  rows: JudgmentLogRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare(INSERT_JUDGMENT_LOG_SQL);
  const statements = rows.map((r) =>
    stmt.bind(
      r.log_id,
      r.recorded_at,
      r.consent_version,
      r.video_id,
      r.channel_id,
      r.game_title,
      r.stream_progress_hint,
      r.time_into_stream,
      r.judgment_mode,
      r.target_body,
      r.target_author_channel_id,
      r.target_timestamp,
      r.target_is_member,
      r.target_is_moderator,
      r.target_is_verified,
      r.preceding_messages_json,
      r.following_messages_json,
      r.stage_a_category,
      r.stage_a_confidence,
      r.labels_json,
      r.primary_label,
      r.confidence,
      r.stage,
      r.reason_ja,
      r.label_source,
      r.reviewed_by_human,
      r.user_feedback_json,
      r.extension_version,
      r.user_token_hashed,
      r.received_at,
    ),
  );
  await db.batch(statements);
}

// ─── consent_versions ────────────────────────────────────────

/**
 * 現在有効な同意バージョン（superseded_at IS NULL）を 1 件取得。
 *
 * 結果は CONSENT_KV にキャッシュされる想定（middleware 側で実装）。
 * 同時に複数の有効バージョンが存在することは設計上ない（DEPLOY-01 の
 * 投入手順で superseded_at を必ず更新する）が、複数返ってきた場合は
 * effective_from が最新のものを返す。
 */
export async function getActiveConsentVersion(
  db: D1Database,
): Promise<ConsentVersionRow | null> {
  const result = await db
    .prepare(
      `SELECT version, policy_url, effective_from, superseded_at
       FROM consent_versions
       WHERE superseded_at IS NULL
       ORDER BY effective_from DESC
       LIMIT 1`,
    )
    .first<ConsentVersionRow>();
  return result ?? null;
}

// ─── consent_records ─────────────────────────────────────────

/**
 * ユーザーの同意取り消しを記録し、関連する judgment_logs を削除する。
 *
 * 手順:
 * 1. consent_records.revoked_at を更新（該当行が無ければ INSERT で revoked 状態を作る）
 * 2. judgment_logs から user_token_hashed が一致する行を削除
 *
 * Phase 2.5 では同期削除（小規模なバッチ前提）。将来件数が増えたら retention
 * cron に委譲する設計に変える（設計書 §6.4）。
 *
 * @returns 削除した judgment_logs の件数（D1 の changes / `meta.changes`）
 */
export async function revokeConsentAndDeleteLogs(
  db: D1Database,
  hashedUserToken: string,
  revokedAt: number,
): Promise<number> {
  // (1) consent_records.revoked_at を更新。該当ユーザーの全 consent_version を一括 revoke。
  //     UPSERT は使わず UPDATE で十分（同意していないユーザーから revoke が来た場合は
  //     行が存在せず changes=0、処理は idempotent に成功扱い）。
  await db
    .prepare(
      `UPDATE consent_records
       SET revoked_at = ?
       WHERE user_token_hashed = ?
         AND revoked_at IS NULL`,
    )
    .bind(revokedAt, hashedUserToken)
    .run();

  // (2) judgment_logs から該当ユーザーのログを削除
  const deleteResult = await db
    .prepare(
      `DELETE FROM judgment_logs WHERE user_token_hashed = ?`,
    )
    .bind(hashedUserToken)
    .run();

  // D1 の RunResult.meta.changes は削除件数を含む
  return deleteResult.meta?.changes ?? 0;
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = {
  INSERT_JUDGMENT_LOG_SQL,
};
