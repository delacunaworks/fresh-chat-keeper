import type { FilterResult, UserProgress } from "./chat.js";
import type { FilterSettings, GameContext } from "./settings.js";

/**
 * プロキシ → LLM 判定リクエスト。
 *
 * 旧形式（v0.2.0、`gameId`/`progress`/`filterMode` トップレベル）と
 * 新形式（v0.3.0+、`context` + `tier`）の両方を表現する後方互換ユニオン的構造。
 * proxy 側 `isNewFormat` が `context` の有無で分岐する。
 */
export interface JudgeRequest {
  messages: Array<{
    id: string;
    text: string;
  }>;
  /** ゲームKB使用時に指定。ジャンルテンプレートのみの場合は省略可（旧形式） */
  gameId?: string | null;
  /** ゲームKB使用時に指定。ジャンルテンプレートのみの場合は省略可（旧形式） */
  progress?: UserProgress | null;
  /** フィルタモード（旧形式） */
  filterMode?: string;
  /** 有効化されているジャンルテンプレートのIDリスト（旧形式） */
  selectedGenreTemplates?: string[];
  /** YouTubeの動画タイトル（ゲーム自動推測に使用、旧形式） */
  videoTitle?: string;
  /**
   * 新形式（v0.3.0+）の判定コンテキスト。`game` + v3 `settings`。
   * proxy はこの有無で新旧形式を判別する。chrome-ext 側で
   * `as JudgeRequestPayload` キャストせずに構築できるよう後方互換 optional 追加（B4a）。
   */
  context?: {
    game?: GameContext;
    settings: FilterSettings;
    /**
     * Phase 5（v0.6.0 / P5-B4c）字幕連動: 配信者の直近 N 秒の発話文脈。
     * `captionContext.enabled === true` のクライアントだけが送る（既定 OFF）。
     * proxy はこれを Stage 2 prompt の Block3（`cache_control` なし）に乗せる。
     * P7-B5 以降は DO 由来の音声文脈（verbatim）が取得できればそちらを優先し、
     * これは DO 未投入/取得失敗時のフォールバック源として残る。
     */
    recentAudio?: { text: string; qualityScore: number };
    /**
     * Phase 7（P7-B5）: 配信の video_id。proxy がこれをキーに Service Binding 経由で
     * StreamContextDO の rolling summary（whole/recent/verbatim）を引き、Block3 に
     * 載せる。未指定なら従来どおり request 同梱の recentAudio のみで判定する。
     */
    videoId?: string;
    /**
     * Phase 7（AR-3）: 視聴者の再生位置（秒）。`audioContext.enabled === true` の
     * クライアントだけが送る。proxy がこれを summary 取得に `&t=` として付け、
     * アーカイブ transcript の「T までの累積要約 + T 直近の逐語」を引く
     * （★T より未来は返らない）。未指定なら live rolling のみ（従来挙動）。
     */
    currentTimeSeconds?: number;
  };
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
