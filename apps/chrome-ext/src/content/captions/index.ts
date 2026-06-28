/**
 * Phase 5（v0.6.0）字幕連動（caption MVP）の chrome-ext 側バレル。
 *
 * 純粋型・品質評価は judgment-engine の `context/`（P5-B2）。本ディレクトリは
 * その DOM 実装（YouTubeCaptionProvider）+ 遅延補正 + provider 選択 factory。
 */
export { YouTubeCaptionProvider } from './provider.js';
export {
  adjustForLiveDelay,
  ESTIMATED_LIVE_CAPTION_DELAY_SECONDS,
} from './live-delay.js';
export { createAudioContextProvider } from './factory.js';
// Phase 7（P7-FEED）: DOM 字幕を StreamContextDO へ定期送信する feeder。
export { CaptionFeeder, type CaptionFeederDeps } from './feeder.js';
