/**
 * 「音声文脈（実験的）」タブ（Phase 7 / AR-3、v0.7.0）。
 *
 * 「字幕連動」タブ（P5-B5）を置換。運営が用意したアーカイブ文字起こし（transcript）を
 * 使い、視聴者の再生位置までの配信内容を Stage 2 判定文脈に反映する機能のオプトイン設定。
 * `audioContext { enabled }` の ON/OFF のみを編集する。
 *
 * content 側（archive.ts の refreshAudioSnapshot）は既存の chrome.storage onChanged で
 * `currentSettings.audioContext.enabled` を都度参照するため、本タブは saveSettings
 * （App.tsx の `onUpdate`）するだけで即時反映される。enabled=false（既定）では
 * currentTimeSeconds 非送信 + sig='nocap' で v0.6.0 と完全同一挙動。
 *
 * 手本: CaptionContext.tsx（Toggle / Row のローカル定義）。
 */

import { type Settings, type AudioContextSettings } from '../../shared/settings.js';

interface AudioContextProps {
  settings: Settings;
  onUpdate: (partial: Partial<Settings>) => void;
}

// ─── 純粋ヘルパー（テスト対象） ─────────────────────────────────────

/**
 * 現在の audioContext に partial をマージし、saveSettings 用の `Partial<Settings>`
 * を作る（純粋）。本タブの更新ハンドラがこれを通すため、ここをテストすれば
 * 「トグル → 正しい audioContext が onUpdate に渡る」ことを担保できる。
 */
export function mergeAudio(
  current: AudioContextSettings,
  partial: Partial<AudioContextSettings>,
): Partial<Settings> {
  return { audioContext: { ...current, ...partial } };
}

// ─── 小コンポーネント ───────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-checked={checked}
      role="switch"
      aria-label={label}
      className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-indigo-500 focus:outline-none ${
        checked ? 'bg-indigo-600' : 'bg-gray-300'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

// ─── メイン ─────────────────────────────────────────────────────────

export function AudioContext({ settings, onUpdate }: AudioContextProps) {
  const audio = settings.audioContext;
  const setEnabled = (enabled: boolean): void => {
    onUpdate(mergeAudio(audio, { enabled }));
  };

  return (
    <div className="text-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div className="pr-3">
          <div className="font-medium text-gray-800">音声文脈（実験的）</div>
          <div className="text-xs text-gray-500 mt-0.5">
            運営が文字起こしを用意した動画で、配信の文脈を判定に反映します。
            再生位置より先の内容は参照されません。
          </div>
        </div>
        <Toggle checked={audio.enabled} onChange={setEnabled} label="音声文脈を有効にする" />
      </div>
    </div>
  );
}
