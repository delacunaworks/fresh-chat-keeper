/**
 * 「字幕連動」タブ（Phase 5 / P5-B5、v0.6.0 caption MVP）。
 *
 * 配信者の発話（YouTube 字幕）を Stage 2 の AI 判定文脈に乗せる機能のオプトイン
 * 設定。`captionContext`（enabled / windowSeconds / qualityThreshold）を編集する。
 *
 * content 側（archive.ts の refreshCaptionSnapshot）は既存の chrome.storage
 * onChanged を通じて `currentSettings.captionContext` を都度参照するため、本タブは
 * saveSettings（App.tsx の `onUpdate`）するだけで即時反映される（追加配線不要、
 * P5-B4c）。enabled=false（既定）では recentAudio 非送信 + captionSig='nocap' で
 * v0.5.0 と完全同一挙動。
 *
 * 手本: UserFlagging.tsx（タブ構造 / Toggle / SegmentedControl / Row のローカル定義）。
 */

import { type KeyboardEvent } from 'react';
import {
  type Settings,
  type CaptionContextSettings,
  type CaptionWindowSeconds,
  type CaptionQualityThreshold,
} from '../../shared/settings.js';

interface CaptionContextProps {
  settings: Settings;
  onUpdate: (partial: Partial<Settings>) => void;
}

// ─── 純粋ヘルパー（テスト対象） ─────────────────────────────────────

/** コンテキスト窓の選択肢（秒）。60 秒を推奨既定とする。 */
export const WINDOW_OPTIONS: { value: string; label: string }[] = [
  { value: '30', label: '30秒' },
  { value: '60', label: '60秒（推奨）' },
  { value: '120', label: '120秒' },
];

/** 品質しきい値の選択肢（loose/standard/strict）。厳格ほど低品質字幕を弾く。 */
export const QUALITY_OPTIONS: { value: CaptionQualityThreshold; label: string }[] = [
  { value: 'loose', label: '緩め' },
  { value: 'standard', label: '標準' },
  { value: 'strict', label: '厳格' },
];

/**
 * 現在の captionContext に partial をマージし、saveSettings 用の `Partial<Settings>`
 * を作る（純粋）。本タブの全更新ハンドラがこれを通すため、ここを 1 箇所テストすれば
 * 「選択 → 正しい captionContext が onUpdate に渡る」ことを担保できる。
 */
export function mergeCaption(
  current: CaptionContextSettings,
  partial: Partial<CaptionContextSettings>,
): Partial<Settings> {
  return { captionContext: { ...current, ...partial } };
}

/** SegmentedControl の文字列値を CaptionWindowSeconds（30|60|120）に narrowing。 */
export function parseWindowSeconds(value: string): CaptionWindowSeconds {
  const n = Number(value);
  return n === 30 || n === 120 ? n : 60;
}

// ─── 小コンポーネント（UserFlagging.tsx と同様にローカル定義） ──────────

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

function SegmentedControl({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
}) {
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = options.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = idx >= last ? 0 : idx + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = idx <= 0 ? last : idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    onChange(options[next].value);
    const btns = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    btns[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="flex rounded-md border border-gray-200 overflow-hidden text-xs"
    >
      {options.map((opt, i) => {
        const checked = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(opt.value)}
            className={`flex-1 py-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 focus:outline-none ${
              i > 0 ? 'border-l border-gray-200' : ''
            } ${
              checked
                ? 'bg-indigo-600 text-white font-medium'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-gray-100">
      <div className="text-xs font-medium text-gray-500 mb-1.5">{label}</div>
      {children}
    </div>
  );
}

// ─── メイン ─────────────────────────────────────────────────────────

export function CaptionContext({ settings, onUpdate }: CaptionContextProps) {
  const caption = settings.captionContext;
  const updateCaption = (partial: Partial<CaptionContextSettings>) => {
    onUpdate(mergeCaption(caption, partial));
  };

  return (
    <div>
      {!caption.enabled && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 text-[11px] text-amber-700 leading-snug">
          💡 字幕連動は初期状態では OFF です。
        </div>
      )}

      {/* 有効化トグル（オプトイン） */}
      <Row label="字幕連動">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-gray-600 leading-snug">
            配信者の発話（字幕）を AI 判定の文脈に使い、ネタバレ判定の精度を上げます。
            <br />
            既定 OFF のオプトイン機能です。
          </div>
          <Toggle
            checked={caption.enabled}
            onChange={(v) => updateCaption({ enabled: v })}
            label="字幕連動を有効化"
          />
        </div>
      </Row>

      {/* 窓長・しきい値（OFF 時は薄く・操作不可にする） */}
      <div className={caption.enabled ? '' : 'opacity-40 pointer-events-none'}>
        <Row label="コンテキスト窓（直近何秒の発話を使うか）">
          <SegmentedControl
            options={WINDOW_OPTIONS}
            value={String(caption.windowSeconds)}
            onChange={(v) => updateCaption({ windowSeconds: parseWindowSeconds(v) })}
            ariaLabel="コンテキスト窓"
          />
        </Row>

        <Row label="品質しきい値（厳格ほど低品質な字幕を無視）">
          <SegmentedControl
            options={QUALITY_OPTIONS}
            value={caption.qualityThreshold}
            onChange={(v) => updateCaption({ qualityThreshold: v as CaptionQualityThreshold })}
            ariaLabel="品質しきい値"
          />
        </Row>
      </div>

      {/* 静的ガイダンス */}
      <Row label="この機能について">
        <ul className="text-[11px] text-gray-500 leading-snug list-disc pl-4 space-y-1">
          <li>YouTube の字幕（CC）が表示されている配信で動作します。</li>
          <li>
            字幕はブラウザ内で取得します。Claude へ送信するのは、判定時のコメントと同様、
            判定リクエストに含まれる直近の発話テキストのみです。
          </li>
          <li>月間のフィルタ判定の利用量がわずかに増える場合があります。</li>
        </ul>
      </Row>
    </div>
  );
}

export const __test__ = {
  WINDOW_OPTIONS,
  QUALITY_OPTIONS,
};
