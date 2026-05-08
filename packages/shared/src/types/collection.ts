/**
 * Phase 2.5（v0.3.5）データ収集インフラの型定義。
 *
 * 設計 ground truth: dev-docs/phase-2-5-data-collection.md §4
 *
 * 命名規則:
 * - TypeScript / JSON ワイヤー形式は **camelCase**（既存 FilterSettings と整合）
 * - VTuber 1B (sigvt/holodata) 互換フィールドは同名・同型（§2.6 参照）
 * - D1 カラムは snake_case（apps/api/src/db/schema.ts で mapper 化）
 *
 * フェーズ別取得タイミング:
 * - 【P2.5】Phase 2.5 リリース時点で値が入る
 * - 【P3+】Phase 3 以降で値が埋まり始める（Phase 2.5 では null / 'unknown' / false 固定）
 */

// ─── ラベル列挙 ────────────────────────────────────────────────

/** 段階B のラベル候補。Phase 2.5 では 'safe' | 'spoiler' のみ実用 */
export type CollectionLabel =
  | 'safe'
  | 'spoiler'
  | 'harassment'
  | 'spam'
  | 'off_topic'
  | 'backseat';

/** 段階A の関連性カテゴリ。Phase 2.5 では 'reaction'（isObviouslySafe 経路） / 'unknown' のみ */
export type StageACategory = 'story_reference' | 'reaction' | 'meta' | 'unknown';

/** 判定が行われた状況（直交概念）。Phase 2.5 では 'live' / 'archive_replay' のみ */
export type JudgmentMode = 'live' | 'archive_replay' | 'post_stream_review';

/** 誰がラベルを付けたか（直交概念）。Phase 2.5 では 'haiku' / 'user_report' のみ */
export type LabelSource = 'haiku' | 'user_report' | 'moderator' | 'tommy_manual';

/** 判定段階。Phase 2.5 では 'stage1' / 'stage2' のみ（'stage1_5' は Phase 3+） */
export type JudgmentStage = 'stage1' | 'stage1_5' | 'stage2';

// ─── サブ構造 ──────────────────────────────────────────────────

/**
 * 判定対象メッセージ。VTuber 1B 互換フィールド名に準拠（§2.6）。
 */
export interface TargetMessagePayload {
  /** メッセージ本文（VTuber 1B 互換、平文。誤判定改善のため） 【P2.5】 */
  body: string;
  /**
   * 投稿者の YouTube channel ID（VTuber 1B 互換）。
   * **クライアントは平文を送信し、apps/api 側で SHA-1 + COLLECTION_SALT で
   * ハッシュ化してから D1 に保存**（§2.6 参照、salt 漏洩リスク低減）。
   * 【P2.5】
   */
  authorChannelId: string;
  /** 投稿時刻（ISO 8601 UTC、VTuber 1B 互換） 【P2.5】 */
  timestamp: string;
  /** メンバーシップ保有者か（VTuber 1B 互換） 【P3+】 */
  isMember: boolean | null;
  /** モデレーターか（VTuber 1B 互換） 【P3+】 */
  isModerator: boolean | null;
  /** 認証済みアカウントか（VTuber 1B 互換） 【P3+】 */
  isVerified: boolean | null;
}

/** 前後コンテキスト要素（VTuber 1B 互換構造） */
export interface ContextMessage {
  body: string;
  timestamp: string;
}

/** ユーザーフィードバック（誤判定報告）。Phase 2.5 では失敗カテゴリは簡易選択肢のみ */
export interface UserFeedbackPayload {
  /** 報告日時（ISO 8601） */
  reportedAt: string;
  /** 視聴者が考える正しいラベル */
  correctLabel: 'spoiler' | 'safe' | 'unknown';
  /** 失敗カテゴリ（簡易選択肢） 【P3+ で拡張】 */
  failureCategory:
    | 'background_detail'
    | 'external_reference'
    | 'prediction'
    | 'metaphor'
    | 'other'
    | null;
  /** 自由記述（任意） */
  freeTextReason: string | null;
}

