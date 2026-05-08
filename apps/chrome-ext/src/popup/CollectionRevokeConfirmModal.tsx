/**
 * Phase 2.5 データ収集 取り消し確認モーダル。
 *
 * **B5 review C-4 で window.confirm から置き換え**:
 * window.confirm は popup の focus を奪い、focus 復帰先が不定で a11y を破壊する。
 * CollectionConsentModal と同じ pattern（useModalA11y）で focus trap + Esc 対応。
 *
 * UX 設計:
 * - 「過去 90 日のデータも削除されます」を明示
 * - Cancel / Confirm の 2 ボタン、初期 focus は **Cancel**（誤操作防止、
 *   破壊的アクションの確認モーダル定石）
 * - submitting 中は Esc / Cancel をブロック（途中中断防止）
 */

import { useRef } from 'react';
import { useModalA11y } from './use-modal-a11y.js';

export interface CollectionRevokeConfirmModalProps {
  open: boolean;
  /** 「削除する」押下時。revoke API 呼び出しは呼び出し側 */
  onConfirm: () => Promise<void> | void;
  /** 「キャンセル」or 閉じる時 */
  onCancel: () => void;
  /** API 呼び出し中の表示制御 */
  submitting?: boolean;
}

export function CollectionRevokeConfirmModal({
  open,
  onConfirm,
  onCancel,
  submitting = false,
}: CollectionRevokeConfirmModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useModalA11y({
    open,
    containerRef,
    onClose: () => {
      if (submitting) return;
      onCancel();
    },
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="fck-revoke-title"
      aria-describedby="fck-revoke-body"
    >
      <div
        ref={containerRef}
        className="bg-white w-[260px] rounded-lg shadow-xl p-4 text-sm"
      >
        <h2 id="fck-revoke-title" className="font-semibold text-gray-800 text-sm">
          データ収集を停止しますか？
        </h2>
        <p id="fck-revoke-body" className="text-xs text-gray-600 mt-2 leading-relaxed">
          過去 90 日に当社サーバーへ送信された判定ログも削除されます。
          ローカルの誤判定報告は削除されません（あなたの記録は残ります）。
        </p>
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 focus:outline-none"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={submitting}
            className="flex-1 py-1.5 text-xs rounded font-medium bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300 focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-1 focus:outline-none"
          >
            {submitting ? '削除中...' : '削除する'}
          </button>
        </div>
      </div>
    </div>
  );
}
