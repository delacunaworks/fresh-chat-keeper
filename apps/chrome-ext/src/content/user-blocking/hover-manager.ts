/**
 * ユーザーブロック用アクションバーの表示管理（Hover-Safe Pattern）。
 *
 * 設計原典: `dev-docs/architecture.md` §2.1.4「Hover-Safe Interaction」の5原則
 *   1. ホバー要素とポップアップを独立配置（body 直下絶対配置）
 *   2. マウスがポップアップ上にある間は表示継続
 *   3. 短い閉じ遅延（300ms）でマウスのブレを吸収
 *   4. DOM 削除耐性（元コメントが流れて消えてもバー維持・操作継続）
 *   5. 明示的な閉じる手段（×ボタン / ESC / 他コメントへの移動）
 *
 * 状態遷移は `dev-docs/phase-3-multilabel.md`「アクションバーの詳細挙動」表に準拠。
 *
 * スコープ（P3-UI-01）: 表示ライフサイクル管理のみ。ブロック処理本体は
 * P3-UI-02（blocking.ts）、Undo トーストは P3-UI-03（undo-toast.ts）が
 * コールバックとして注入する。
 *
 * CSS は manifest に content CSS を持たない既存方針に合わせ、JS から
 * `<style>` を 1 回だけ注入する（chat-dom.ts の inline style 方針と同系統）。
 */

// A-3 補強（B4b）: 単一リージョン使い回しをやめ、キュー化 polite/assertive の
// 共有モジュールへ委譲（流去告知 + ブロック完了 + 報告完了が近接発火しても
// 取りこぼさない）。誤判定報告フォームは report-form.ts に分離。
import { announce } from './live-region.js';
import {
  buildReportForm,
  buildPreviewText,
  type ReportKind,
  type ReportedLabel,
} from './report-form.js';

/** アクションバーの操作対象（1 コメント分のメタ情報） */
export interface ActionBarTarget {
  /** コメント要素。流れて消えると null 化されるが、以下のメタは保持される */
  messageEl: HTMLElement | null;
  /** 投稿者の識別子（2026-05 仕様では @ハンドル名。空文字なら不明） */
  authorChannelId: string;
  /** ブロック時点の表示名 */
  authorDisplayName: string;
  /** メッセージ要素の一意キー（同一コメント再ホバー判定用） */
  messageKey: string;
  /**
   * コメント本文（P3-UI-06 プレビュー用）。流れて消えても保持されるよう
   * attach 時にスナップショットする。
   */
  text: string;
}

/** UI-02 / UI-03 / P3-UI-06 が注入するアクションハンドラ */
export interface ActionBarCallbacks {
  /** 🚫 ブロック（UI-02 が blockUser を注入）。channelId 空なら未注入扱いで非表示 */
  onBlock: (channelId: string, displayName: string) => void | Promise<void>;
  /**
   * ⚠️ 誤判定報告（P3-UI-06）。フォームで選ばれた reportedLabel を渡す
   * （スキップ時 undefined）。reportKind は archive 側が表示状態から自動判定。
   * 未注入ならボタン非表示。
   */
  onReport?: (target: ActionBarTarget, reportedLabel: ReportedLabel | undefined) => void;
  /**
   * 報告フォームの文言用に FP/FN を解決する（フィルタ済み→FP / 表示中→FN）。
   * 未注入時は 'false_negative' 既定。
   */
  getReportKind?: (target: ActionBarTarget) => ReportKind;
  /** 📊 統計（任意、Phase 3.5 で本実装。未注入ならボタン非表示） */
  onStats?: (channelId: string, displayName: string) => void;
}

const HIDE_DELAY_MS = 300;
const BAR_WIDTH_EST = 160;
const BAR_HEIGHT_EST = 32;
const STYLE_ELEMENT_ID = 'fck-action-bar-styles';

