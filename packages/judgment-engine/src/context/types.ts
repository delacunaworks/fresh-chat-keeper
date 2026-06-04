/**
 * Phase 5（v0.6.0）字幕連動（caption MVP）の型定義。
 *
 * 設計 ground truth: `dev-docs/phase-5-audio-context.md`
 *   §「caption MVP スコープと前提の訂正（2026-06-03 追記）」
 *   §「アーキテクチャレビュー反映（2026-06-03）」
 *
 * このモジュールは judgment-engine の他層（user-stats 等）と同じく
 * **DOM / chrome.* / window.* 非依存**。字幕 DOM 抽出（YouTubeCaptionProvider）は
 * chrome-ext 側（P5-B3）で扱う。本層は字幕セグメントの純粋な型と品質評価ロジック、
 * および「直近 N 秒の生発話を取りに行く取得器」抽象 {@link AudioContextProvider}
 * のみを提供する。
 *
 * 抽象を MVP の中心に据えることで、後段の rolling summary / Whisper provider は
 * 同インターフェースに刺すだけで済む（設計の継ぎ目を最初から用意する）。
 */

/**
 * 字幕 1 セグメント（1 行分の発話）。
 *
 * `timestamp` は `video.currentTime`（秒）。`receivedAt` は取得時刻
 * （`Date.now()` 相当）だが、本層は時刻を生成しない（純粋性のため呼び出し側が
 * 渡す）。`estimatedSpeechTime` はライブ字幕の遅延補正後の発話推定時刻で、
 * P5-B3 の provider が埋める任意フィールド。
 */
export interface CaptionSegment {
  /** 字幕テキスト（1 セグメント分）。 */
  text: string;
  /** `video.currentTime`（秒）。セグメントが表示された再生位置。 */
  timestamp: number;
  /** 取得時刻（`Date.now()` 相当、ミリ秒 epoch）。呼び出し側が渡す（本層は生成しない）。 */
  receivedAt: number;
  /** ライブ遅延補正後の発話推定時刻（秒、任意）。P5-B3 で埋める。 */
  estimatedSpeechTime?: number;
}

/**
 * 字幕品質の問題種別。{@link CaptionQuality.issues} に列挙される。
 *
 * - `too_short`: 情報量不足（総文字数が短すぎる）
 * - `few_segments`: セグメント数不足（文脈が足りない）
 * - `corrupted_text`: 文字化け（制御文字・異常記号の比率が高い）
 * - `repetitive`: 同一フレーズの繰り返し（字幕エンジンのループ）
 * - `large_gaps`: 時間的非連続（セグメント間ギャップが大きい）
 */
export type CaptionQualityIssue =
  | 'too_short'
  | 'few_segments'
  | 'corrupted_text'
  | 'repetitive'
  | 'large_gaps';

/**
 * 字幕品質の評価結果。{@link evaluateCaptionQuality} の戻り値。
 */
export interface CaptionQuality {
  /** 総合スコア（0..1）。各チェックで減衰した積。 */
  overallScore: number;
  /** 検出された問題種別の一覧（問題なしなら空配列）。 */
  issues: CaptionQualityIssue[];
  /** 利用可能か（`overallScore >= しきい値`）。しきい値は呼び出し側が指定。 */
  useable: boolean;
}

/**
 * 直近 N 秒の生発話文脈。{@link AudioContextProvider.getRecentContext} の戻り値。
 *
 * `evaluateCaptionQuality` を同一 segments スナップショットに 1 回だけ走らせ、
 * `text` と `qualityScore` を**同時に**返す（ライブ字幕が呼び出し間で変わって
 * text と quality がズレるのを防ぐ）。
 */
export interface RecentAudioContext {
  /** 直近 N 秒分の発話テキスト（セグメント連結）。 */
  text: string;
  /** {@link evaluateCaptionQuality} 由来の総合スコア（0..1）。 */
  qualityScore: number;
  /** 取得元。MVP は必ず `'caption'`（Whisper 継ぎ目 + 観測用に型へ含める）。 */
  source: 'caption' | 'whisper';
  /** 連結に使ったセグメント数。 */
  segmentCount: number;
}

/**
 * 直近 N 秒の生発話を取りに行く取得器の抽象。**ステートレス**な取得 API。
 *
 * 原本の `getContextText()` + `getQualityScore()` の 2 メソッド分割は、ライブ字幕が
 * 呼び出し間で変わって text と quality がズレるため不採用。{@link getRecentContext}
 * が 1 スナップショットで両方を返す。
 *
 * MVP の実装は `YouTubeCaptionProvider`（DOM 字幕抽出、chrome-ext 側 P5-B3）。
 * 後段の Whisper / hybrid も同インターフェースに刺すだけで済む。
 */
export interface AudioContextProvider {
  /** provider 名（`'youtube-caption' | 'whisper' | 'hybrid'`）。観測・分岐用。 */
  getName(): string;
  /** この provider がこの環境で利用可能か（字幕トラックの有無等）。 */
  isAvailable(): Promise<boolean>;
  /**
   * 直近 `windowSeconds` 秒の発話文脈を取得する。
   *
   * **`null` = この瞬間は取得不能**（字幕 OFF / 品質低）。呼び出し側は素通し
   * （base context のまま判定する）。
   */
  getRecentContext(windowSeconds: number): Promise<RecentAudioContext | null>;
  /** 収集開始（DOM observer 起動等。実装依存）。 */
  start(): void;
  /** 収集停止（observer 解除・バッファ破棄等）。 */
  stop(): void;
}
