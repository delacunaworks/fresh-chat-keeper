/**
 * v0.5.0 初回案内バナー（Phase 3.5 / B9）。
 *
 * 視聴者フラグ機能（Phase 3.5）の存在を初回ポップアップ起動時のみ案内し、
 * 「フラグ視聴者」タブへ導線する。`FirstTimeV3Notice`（v0.4.0 通知）の構造を
 * 踏襲。
 *
 * 永続キー: `fck_notice_v5_dismissed`（CLAUDE.md 命名規約
 * `fck_notice_<version>_dismissed` 準拠、改訂6）。dismiss 後は二度と出ない。
 *
 * 表示条件（B8 G-3 採用）: 「v5 通知 dismissed でない」のみ。
 * `userFlagging.enabled` 状態には依存しない（バナーは「機能の存在を知らせる」
 * 役割に限定）。バナーは **enabled を変更せず**、タブへ誘導するのみ
 * （オプトインの最終判断はタブ内で行う方が UX が一貫、B8 G-2/G-3）。
 *
 * a11y: モーダルではなくバナー（role=region + aria-label）。閉じる/タブへは
 * 実 button + focus-visible。
 */

import { useEffect, useState } from 'react';

export const NOTICE_DISMISSED_KEY = 'fck_notice_v5_dismissed';

/**
 * 保存値からバナーを表示すべきかを判定する純関数。
 * `true`（dismiss 済み）以外（未設定 / false / null 等）は表示する。
 */
export function shouldShowNotice(stored: unknown): boolean {
  return stored !== true;
}

/**
 * dismiss / goFlagging アクションを組み立てる純関数（テスト容易化のため切り出し）。
 *
 * - dismiss: `fck_notice_v5_dismissed` を true 保存 + バナー非表示
 * - goFlagging: dismiss してから `onGoToFlagging`（タブ切替）を呼ぶ。
 *   **enabled は変更しない**（タブ誘導のみ）
 */
export function buildNoticeActions(
  setHidden: () => void,
  onGoToFlagging: () => void,
): { dismiss: () => void; goFlagging: () => void } {
  const dismiss = () => {
    void chrome.storage.local.set({ [NOTICE_DISMISSED_KEY]: true });
    setHidden();
  };
  const goFlagging = () => {
    dismiss();
    onGoToFlagging();
  };
  return { dismiss, goFlagging };
}

/**
 * バナーの見た目（プレゼンテーション専用、storage 非依存）。
 * 表示判定は親の {@link FlaggingIntroduction} が行い、show のときだけ描画する。
 * renderToStaticMarkup でテスト可能にするため分離。
 */
export function FlaggingIntroductionBanner({
  onGoToFlagging,
  onDismiss,
}: {
  onGoToFlagging: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="新機能のお知らせ"
      className="px-4 py-3 bg-emerald-50 border-b border-emerald-200 text-emerald-800"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold">🎉 新機能: 視聴者フラグ</div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="お知らせを閉じる"
          className="shrink-0 text-emerald-600 hover:text-emerald-800 text-base leading-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus:outline-none rounded"
        >
          ×
        </button>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed">
        繰り返しフィルタに引っかかる視聴者を 🟡🔴 で可視化して、ブロック判断を支援します。
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed">
        初期状態は OFF です。統計はすべてブラウザ内に保存し、外部送信はありません。
      </p>
      <button
        type="button"
        onClick={onGoToFlagging}
        className="mt-2 text-xs font-medium px-3 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-emerald-500 focus:outline-none"
      >
        フラグ視聴者タブを見る
      </button>
    </div>
  );
}

export function FlaggingIntroduction({
  onGoToFlagging,
}: {
  onGoToFlagging: () => void;
}) {
  // 'loading' の間は描画しない（一瞬バナーが出てから消えるチラつきを防ぐ）
  const [state, setState] = useState<'loading' | 'show' | 'hidden'>('loading');

  useEffect(() => {
    let active = true;
    chrome.storage.local.get(NOTICE_DISMISSED_KEY, (result) => {
      if (!active) return;
      setState(shouldShowNotice(result[NOTICE_DISMISSED_KEY]) ? 'show' : 'hidden');
    });
    return () => {
      active = false;
    };
  }, []);

  if (state !== 'show') return null;

  const { dismiss, goFlagging } = buildNoticeActions(
    () => setState('hidden'),
    onGoToFlagging,
  );

  return <FlaggingIntroductionBanner onGoToFlagging={goFlagging} onDismiss={dismiss} />;
}
