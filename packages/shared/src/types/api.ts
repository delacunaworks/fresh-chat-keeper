import type { FilterResult, UserProgress } from "./chat.js";

/**
 * プロキシ → LLM 判定リクエスト
 */
export interface JudgeRequest {
  messages: Array<{
    id: string;
    text: string;
  }>;
  /** ゲームKB使用時に指定。ジャンルテンプレートのみの場合は省略可 */
  gameId?: string | null;
  /** ゲームKB使用時に指定。ジャンルテンプレートのみの場合は省略可 */
  progress?: UserProgress | null;
  /** フィルタモード */
  filterMode?: string;
  /** 有効化されているジャンルテンプレートのIDリスト */
  selectedGenreTemplates?: string[];
  /** YouTubeの動画タイトル（ゲーム自動推測に使用） */
  videoTitle?: string;
  /**
   * ユーザーティア。Phase 2 では optional（未指定時は 'free' 扱い）。
   * Phase 3 以降でモデルルーターがティア別判定を行うため、新クライアントは送信すべき。
   */
  tier?: 'free' | 'premium' | 'streamer';
}

/**
 * プロキシ → LLM 判定レスポンス
 */
export interface JudgeResponse {
  results: FilterResult[];
  /**
   * Stage 2 LLM レスポンスのパースに失敗し（リトライしてもなお）、全件 safe
   * フォールバックで返したことを示す（Phase 3 B4a）。後方互換 optional。
   * クライアントはこのバッチの safe 結果を**永続キャッシュしない**こと
   * （再判定の余地を残す。phase-3-multilabel.md §追補 2）。
   */
  degraded?: boolean;
}

/**
 * Result 型パターン
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