const STYLE_TEXT = `
.fck-action-bar {
  position: fixed;
  display: flex;
  gap: 4px;
  background: rgba(15, 15, 15, 0.96);
  padding: 4px;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  z-index: 2147483646;
  font-family: "YouTube Sans", Roboto, Arial, sans-serif;
}
.fck-action-bar button {
  background: transparent;
  border: none;
  color: #fff;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background 0.15s;
  min-width: 28px;
  min-height: 28px;
}
.fck-action-bar button:hover { background: rgba(255, 255, 255, 0.2); }
.fck-action-bar button:focus-visible {
  outline: 2px solid #3b82f6;
  outline-offset: 1px;
}
.fck-action-bar .fck-action-close { opacity: 0.6; font-size: 16px; }
.fck-action-bar .fck-action-close:hover,
.fck-action-bar .fck-action-close:focus-visible { opacity: 1; }
`;

function ensureStylesInjected(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = STYLE_TEXT;
  (document.head ?? document.documentElement).appendChild(style);
}


/** 矩形（getBoundingClientRect の最小サブセット）。テスト用に純粋化。 */
export interface RectLike {
  left: number;
  right: number;
  top: number;
  height: number;
}

/**
 * アクションバーの fixed 配置座標を算出する純粋関数。
 *
 * - 既定はコメント右隣（rect.right + 8）の垂直中央
 * - 右にはみ出すなら左側へ回し、左端も画面外なら 8px でクリップ
 * - 上下も 8px マージンでビューポート内にクリップ
 *
 * DOM 非依存なので単体テスト可能（hover-manager の唯一の非自明な純ロジック）。
 */
export function computeActionBarPosition(
  rect: RectLike,
  viewportWidth: number,
  viewportHeight: number,
  barWidth = BAR_WIDTH_EST,
  barHeight = BAR_HEIGHT_EST,
): { left: number; top: number } {
  let left = rect.right + 8;
  if (left + barWidth > viewportWidth) {
    left = Math.max(8, rect.left - barWidth - 8);
  }
  let top = rect.top + rect.height / 2 - barHeight / 2;
  top = Math.max(8, Math.min(top, viewportHeight - barHeight - 8));
  return { left, top };
}

interface HoverState {
  target: ActionBarTarget;
  actionBar: HTMLElement;
  hideTimer: ReturnType<typeof setTimeout> | null;
  /** A-2: 表示のトリガになった要素。閉じる際にフォーカスを戻す。 */
  triggerEl: HTMLElement | null;
}

/**
 * アクションバーの単一インスタンス管理クラス。タブ内シングルトン
 * （{@link actionBarManager}）として使う。
 */
export class ActionBarManager {
  private current: HoverState | null = null;
  private callbacks: ActionBarCallbacks | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private outsideTapHandler: ((e: Event) => void) | null = null;

  /** UI-02/03 のアクションを注入し、グローバル ESC ハンドラを有効化する。 */
  init(callbacks: ActionBarCallbacks): void {
    this.callbacks = callbacks;
    ensureStylesInjected();
    if (!this.keydownHandler) {
      this.keydownHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') this.hideNow();
      };
      // capture=true: YouTube のキーボードショートカットに先んじて ESC を拾う
      document.addEventListener('keydown', this.keydownHandler, true);
    }

