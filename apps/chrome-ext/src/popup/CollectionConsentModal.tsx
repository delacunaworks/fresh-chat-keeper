/**
 * Phase 2.5 データ収集 opt-in 同意モーダル。
 *
 * 設計 ground truth: dev-docs/phase-2-5-data-collection.md §6.2
 *
 * **プライバシー UX 必達条件**:
 * - 「設定でスイッチを ON にした瞬間」にのみ表示（最初から表示しない）
 * - 必須チェックボックスを ON にしないと「同意して有効化」が押せない
 * - 「同意しない」or 閉じるで設定スイッチを OFF に戻す（呼び出し側に通知）
 * - 何が送られて何が送られないかを明示
 *
 * 本コンポーネントは UI のみを担当する。実際の API 通信
 * （POST /v1/consent）と chrome.storage への保存は呼び出し側 (App.tsx) で行う。
 */

import { useState } from 'react';

/** 同意ポリシーの現行バージョン。apps/api 側 consent_versions と一致させる */
export const CURRENT_CONSENT_VERSION = '2026-05-01';

/** プライバシーポリシー全文 URL（DEPLOY-01 で確定したリンクに差し替え予定） */
export const PRIVACY_POLICY_URL =
  'https://github.com/delacunaworks/fresh-chat-keeper/blob/main/docs/privacy-policy.md';

export interface CollectionConsentModalProps {
  /** モーダル表示制御（true で表示） */
  open: boolean;
  /** 「同意して有効化」押下時。consentVersion を引数に呼ぶ */
  onConsent: (consentVersion: string) => Promise<void> | void;
  /** 「同意しない」or 閉じる時。呼び出し側で設定スイッチを OFF に戻す */
  onCancel: () => void;
  /** API 呼び出し中（onConsent が pending）の表示制御 */
  submitting?: boolean;
  /** API エラー時に表示するメッセージ（呼び出し側で文言を組み立てる） */
  errorMessage?: string | null;
}

export function CollectionConsentModal({
  open,
  onConsent,
  onCancel,
  submitting = false,
  errorMessage = null,
}: CollectionConsentModalProps) {
  const [agreed, setAgreed] = useState(false);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fck-consent-title"
    >
      <div className="bg-white w-[280px] max-h-[480px] rounded-lg shadow-xl flex flex-col text-sm">
        {/* ヘッダー */}
        <div className="px-4 py-3 border-b border-gray-100">
          <div id="fck-consent-title" className="font-semibold text-gray-800">
            ネタバレ判定の改善にご協力ください
          </div>
          <p className="text-xs text-gray-500 mt-1 leading-relaxed">
            あなたが視聴中の判定ログを匿名化して当サービスに送信し、フィルタ精度の向上に活用します。
          </p>
        </div>

        {/* 本体（スクロール可） */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <section>
            <div className="text-xs font-medium text-gray-700 mb-1">送信される内容</div>
            <ul className="text-xs text-gray-600 space-y-1">
              <li className="flex gap-2">
                <span className="text-emerald-500">✓</span>
                <span>視聴中の動画 ID と配信者チャンネル ID（YouTube 公開情報）</span>
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-500">✓</span>
                <span>チャットコメント本文</span>
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-500">✓</span>
                <span>
                  コメント投稿者の YouTube チャンネル ID
                  <br />
                  <span className="text-gray-500">
                    （SHA-1 ハッシュ化、当社サーバーで即時匿名化）
                  </span>
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-500">✓</span>
                <span>判定結果（spoiler/safe）と AI の信頼度</span>
              </li>
            </ul>
          </section>

          <section>
            <div className="text-xs font-medium text-gray-700 mb-1">送信されない内容</div>
            <ul className="text-xs text-gray-600 space-y-1">
              <li className="flex gap-2">
                <span className="text-rose-500">✗</span>
                <span>あなたの YouTube アカウント情報</span>
              </li>
              <li className="flex gap-2">
                <span className="text-rose-500">✗</span>
                <span>あなたが投稿したコメントや反応</span>
              </li>
            </ul>
          </section>

          <section className="text-xs text-gray-500">
            <a
              href={PRIVACY_POLICY_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-indigo-600 underline"
            >
              プライバシーポリシー全文を読む
            </a>
          </section>

          {errorMessage && (
            <div
              role="alert"
              className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1.5"
            >
              {errorMessage}
            </div>
          )}
        </div>

        {/* チェックボックス + ボタン */}
        <div className="border-t border-gray-100 px-4 py-3 space-y-2">
          <label className="flex items-start gap-2 text-xs text-gray-700">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5"
              aria-label="データ収集に同意"
              disabled={submitting}
            />
            <span>上記内容を理解し、データ収集に同意します</span>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setAgreed(false);
                onCancel();
              }}
              className="flex-1 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-50"
              disabled={submitting}
            >
              同意しない
            </button>
            <button
              type="button"
              onClick={() => void onConsent(CURRENT_CONSENT_VERSION)}
              disabled={!agreed || submitting}
              className={`flex-1 py-1.5 text-xs rounded font-medium transition-colors ${
                agreed && !submitting
                  ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
            >
              {submitting ? '送信中...' : '同意して有効化'}
            </button>
          </div>
          <p className="text-[10px] text-gray-400 leading-snug">
            いつでも設定からオフにできます。オフにすると過去 90 日の収集ログも削除されます。
          </p>
        </div>
      </div>
    </div>
  );
}
