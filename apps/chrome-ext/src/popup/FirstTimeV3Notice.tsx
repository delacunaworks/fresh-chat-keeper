/**
 * v0.4.0 初回アップデート通知バナー（P3-UI-05）。
 *
 * v0.3.x → v0.4.0 で増えた新機能（マルチラベル新カテゴリ + ユーザーブロック）を
 * 初回ポップアップ起動時のみ案内し、「カテゴリ」タブへ導線する。
 *
 * 永続キー: `fck_notice_v3_dismissed`（CLAUDE.md 命名規約
 * `fck_notice_<version>_dismissed` 準拠）。dismiss 後は二度と出ない。
 *
 * a11y: モーダルではなくバナー（role=region + aria-label）。閉じる/カテゴリへ
 * は実 button + focus-visible。新機能は <ul> でマークアップ。
 */

import { useEffect, useState } from 'react';

const NOTICE_DISMISSED_KEY = 'fck_notice_v3_dismissed';

export function FirstTimeV3Notice({
  onGoToCategory,
}: {
  onGoToCategory: () => void;
}) {
  // 'loading' の間は描画しない（一瞬バナーが出てから消えるチラつきを防ぐ）
  const [state, setState] = useState<'loading' | 'show' | 'hidden'>('loading');

  useEffect(() => {
    let active = true;
    chrome.storage.local.get(NOTICE_DISMISSED_KEY, (result) => {
      if (!active) return;
      setState(result[NOTICE_DISMISSED_KEY] === true ? 'hidden' : 'show');
    });
    return () => {
      active = false;
    };
  }, []);

  if (state !== 'show') return null;

  const dismiss = () => {
    void chrome.storage.local.set({ [NOTICE_DISMISSED_KEY]: true });
    setState('hidden');
  };

  const goCategory = () => {
    dismiss();
    onGoToCategory();
  };

  return (
    <div
      role="region"
      aria-label="新機能のお知らせ"
      className="px-4 py-3 bg-emerald-50 border-b border-emerald-200 text-emerald-800"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold">🎉 新機能が追加されました</div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="お知らせを閉じる"
          className="shrink-0 text-emerald-600 hover:text-emerald-800 text-base leading-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus:outline-none rounded"
        >
          ×
        </button>
      </div>
      <ul className="mt-1.5 text-[11px] leading-relaxed list-disc list-inside space-y-0.5">
        <li>暴言・誹謗中傷フィルタ</li>
        <li>スパム・連投フィルタ</li>
        <li>無関係・指示厨フィルタ</li>
        <li>特定ユーザーのブロック機能</li>
      </ul>
      <p className="mt-1.5 text-[11px]">
        新機能は初期状態で OFF です。「カテゴリ」タブから ON にできます。
      </p>
      <button
        type="button"
        onClick={goCategory}
        className="mt-2 text-xs font-medium px-3 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-emerald-500 focus:outline-none"
      >
        カテゴリ設定を見る
      </button>
    </div>
  );
}
