/**
 * 親フレームの `<video>` の再生位置を読む（AR-3）。
 *
 * content script は live_chat_replay iframe で動くため、字幕 DOM / `<video>` がある
 * watch ページ本体（parent frame・同一 origin）を横断参照する（provider.ts の
 * readVideoTime と同じ流儀）。captionSignature が使っていた `video.currentTime` の
 * 取得を音声文脈（audioContext）でも再利用するための共通ヘルパー。
 */

/** 親フレーム watch ページの document（無ければ自 document、取得不能なら null）。 */
function getParentDocument(): Document | null {
  try {
    if (typeof window === 'undefined') return null;
    const parentDoc = window.parent?.document;
    if (parentDoc) return parentDoc;
    return typeof document !== 'undefined' ? document : null;
  } catch {
    // cross-origin / 拡張リロード時の例外ガード
    return null;
  }
}

/** 親 `<video>` の currentTime（秒）。取得不能なら null。 */
export function readParentVideoCurrentTime(): number | null {
  try {
    const doc = getParentDocument();
    const video = doc?.querySelector('video') as HTMLVideoElement | null;
    const t = video?.currentTime;
    return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : null;
  } catch {
    return null;
  }
}
