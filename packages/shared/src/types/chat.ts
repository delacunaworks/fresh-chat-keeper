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
 * フィルタ判定結果
 */
export interface FilterResult {
  messageId: string;
  verdict: FilterVerdict;
  /** Stage 1 でマッチしたキーワード */
  matchedKeywords?: string[];
  /** Stage 2 LLM が判定したカテゴリ */
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
