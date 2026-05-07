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

  judgment_mode TEXT NOT NULL,            -- 'live' | 'archive_replay' | 'post_stream_review'

  -- 判定対象（VTuber 1B 互換、フィールド名は彼らの命名に準拠）
  target_body TEXT NOT NULL,              -- VTuber 1B: body
  target_author_channel_id TEXT NOT NULL, -- VTuber 1B: authorChannelId（SHA-1 ハッシュ済み）
  target_timestamp INTEGER NOT NULL,      -- Unix ms（VTuber 1B: timestamp、投稿時刻）
  target_is_member INTEGER,               -- 0/1/null（P3+ で記録）
  target_is_moderator INTEGER,            -- 0/1/null（P3+）
  target_is_verified INTEGER,             -- 0/1/null（P3+）

  -- 前後コンテキスト（JSON 配列、各要素 {body, timestamp}）
  preceding_messages_json TEXT NOT NULL DEFAULT '[]',
  following_messages_json TEXT NOT NULL DEFAULT '[]',

  -- 段階A
  stage_a_category TEXT NOT NULL DEFAULT 'unknown',
  stage_a_confidence REAL,

  -- 段階B（判定結果）
  labels_json TEXT NOT NULL,              -- JSON 配列
  primary_label TEXT NOT NULL,
  confidence REAL NOT NULL,
  stage TEXT NOT NULL,                    -- 'stage1' | 'stage1_5' | 'stage2'
  reason_ja TEXT,

  -- ラベル管理
  label_source TEXT NOT NULL,             -- 'haiku' | 'user_report' | 'moderator' | 'tommy_manual'
  reviewed_by_human INTEGER NOT NULL DEFAULT 0,  -- 0/1

  -- ユーザーフィードバック（JSON、null 可）
  user_feedback_json TEXT,

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

-- ─── 同意バージョン管理 ─────────────────────────────────────────
CREATE TABLE consent_versions (
  version TEXT PRIMARY KEY,
  policy_url TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  superseded_at INTEGER                   -- null = 現在有効
);

-- ─── ユーザー同意記録（取り消し時の削除キー検索用） ──────────────
CREATE TABLE consent_records (
  user_token_hashed TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consented_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (user_token_hashed, consent_version)
);

CREATE INDEX idx_consent_revoked ON consent_records(revoked_at)
  WHERE revoked_at IS NOT NULL;
