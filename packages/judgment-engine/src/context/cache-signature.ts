/**
 * Phase 5（v0.6.0）Stage 2 判定キャッシュキー用の字幕シグネチャ（純粋関数）。
 *
 * 設計 ground truth: `dev-docs/phase-5-audio-context.md`
 *   §「アーキテクチャレビュー反映」🚨 最重要: Stage 2 キャッシュキーに字幕
 *   シグネチャを混ぜる。
 *
 * 字幕を判定 prompt に足すと判定結果は発話文脈で変わる。だがキャッシュキーが
 * 字幕を含まないと「同じコメント文は最初の判定がキャッシュされ続け、文脈が進んでも
 * 古い判定を返す」→ Phase 5 の価値がキャッシュで打ち消される。これを防ぐため、
 * キャッシュキーに**粗い字幕シグネチャ**を混ぜる。生字幕は毎秒変わるので
 * `video.currentTime` を一定秒数のバケットに量子化して粒度を粗くする。
 *
 * **後方互換（最重要）**: 字幕 OFF / 未配線のとき本関数は `'nocap'` を返し、
 * 呼び出し側は **これをキーに挿入しない**（v0.5.0 の現行キーとバイト一致）。
 * captionContext は既定 OFF なので、字幕を使わない大多数のユーザーの既存
 * `fck_judge_cache` が無効化されない。DOM / chrome.* 非依存。
 */

/** 字幕シグネチャのバケット粒度（秒）。30 = 字幕 60 秒窓の半分。 */
export const CAPTION_CACHE_BUCKET_SECONDS = 30;

/**
 * Stage 2 判定キャッシュキーに混ぜる字幕シグネチャを返す。
 *
 * - 字幕なし（`hasCaption=false`）or `currentTime` 不明（null/undefined/NaN/Infinity）
 *   → `'nocap'`（呼び出し側はこれをキーに挿入しない＝v0.5.0 とバイト一致＝後方互換）
 * - 字幕あり → `'c{bucket}'`（`currentTime` を `bucketSeconds` で量子化）。
 *   同一バケット内の複数判定は同一文脈とみなしキャッシュ共有、バケットをまたぐと再判定。
 *
 * @param hasCaption 字幕文脈が有効か（呼び出し側が `RecentAudioContext !== null` 等で判定）
 * @param currentTimeSeconds `video.currentTime`（秒）。取得不能なら null/undefined
 * @param bucketSeconds 量子化粒度（既定 {@link CAPTION_CACHE_BUCKET_SECONDS}）
 */
export function captionCacheSignature(
  hasCaption: boolean,
  currentTimeSeconds: number | null | undefined,
  bucketSeconds: number = CAPTION_CACHE_BUCKET_SECONDS,
): string {
  if (
    !hasCaption ||
    currentTimeSeconds == null ||
    !Number.isFinite(currentTimeSeconds)
  ) {
    return 'nocap';
  }
  return `c${Math.floor(currentTimeSeconds / bucketSeconds)}`;
}
