-- Phase 2.5 D1 初期スキーマ（v0.3.5）
--
-- 設計 ground truth: dev-docs/phase-2-5-data-collection.md §5.3
--
-- 命名規則:
-- - TypeScript / JSON ワイヤー形式は camelCase（packages/shared 側）
-- - D1 カラムは snake_case（SQL 慣習）
-- - VTuber 1B (sigvt/holodata) 互換フィールドは命名・型を彼らに揃える
--   （video_id / channel_id / target_author_channel_id 等）
--
-- 適用方法（B2 / DEPLOY-01 で実施、本ファイルでは作業しない）:
--   wrangler d1 create fck-collection-db
--   wrangler d1 migrations apply fck-collection-db --remote
--
-- B2 改訂メモ:
-- - 列挙値カラム（judgment_mode 等）に CHECK 制約を追加し、不正値の混入を阻止
-- - JSON 列に json_valid() CHECK を追加し、壊れた JSON が D1 に入ることを防ぐ
-- - consent_records.consent_version → consent_versions.version の FK は **意図的に省略**:
--   1) 同意 UI から先に POST が来た場合の race condition を避ける
--   2) consent_versions テーブルの初期データ投入は DEPLOY-01 で別途行う
--   3) 整合性は ingestion 側の consent-check middleware で実用上担保される

-- ─── 判定ログ（SpoilerJudgmentLog の永続化）──────────────────────
CREATE TABLE judgment_logs (
  log_id TEXT PRIMARY KEY,
  recorded_at INTEGER NOT NULL,           -- Unix ms（システムタイムスタンプ）
  consent_version TEXT NOT NULL,

  -- 配信メタデータ（VTuber 1B 互換）
  video_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  game_title TEXT,
  stream_progress_hint TEXT,
  time_into_stream INTEGER,               -- 秒、null 可

  judgment_mode TEXT NOT NULL
    CHECK (judgment_mode IN ('live', 'archive_replay', 'post_stream_review')),

  -- 判定対象（VTuber 1B 互換、フィールド名は彼らの命名に準拠）
  target_body TEXT NOT NULL,              -- VTuber 1B: body
  target_author_channel_id TEXT NOT NULL, -- VTuber 1B: authorChannelId（SHA-1 ハッシュ済み）
  target_timestamp INTEGER NOT NULL,      -- Unix ms（VTuber 1B: timestamp、投稿時刻）
  target_is_member INTEGER,               -- 0/1/null（P3+ で記録）
  target_is_moderator INTEGER,            -- 0/1/null（P3+）
  target_is_verified INTEGER,             -- 0/1/null（P3+）

  -- 前後コンテキスト（JSON 配列、各要素 {body, timestamp}）
  preceding_messages_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(preceding_messages_json)),
  following_messages_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(following_messages_json)),

  -- 段階A
  stage_a_category TEXT NOT NULL DEFAULT 'unknown'
    CHECK (stage_a_category IN ('story_reference', 'reaction', 'meta', 'unknown')),
  stage_a_confidence REAL,

  -- 段階B（判定結果）
  labels_json TEXT NOT NULL                       -- JSON 配列
    CHECK (json_valid(labels_json)),
  primary_label TEXT NOT NULL
    CHECK (primary_label IN ('safe', 'spoiler', 'harassment', 'spam', 'off_topic', 'backseat')),
  confidence REAL NOT NULL,
  stage TEXT NOT NULL
    CHECK (stage IN ('stage1', 'stage1_5', 'stage2')),
  reason_ja TEXT,

  -- ラベル管理
  label_source TEXT NOT NULL
    CHECK (label_source IN ('haiku', 'user_report', 'moderator', 'tommy_manual')),
  reviewed_by_human INTEGER NOT NULL DEFAULT 0,  -- 0/1

  -- ユーザーフィードバック（JSON、null 可）
  user_feedback_json TEXT
    CHECK (user_feedback_json IS NULL OR json_valid(user_feedback_json)),

  -- システム
  extension_version TEXT NOT NULL,
  user_token_hashed TEXT NOT NULL,

  -- 受信時刻（retention 用）
  received_at INTEGER NOT NULL
);

CREATE INDEX idx_logs_channel ON judgment_logs(channel_id);
CREATE INDEX idx_logs_video ON judgment_logs(video_id);
CREATE INDEX idx_logs_received_at ON judgment_logs(received_at);
CREATE INDEX idx_logs_label_source ON judgment_logs(label_source);
CREATE INDEX idx_logs_judgment_mode ON judgment_logs(judgment_mode);
-- VTuber 1B との結合分析時の join key
CREATE INDEX idx_logs_author ON judgment_logs(target_author_channel_id);
-- revoke 時の削除キー（user_token_hashed 単位の bulk delete を高速化）
CREATE INDEX idx_logs_user_token ON judgment_logs(user_token_hashed);

-- ─── 同意バージョン管理 ─────────────────────────────────────────
CREATE TABLE consent_versions (
  version TEXT PRIMARY KEY,
  policy_url TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  superseded_at INTEGER                   -- null = 現在有効
);

-- ─── ユーザー同意記録（取り消し時の削除キー検索用） ──────────────
-- consent_version は consent_versions.version への論理参照だが、FK は意図的に
-- 設定しない（race condition 回避と運用上の柔軟性のため、ファイル冒頭コメント参照）。
CREATE TABLE consent_records (
  user_token_hashed TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consented_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (user_token_hashed, consent_version)
);

CREATE INDEX idx_consent_revoked ON consent_records(revoked_at)
  WHERE revoked_at IS NOT NULL;
