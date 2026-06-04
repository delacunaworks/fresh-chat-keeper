/**
 * Phase 5（v0.6.0）AudioContextProvider 選択 factory（chrome-ext 側）。
 *
 * 設計 ground truth: `dev-docs/phase-5-audio-context.md`
 *   §「プロバイダ選択 factory は chrome-ext 側」。
 *
 * `HybridProvider`（字幕→Whisper fallback）は tier 依存（Whisper は有料）。
 * judgment-engine の純粋ロジック原則を守るため、**どの provider を生成するか**の
 * 決定（tier / 設定 / 字幕有無）は chrome-ext のここに置く。
 *
 * **MVP はこの factory が常に {@link YouTubeCaptionProvider} を返すだけ。**
 * 将来 tier / 設定を見て WhisperProvider / HybridProvider を返す継ぎ目。
 */

import type { Settings } from '../../shared/settings.js';
import type { AudioContextProvider } from '@fresh-chat-keeper/judgment-engine';
import { YouTubeCaptionProvider } from './provider.js';

/**
 * 設定とモードに応じた AudioContextProvider を生成する。
 *
 * MVP は常に YouTubeCaptionProvider（DOM 字幕抽出）。`settings` は将来の tier 判定用に
 * 受けるが MVP では未使用。`mode` は provider の useable しきい値（live 0.5 / archive 0.4）に
 * 渡る。
 *
 * @param settings ユーザー設定（将来 tier / captionContext 判定用、MVP 未使用）
 * @param mode 再生モード（'live' | 'archive'）
 */
export function createAudioContextProvider(
  settings: Settings,
  mode: 'live' | 'archive',
): AudioContextProvider {
  void settings; // MVP 未使用（将来 tier / WhisperProvider 分岐の継ぎ目）
  return new YouTubeCaptionProvider(mode);
}