// ─── ログレコード ──────────────────────────────────────────────

/**
 * 判定 1 件分のログレコード（v0）。
 *
 * 設計方針:
 * - judgmentMode と labelSource は直交概念
 * - スキーマは増分追記のみ（破壊的変更を避ける、§9.4 参照）
 * - VTuber 1B (https://www.kaggle.com/datasets/uetchy/vtuber-livechat) と
 *   フィールド名・型を揃え、将来の結合分析を可能にする
 */
export interface SpoilerJudgmentLog {
  // ─── 識別子 ─────────────────
  /** ログID（UUID v4、クライアント側で発行） 【P2.5】 */
  logId: string;
  /** 記録時刻（ISO 8601、システム側のタイムスタンプ） 【P2.5】 */
  recordedAt: string;
  /** 同意バージョン。consentVersion が一致しないリクエストはサーバーで 410 で拒否 【P2.5】 */
  consentVersion: string;

  // ─── 配信メタデータ（VTuber 1B 互換） ─────────────────
  /** YouTube videoId（VTuber 1B 互換） 【P2.5】 */
  videoId: string;
  /** 配信者の YouTube channel ID（VTuber 1B 互換） 【P2.5】 */
  channelId: string;
  /** 知識ベース上のゲームID。ジャンルテンプレートのみ使用時は null 【P2.5】 */
  gameTitle: string | null;
  /** 動画タイトルから抽出した進行ヒント（例: "Part3"） 【P3+】 */
  streamProgressHint: string | null;
  /** 配信開始からの経過秒。アーカイブは再生位置、ライブは投稿時刻ベース 【P2.5】 */
  timeIntoStream: number | null;

  // ─── 判定モード ─────────────────
  /** 判定が行われた状況。Phase 2.5 では 'live' / 'archive_replay' のみ 【P2.5】 */
  judgmentMode: JudgmentMode;

  // ─── 判定対象（VTuber 1B 互換） ─────────────────
  targetMessage: TargetMessagePayload;

  // ─── コンテキスト（前後コメント） ─────────────────
  /** 直前 N 件。アーカイブは N=10、ライブは Phase 2.5 では空配列 【P2.5: archive のみ】 */
  precedingMessages: ContextMessage[];
  /** 直後 M 件。事後ラベリング時に Phase 3+ で記録 【P3+】 */
  followingMessages: ContextMessage[];

  // ─── 段階A: 関連性判定 ─────────────────
  /**
   * Phase 2.5 では基本 'unknown' 固定だが、isObviouslySafe（Stage 1 の
   * outcome: 'pass' 経路）に該当する判定は 'reaction' を記録。
   * 詳細: dev-docs/phase-2-5-data-collection.md §2.1 / §4.4
   */
  stageACategory: StageACategory;
  /** 段階A の信頼度。Phase 2.5 では null 固定（ルールベースで信頼度概念なし） 【P3+】 */
  stageAConfidence: number | null;

  // ─── 段階B: 判定 ─────────────────
  /** マルチラベル化の準備。Phase 2.5 では ['spoiler'] | ['safe'] の単一要素のみ 【P2.5】 */
  labels: CollectionLabel[];
  /** primary ラベル 【P2.5】 */
  primaryLabel: CollectionLabel;
  /** 判定信頼度（Stage 2 LLM 出力スコアまたは Stage 1 確定の場合 1.0） 【P2.5】 */
  confidence: number;
  /** 判定段階。Phase 2.5 では 'stage1' / 'stage2' のみ 【P2.5: stage1 | stage2】 */
  stage: JudgmentStage;
  /** 判定理由（日本語、LLM 出力） 【P2.5】 */
  reasonJa: string | null;

