/**
 * ブロック取り消しトースト（P3-UI-03）。
 *
 * 設計: `dev-docs/phase-3-multilabel.md`「Undoトーストの実装」。
 * - ブロック直後に右下に表示「<名前> をブロックしました [取り消し]」
 * - 3 秒で自動消滅
 * - [取り消し] で {@link unblockUser} を呼びフェードアウト
 * - 同時に 1 つだけ（新規表示時は既存トーストを即破棄）
 *
 * a11y（Hover-Safe a11y 原則 A-3、architecture.md §2.1.4.1）:
 * - `role="status"` + `aria-live="polite"`。空要素を先に挿入し次フレームで
 *   テキスト投入（読み上げを確実化）
 * - hover / 内部フォーカス中は自動消滅タイマーを一時停止、離脱で再開
 * - `prefers-reduced-motion: reduce` 時はフェードアニメーションを無効化
 * - 取り消しは実 `<button>`（キーボード操作可・aria-label・focus-visible）
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
@media (prefers-reduced-motion: reduce) {
  .fck-undo-toast { animation: none; }
  .fck-undo-toast.fck-toast-leaving { animation: none; }
}
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

/** A-3: 自動消滅タイマーを（再）開始する。hover/focus 離脱時にも呼ぶ。 */
function startAutoDismiss(toast: HTMLElement): void {
  clearTimer();
  currentTimer = setTimeout(() => dismiss(toast), AUTO_DISMISS_MS);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function dismiss(toast: HTMLElement): void {
  if (prefersReducedMotion()) {
    // アニメーション無効: 即座に除去
    toast.remove();
    if (currentToast === toast) {
      currentToast = null;
      clearTimer();
    }
    return;
  }
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

  const safeName = displayName || 'このユーザー';

  const toast = document.createElement('div');
  toast.className = 'fck-undo-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  // A-3: ライブリージョンは空のまま先に挿入し、次フレームで本文を入れる。
  // 生成と同時にテキストが入っていると SR が変化を検知できないことがある。
  const label = document.createElement('span');
  toast.appendChild(label);

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.textContent = '取り消し';
  undoBtn.setAttribute('aria-label', `${safeName} のブロックを取り消す`);
  undoBtn.addEventListener('click', () => {
    void unblockUser(channelId);
    dismiss(toast);
  });
  toast.appendChild(undoBtn);

  // A-3: hover / 内部フォーカス中は消滅タイマーを一時停止、離脱で再開
  toast.addEventListener('mouseenter', clearTimer);
  toast.addEventListener('mouseleave', () => startAutoDismiss(toast));
  toast.addEventListener('focusin', clearTimer);
  toast.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget;
    if (next instanceof Node && toast.contains(next)) return;
    startAutoDismiss(toast);
  });

  document.body.appendChild(toast);
  currentToast = toast;

  // 次フレームで本文投入（textContent でユーザー由来文字列を安全に挿入）
  requestAnimationFrame(() => {
    label.textContent = `${safeName} をブロックしました`;
  });

  startAutoDismiss(toast);
}

/**
 * 失敗トースト（B4a hardening C）。ブロック永続化に失敗した際に表示する。
 * Undo ボタンは持たない（ブロック自体が成立していないため）。a11y は
 * showBlockUndoToast と同方針（role=status / 遅延ライブリージョン /
 * hover-focus pause / reduced-motion）。
 *
 * @param message 表示メッセージ（例: 「ブロックを保存できませんでした」）
 */
export function showBlockErrorToast(message: string): void {
  ensureStylesInjected();

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
  toast.appendChild(label);

  toast.addEventListener('mouseenter', clearTimer);
  toast.addEventListener('mouseleave', () => startAutoDismiss(toast));
  toast.addEventListener('focusin', clearTimer);
  toast.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget;
    if (next instanceof Node && toast.contains(next)) return;
    startAutoDismiss(toast);
  });

  document.body.appendChild(toast);
  currentToast = toast;

  requestAnimationFrame(() => {
    label.textContent = message;
  });

  startAutoDismiss(toast);
}
