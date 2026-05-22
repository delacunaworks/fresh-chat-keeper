/**
 * チャットメッセージ（YouTube チャットリプレイ / ライブチャット共通）
 */
export interface ChatMessage {
  id: string;
  videoId: string;
  authorId: string;
  authorName: string;
  text: string;
  /** アーカイブモード: 動画内のオフセット（ミリ秒） */
  videoOffsetMs?: number;
  /** ライブモード: 投稿タイムスタンプ（Unix ms） */
  timestampMs?: number;
  /** スーパーチャット等の強調メッセージかどうか */
  isHighlighted?: boolean;
}

/**
 * Phase 3（v0.4.0）マルチラベル分類のラベル集合。
 *
 * judgment-engine の `JudgmentLabel` と完全に同一の union。
 * shared 側で定義することで、shared が judgment-engine に依存せずに
 * `FilterResult.labels` / `FilterResult.primary` を表現できる。
 *
 * Phase 2.5 の `CollectionLabel`（データ収集ログ用）も同じ値域を持つが、
 * 意味的に「判定エンジンが出力するラベル」と「データ収集レイヤーで保存するラベル」は
 * 直交概念なので、別名で並存させる。実装上は完全一致するため相互変換不要。
 */
export type JudgmentLabel =
  | "safe"
  | "spoiler"
  | "harassment"
  | "spam"
  | "off_topic"
  | "backseat";

/**
 * フィルタ判定結果。
 *
 * Phase 3 で labels / primary が追加された。proxy / chrome-ext v0.4.0 以降は
 * これを参照し、verdict はクライアント側で labels + ユーザー設定から導出する
 * 想定。verdict / spoilerCategory フィールドは Phase 2 までの互換のため残置。
 */
export interface FilterResult {
  messageId: string;
  /** Block / allow / uncertain。LLM 判定 + ユーザーカテゴリ設定から導出 */
  verdict: FilterVerdict;
  /** Stage 1 でマッチしたキーワード */
  matchedKeywords?: string[];
  /**
   * Phase 3 マルチラベル: 該当する全ラベル（マルチラベル分類の生結果）。
   * 1件以上の要素を含む（最小ケースは `['safe']`）。
   */
  labels?: JudgmentLabel[];
  /**
   * Phase 3 マルチラベル: 最も深刻な単一ラベル。
   * `labels` から judgment-engine の `LABEL_PRECEDENCE` で導出される。
   * UI 表示・verdict 計算の主要キー。
   */
  primary?: JudgmentLabel;
  /**
   * @deprecated Phase 3 で {@link FilterResult.labels} / {@link FilterResult.primary} に置換。
   * Phase 2 までの spoiler サブカテゴリ。新クライアントは labels/primary を参照すること。
   */
  spoilerCategory?: "direct_spoiler" | "foreshadowing_hint" | "gameplay_hint" | "safe";
  /** 信頼スコア（0–1） */
  confidence?: number;
  /** Stage 2 LLM の判定理由（日本語、UI/デバッグ用） */
  reason?: string;
  /** 処理ステージ（1 = キーワード/ベクトル, 2 = LLM） */
  stage: 1 | 2;
}

export type FilterVerdict = "block" | "allow" | "uncertain";

/**
 * フィルタモード（ユーザー設定）
 */
export type FilterMode = "strict" | "standard" | "lenient" | "off";

/**
 * ユーザーのゲーム進行状況
 *
 * 進行状況セマンティクス（v0.3.1 PROG-01 で明示）:
 * - chapter モード: 「視聴中セマンティクス」。`currentChapterId` は今プレイ中
 *   （未通過）のチャプターを表し、その章自身のネタバレも保護対象
 * - event モード: 「通過済みセマンティクス」。`completedEventIds` には既に
 *   通過したイベントの ID を入れる（その後はネタバレ保護対象外）
 */
export interface UserProgress {
  gameId: string;
  progressModel: "chapter" | "event";
  /**
   * チャプターモード: 現在視聴中のチャプターID（未通過）。
   * このチャプター自身のキーワードもネタバレフィルタの対象になる。
   */
  currentChapterId?: string;
  /** イベントモード: 通過済みイベントIDのリスト（その後はフィルタ対象外） */
  completedEventIds?: string[];
}