  // ─── ラベル管理 ─────────────────
  /** 誰がラベルを付けたか。Phase 2.5 では 'haiku' / 'user_report' のみ 【P2.5】 */
  labelSource: LabelSource;
  /** 人間レビュー済みか。Phase 2.5 では false 固定 【P3+】 */
  reviewedByHuman: boolean;

  // ─── ユーザーフィードバック 【P2.5: 誤判定報告のみ】 ─────────────────
  userFeedback: UserFeedbackPayload | null;

  // ─── システム ─────────────────
  /** 拡張バージョン（manifest.version） 【P2.5】 */
  extensionVersion: string;
  /** 視聴者の匿名トークン（ハッシュ済み）。consent 取り消し時の削除キー 【P2.5】 */
  userTokenHashed: string;
}

// ─── 同意 ──────────────────────────────────────────────────────

/**
 * ユーザーの同意記録。
 * クライアント側 chrome.storage と、サーバー側 D1 の双方に保存。
 */
export interface ConsentRecord {
  /** 同意したユーザーの匿名トークン（ハッシュ化） */
  userTokenHashed: string;
  /** 同意したバージョン（例: "2026-05-01"） */
  consentVersion: string;
  /** 同意した時刻（ISO 8601） */
  consentedAt: string;
  /** 取り消した時刻（ISO 8601、null は有効） */
  revokedAt: string | null;
}

// ─── ワイヤー形式（API リクエスト / レスポンス） ──────────────

/**
 * POST /v1/ingest のリクエストボディ。
 * バッチ最大 50 件（設計書 §6）、超過時はサーバーが 413 を返す。
 */
export interface IngestRequestPayload {
  /** クライアントが同意したバージョン。サーバーの現行版と不一致なら 410 Gone */
  consentVersion: string;
  /** 判定ログのバッチ。最大 50 件 */
  logs: SpoilerJudgmentLog[];
}

/** POST /v1/ingest のレスポンス（200 OK） */
export interface IngestResponsePayload {
  /** 受け入れた件数 */
  accepted: number;
  /** 拒否した件数（Phase 2.5 では基本 0、将来の partial accept 用） */
  rejected: number;
  /** サーバー側で有効な consentVersion（クライアントが照合可能） */
  currentConsentVersion: string;
}

/**
 * 410 Gone レスポンス。クライアントは同意モーダルを再表示し、
 * `currentConsentVersion` で再同意を取り直す。
 */
export interface ConsentVersionMismatchResponse {
  error: 'consent_version_mismatch';
  currentConsentVersion: string;
}

/**
 * POST /v1/revoke のリクエストボディ。
 *
 * ヘッダの x-fck-token がそのまま削除キーになるため、ボディは空でも理論的には可。
 * 将来の拡張余地のために構造体として定義しておく（Phase 2.5 では空オブジェクト相当）。
 */
export interface RevokeRequestPayload {
  /** 取り消し理由（任意、Phase 2.5 では未使用、Phase 3+ で UX 改善に活用予定） */
  reason?: string;
}

/** POST /v1/revoke のレスポンス（200 OK、idempotent） */
export interface RevokeResponsePayload {
  /** revoke 処理が完了したか（既に revoked / 未 consent でも true） */
  revoked: true;
  /** 削除された judgment_logs の概算件数（取得できない場合は null） */
  deletedLogCount: number | null;
}

/**
 * POST /v1/consent のリクエストボディ。
 * クライアントが opt-in モーダルで「同意」した直後に送信し、サーバー側
 * consent_records に記録を残す（後の revoke / retention の起点）。
 */
export interface ConsentNotifyRequestPayload {
  /** 同意したバージョン（consent_versions.version と一致する必要あり） */
  consentVersion: string;
}

/** POST /v1/consent のレスポンス（200 OK） */
export interface ConsentNotifyResponsePayload {
  /** 同意が記録されたか（新規 INSERT or 既存行の revoked_at クリア） */
  recorded: true;
  /** サーバー側で有効な現行バージョン（クライアント側の整合確認用） */
  currentConsentVersion: string;
}
