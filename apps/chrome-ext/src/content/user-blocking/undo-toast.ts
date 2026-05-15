/**
 * ブロック取り消しトースト（P3-UI-03）。
 *
 * 設計: `dev-docs/phase-3-multilabel.md`「Undoトーストの実装」。
 * - ブロック直後に右下に表示「<名前> をブロックしました [取り消し]」
 * - 3 秒で自動消滅
 * - [取り消し] で {@link unblockUser} を呼びフェードアウト
 * - 同時に 1 つだけ（新規表示時は既存トーストを即破棄）
 *
 * a11y: `role="status"` + `aria-live="polite"` で SR に通知。取り消しは
 * 実 `<button>`（キーボード操作可・aria-label 付き）。
 *
 * スタイルは manifest content CSS を持たない方針に合わせ JS から `<style>`
 * を 1 回注入（hover-manager と同系統）。
 */

import { unblockUser } from './blocking.js';

const STYLE_ELEMENT_ID = 'fck-undo-toast-styles';
const AUTO_DISMISS_MS = 3000;
const FADE_OUT_MS = 200;

const STYLE_TEXT = `
.fck-undo-toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background: rgba(0, 0, 0, 0.92);
  color: #fff;
  padding: 12px 20px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 12px;
  z-index: 2147483647;
  font-family: "YouTube Sans", Roboto, Arial, sans-serif;
  font-size: 14px;
  animation: fck-toast-in 0.2s ease-out;
}
.fck-undo-toast.fck-toast-leaving { animation: fck-toast-out ${FADE_OUT_MS}ms ease-in forwards; }
.fck-undo-toast button {
  background: #3b82f6;
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.fck-undo-toast button:hover { background: #2563eb; }
.fck-undo-toast button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 1px;
}
@keyframes fck-toast-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes fck-toast-out {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(10px); }
}
`;

function ensureStylesInjected(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = STYLE_TEXT;
  (document.head ?? document.documentElement).appendChild(style);
}

let currentToast: HTMLElement | null = null;
let currentTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimer(): void {
  if (currentTimer !== null) {
    clearTimeout(currentTimer);
    currentTimer = null;
  }
}

function dismiss(toast: HTMLElement): void {
  toast.classList.add('fck-toast-leaving');
  setTimeout(() => {
    toast.remove();
    if (currentToast === toast) {
      currentToast = null;
      clearTimer();
    }
  }, FADE_OUT_MS);
}

/**
 * ブロック取り消しトーストを表示する。
 *
 * @param displayName ブロックした表示名（textContent 経由で安全に挿入）
 * @param channelId 取り消し対象の識別子
 */
export function showBlockUndoToast(displayName: string, channelId: string): void {
  ensureStylesInjected();

  // 既存トーストは即破棄（同時 1 つ）
  if (currentToast) {
    currentToast.remove();
    clearTimer();
    currentToast = null;
  }

  const toast = document.createElement('div');
  toast.className = 'fck-undo-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const label = document.createElement('span');
  // textContent でユーザー由来文字列を安全に挿入（XSS 防止）
  label.textContent = `${displayName || 'このユーザー'} をブロックしました`;

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.textContent = '取り消し';
  undoBtn.setAttribute(
    'aria-label',
    `${displayName || 'このユーザー'} のブロックを取り消す`,
  );
  undoBtn.addEventListener('click', () => {
    void unblockUser(channelId);
    dismiss(toast);
  });

  toast.appendChild(label);
  toast.appendChild(undoBtn);
  document.body.appendChild(toast);

  currentToast = toast;
  currentTimer = setTimeout(() => dismiss(toast), AUTO_DISMISS_MS);
}
