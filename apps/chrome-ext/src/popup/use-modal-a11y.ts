/**
 * モーダル UI 用の a11y ユーティリティ hook。
 *
 * 役割（WCAG 対応）:
 * - 2.1.2 No Keyboard Trap: Tab/Shift+Tab で modal 内の focusable を循環
 * - 2.4.3 Focus Order: open 時に最初の focusable へ初期 focus
 * - 2.4.11 Focus Not Obscured: open 時の background scroll を抑止しない
 *   （popup 自体が固定サイズなので追加対応不要）
 * - 2.1.1 Keyboard: Esc で onClose
 * - 復帰 focus: close 時に open 前の activeElement へ戻す
 *
 * 設計判断: focus-trap-react などの依存追加は避け、自前 100 行未満で実装。
 * popup 内の単純な構造（1 ダイアログのみ）に限定するため十分。
 */

import { useEffect, useRef, type RefObject } from 'react';

/** focusable と判定するセレクタ。キーボード操作可能な要素を網羅。 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface UseModalA11yOptions {
  /** モーダルが開いているか */
  open: boolean;
  /** モーダルのコンテナ要素（focusable の検索範囲） */
  containerRef: RefObject<HTMLElement>;
  /** Esc / 背景クリックではなく、明示的に「閉じる」と解釈すべきイベント */
  onClose: () => void;
}

/**
 * モーダルに focus trap + Esc handler + return focus を注入する。
 *
 * 呼び出し側はモーダルの外側コンテナに ref を割り当て、open 状態と onClose を
 * 渡すだけでよい。内部要素の構造には踏み込まないため再利用可能。
 */
export function useModalA11y({ open, containerRef, onClose }: UseModalA11yOptions): void {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // 初期 focus + 復帰 focus
  useEffect(() => {
    if (!open) return;

    // open 直前の activeElement を保存（モーダル close 時に復帰）
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // 次のフレームで最初の focusable へ focus（DOM 描画完了を待つ）
    const raf = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const first = getFirstFocusable(container);
      if (first) first.focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      // close 時に open 前の要素へ復帰。要素が DOM から消えていたら no-op。
      const prev = previouslyFocused.current;
      if (prev && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [open, containerRef]);

  // Tab 循環 + Esc handler
  useEffect(() => {
    if (!open) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;

      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(isVisible);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        // Shift+Tab: first → last へ循環
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab: last → first へ循環
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, containerRef, onClose]);
}

function getFirstFocusable(container: HTMLElement): HTMLElement | null {
  const list = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return list.find(isVisible) ?? null;
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  // display:none / visibility:hidden
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return true;
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = { FOCUSABLE_SELECTOR, getFirstFocusable, isVisible };