    // A-5: タッチデバイスはバー外タップで閉じる（mouse はホバー機構で閉じるので対象外）
    const isTouch =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none)').matches;
    if (isTouch && !this.outsideTapHandler) {
      this.outsideTapHandler = (e: Event) => {
        if (!this.current) return;
        const t = e.target;
        if (!(t instanceof Node)) return;
        const bar = this.current.actionBar;
        const msg = this.current.target.messageEl;
        if (bar.contains(t) || (msg && msg.contains(t))) return;
        this.hideNow();
      };
      document.addEventListener('touchstart', this.outsideTapHandler, true);
    }
  }

  /** コメント要素にホバー/フォーカスリスナーをアタッチする。 */
  attachToMessage(messageEl: HTMLElement, target: Omit<ActionBarTarget, 'messageEl'>): void {
    // A-1: キーボード到達性。Tab でコメント行に到達できるよう tabindex 付与。
    if (!messageEl.hasAttribute('tabindex')) {
      messageEl.setAttribute('tabindex', '0');
    }

    // タッチデバイス（hover 不可）: タップで開く / 別所タップで閉じる（A-5）
    const isTouch =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none)').matches;

    if (isTouch) {
      messageEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showActionBar(messageEl, target, false);
      });
      // A-1: タッチ環境でもキーボード（外付け等）に配慮し focusin も拾う
      messageEl.addEventListener('focusin', () =>
        this.showActionBar(messageEl, target, true),
      );
      return;
    }

    messageEl.addEventListener('mouseenter', () =>
      // 🟡(B4b): マウス起点では first-focus しない（連続ホバーでページの
      // フォーカス/スクロールを奪わない）
      this.showActionBar(messageEl, target, false),
    );
    messageEl.addEventListener('mouseleave', () => this.scheduleHide());
    // A-1: キーボードフォーカスでも開く（こちらは first-focus する）
    messageEl.addEventListener('focusin', () =>
      this.showActionBar(messageEl, target, true),
    );
    // A-1: フォーカスがコメント行からもバーからも外れたら閉じる（Tab 離脱）
    messageEl.addEventListener('focusout', (e) =>
      this.handleFocusOut(e as FocusEvent),
    );
  }

  showActionBar(
    messageEl: HTMLElement,
    target: Omit<ActionBarTarget, 'messageEl'>,
    viaKeyboard: boolean,
  ): void {
    if (!this.callbacks) return;

    // 同一コメントで表示中ならタイマーキャンセルのみ
    if (this.current && this.current.target.messageKey === target.messageKey) {
      this.cancelHide();
      return;
    }
    // 別コメントで表示中なら閉じてから出し直す
    if (this.current) this.hideNow();

    const fullTarget: ActionBarTarget = { ...target, messageEl };
    const actionBar = this.createActionBar(fullTarget);
    document.body.appendChild(actionBar);
    // A-6: 実 DOM サイズ確定後に配置（縦長 UI 対応）
    this.repositionFor(actionBar, messageEl);

    actionBar.addEventListener('mouseenter', () => this.cancelHide());
    actionBar.addEventListener('mouseleave', () => this.scheduleHide());
    // A-1: バーから Tab で外へ出たら閉じる
    actionBar.addEventListener('focusout', (e) =>
      this.handleFocusOut(e as FocusEvent),
    );
    // A-1: ←/→ で roving tabindex（デフォルトツールバーのみ。報告フォームの
    // radiogroup 等は report-form.ts が独自にハンドルする）
    actionBar.addEventListener('keydown', (e) => this.handleToolbarKeydown(e));

    this.current = {
      target: fullTarget,
      actionBar,
      hideTimer: null,
      // A-2: フォーカス復帰先。キーボード起点なら activeElement、それ以外は
      // コメント行（tabindex=0 付与済みなので戻せる）。
      triggerEl:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : messageEl,
    };

    // 🟡(B4b) / A-1: first-focus は **キーボード起点のみ**。マウスホバー起点で
    // フォーカスを奪うと、ライブチャット連続ホバーでページのフォーカス/
    // スクロールが飛ぶ。
    if (viaKeyboard) {
      const firstBtn = actionBar.querySelector<HTMLButtonElement>('button');
      firstBtn?.focus();
    }
  }

  /** 実 DOM サイズを測ってビューポート内に配置し直す（A-6 可変サイズ）。 */
  private repositionFor(actionBar: HTMLElement, messageEl: HTMLElement): void {
    const msgRect = messageEl.getBoundingClientRect();
    const barRect = actionBar.getBoundingClientRect();
    const { left, top } = computeActionBarPosition(
      msgRect,
      window.innerWidth,
      window.innerHeight,
      barRect.width || BAR_WIDTH_EST,
      barRect.height || BAR_HEIGHT_EST,
    );
    actionBar.style.left = `${left}px`;
    actionBar.style.top = `${top}px`;
    // 縦がビューポートを超える場合は内部スクロールを許容（上寄せ + max-height）
    if (barRect.height > window.innerHeight - 16) {
      actionBar.style.top = '8px';
      actionBar.style.maxHeight = `${window.innerHeight - 16}px`;
      actionBar.style.overflowY = 'auto';
    }
  }

  /**
   * フォーカスがコメント行・アクションバーのどちらにも無くなったら閉じる。
   * relatedTarget が両者の外なら Tab 離脱とみなす。
   */
  private handleFocusOut(e: FocusEvent): void {
    if (!this.current) return;
    const bar = this.current.actionBar;
    const msg = this.current.target.messageEl;
    const inside = (n: EventTarget | null) =>
      n instanceof Node &&
      ((bar && bar.contains(n)) || (msg && msg.contains(n)));

    if (inside(e.relatedTarget)) return; // バー↔コメント間の移動は維持

    // 🟡(B4b): relatedTarget が null（SR 仮想カーソル / 一部ブラウザ）の場合は
    // 次フレームで document.activeElement を再判定してから誤閉じを防ぐ。
    if (e.relatedTarget === null) {
      requestAnimationFrame(() => {
        if (!this.current) return;
        if (inside(document.activeElement)) return;
        this.scheduleHide();
      });
      return;
    }
    // 次フレームに遅延（focusin → focusout の一瞬の谷でちらつかせない）
    this.scheduleHide();
  }

  /**
   * デフォルトツールバーの roving tabindex（←/→/Home/End）。
   * 報告フォーム表示中はバー直下が form コンテナになり直下 button が無いので
   * 何もしない（radiogroup 等は report-form.ts が独自にハンドル）。
   */
  private handleToolbarKeydown(e: KeyboardEvent): void {
    if (!this.current) return;
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const btns = Array.from(
      this.current.actionBar.querySelectorAll<HTMLButtonElement>(':scope > button'),
    );
    if (btns.length === 0) return;
    const activeEl = document.activeElement;
    const idx = btns.findIndex((b) => b === activeEl);
    let nextIdx = idx < 0 ? 0 : idx;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % btns.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + btns.length) % btns.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = btns.length - 1;
    e.preventDefault();
    for (const [i, b] of btns.entries()) {
      b.tabIndex = i === nextIdx ? 0 : -1;
    }
    btns[nextIdx].focus();
  }

  /**
   * 流れて消えたコメント要素への参照を無効化する（バー自体は維持）。
   * MutationObserver（observer.ts）から呼ばれる。原則4「DOM 削除耐性」。
   */
  invalidateMessageRef(removedEl: HTMLElement): void {
    if (!this.current) return;
    const cur = this.current.target.messageEl;
    if (cur && (cur === removedEl || removedEl.contains(cur))) {
      this.current.target.messageEl = null;
      // authorChannelId / displayName は保持済みなのでブロック操作は継続可能。
      // A-4: 対象コメントが流れた旨を SR に告知（操作は継続可能）。
      announce('対象のコメントは流れましたが、操作は続けられます');
    }
  }

  /** 即座に閉じる（×ボタン / ESC / 他コメントへの移動）。原則5。 */
  hideNow(): void {
    if (!this.current) return;
    this.cancelHide();
    const { actionBar, triggerEl } = this.current;
    // A-2: フォーカスがバー内にある（キーボード操作中）なら、閉じる前に
    // トリガ要素へ戻す。トリガが DOM から消えていれば何もしない
    // （フォーカスを body に落とさない）。
    const focusInBar =
      document.activeElement instanceof Node &&
      actionBar.contains(document.activeElement);
    actionBar.remove();
    this.current = null;
    if (focusInBar && triggerEl && document.contains(triggerEl)) {
      triggerEl.focus();
    }
  }

  private scheduleHide(): void {
    if (!this.current) return;
    this.cancelHide();
    this.current.hideTimer = setTimeout(() => this.hideNow(), HIDE_DELAY_MS);
  }

  private cancelHide(): void {
    if (this.current?.hideTimer != null) {
      clearTimeout(this.current.hideTimer);
      this.current.hideTimer = null;
    }
  }

  private createActionBar(target: ActionBarTarget): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'fck-action-bar';
    // a11y: ボタン群なので toolbar ロール + ラベル。🟡(B4b): 用途明示のため
    // プレビュー断片を aria-label に含める（流去後も操作対象が分かる）。
    const previewSnippet = buildPreviewText(target.text).short;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute(
      'aria-label',
      `${target.authorDisplayName || 'このユーザー'} のコメント「${previewSnippet}」へのアクション`,
    );

    if (this.callbacks?.onStats) {
      bar.appendChild(
        this.makeButton('fck-action-stats', '📊', '統計を見る', (e) => {
          e.stopPropagation();
          this.hideNow();
          this.callbacks?.onStats?.(
            target.authorChannelId,
            target.authorDisplayName,
          );
        }),
      );
    }

    bar.appendChild(
      this.makeButton('fck-action-block', '🚫', 'このユーザーをブロック', async (e) => {
        e.stopPropagation();
        const { authorChannelId, authorDisplayName } = target;
        this.hideNow();
        await this.callbacks?.onBlock(authorChannelId, authorDisplayName);
      }),
    );

    if (this.callbacks?.onReport) {
      bar.appendChild(
        this.makeButton('fck-action-report', '⚠️', '誤判定を報告', (e) => {
          e.stopPropagation();
          this.enterReportMode(target);
        }),
      );
    }

    bar.appendChild(
      this.makeButton('fck-action-close', '×', '閉じる', (e) => {
        e.stopPropagation();
        this.hideNow();
      }),
    );

    // A-1: roving tabindex 初期化 — 先頭ボタンのみ Tab 到達可、残りは -1。
    // ツールバー内移動は ←/→（handleToolbarKeydown）。
    const btns = bar.querySelectorAll<HTMLButtonElement>('button');
    btns.forEach((b, i) => {
      b.tabIndex = i === 0 ? 0 : -1;
    });

    return bar;
  }

  private makeButton(
    cls: string,
    glyph: string,
    label: string,
    onClick: (e: MouseEvent) => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.textContent = glyph;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    // A-1: roving tabindex の初期状態（先頭のみ 0、残りは createActionBar 末尾で -1 に）
    btn.tabIndex = 0;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * ⚠️ 押下時: バー内容を誤判定報告フォームに差し替える（P3-UI-06）。
   * バー自体は維持（hideNow しない）。プレビュー / radiogroup / 送信・キャンセル
   * の 3 リングは report-form.ts が独自に a11y ハンドルする。
   */
  private enterReportMode(target: ActionBarTarget): void {
    if (!this.current || !this.callbacks?.onReport) return;
    const onReport = this.callbacks.onReport;
    const reportKind =
      this.callbacks.getReportKind?.(target) ?? 'false_negative';

    const form = buildReportForm({
      text: target.text,
      reportKind,
      onSubmit: (reportedLabel) => {
        onReport(target, reportedLabel);
        announce('報告を送信しました');
        this.hideNow();
      },
      onCancel: () => this.hideNow(),
    });

    const bar = this.current.actionBar;
    bar.textContent = '';
    bar.removeAttribute('role'); // toolbar ではなくなる（form 内に role 群）
    bar.setAttribute(
      'aria-label',
      reportKind === 'false_positive'
        ? '誤フィルタの報告フォーム'
        : '見逃しの報告フォーム',
    );
    bar.appendChild(form.element);
    // A-6: フォームは縦長になりがち。再計測して配置し直す。
    if (this.current.target.messageEl) {
      this.repositionFor(bar, this.current.target.messageEl);
    }
    // ⚠️ は明示操作なのでマウス/キーボード問わず先頭へフォーカス
    form.focusFirst();
  }

  /** テスト用: 現在表示中のターゲットを返す（なければ null）。 */
  getCurrentTarget(): ActionBarTarget | null {
    return this.current?.target ?? null;
  }
}

/** タブ内シングルトン。 */
export const actionBarManager = new ActionBarManager();
