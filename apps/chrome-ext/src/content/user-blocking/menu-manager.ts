/**
 * ユーザーブロック/誤判定報告の **行内アンカー + クリックメニュー** 管理。
 *
 * 設計正本: `dev-docs/phase-3-multilabel.md` §実装中の設計改訂 6
 * （ホバー設計の構造的欠陥 → 案 A 全面置換）、`architecture.md` §2.1.4 /
 * §2.1.4.1（B5 で「行内アンカー + クリックメニュー」前提に改訂）。
 *
 * 旧 Hover-Safe Pattern（body 直下 fixed バー + ホバー駆動）は **コメント
 * 静止前提**で、ライブの自動スクロールに非対応だった（流速でバー到達不能 /
 * 左上固定 / YouTube ネイティブ 3 点メニュー被り / 全 renderer への
 * tabindex 干渉）。本実装はそれらを構造的に解消する:
 *
 * - **配置**: YouTube `#menu`（3 点）と同戦略。コメント renderer の
 *   **子要素**として自前トリガ `<button>` を `position:absolute`・本文フロー外・
 *   3 点の少し左に挿入する。コメントと一緒にスクロールする（流速に強い）。
 *   通常は薄表示、行ホバーで濃く＝**CSS のみ**（JS ホバー駆動にしない）
 * - **開閉**: トリガクリックでアクションメニュー（📊?/🚫/⚠️/×）をポップ
 *   アップ。閉じ＝× / 外側クリック / ESC。それ以外では消えない（流れても
 *   保持。channelId/displayName/text はトリガ生成時スナップショット）。
 *   **報告フォーム展開中の外側クリックは無視**（入力消失防止。ESC/× は閉じる）
 * - **a11y**: トリガは行内 `<button aria-haspopup="menu" aria-expanded>`
 *   （Tab 到達自然）。開いたら先頭 focus、メニュー内 roving（矢印）、
 *   B-1 フォーカストラップ（Tab/Shift+Tab はメニュー内循環、radiogroup の
 *   現在 tabindex=0 radio を含む）、ESC でトリガ復帰
 *
 * 再利用（中身不変、注入先＝器だけ差し替え）: `report-form.ts`
 * （buildReportForm・3 roving・radiogroup）、`live-region.ts`、`blocking.ts`、
 * `undo-toast.ts`。本ファイルは旧 `hover-manager.ts` を置換する。
 */

import { announce } from './live-region.js';
import type { TriggerVisibility } from '../../shared/settings.js';
import {
  buildReportForm,
  buildPreviewText,
  type ReportKind,
  type ReportedLabel,
} from './report-form.js';

/** メニューの操作対象（1 コメント分のメタ情報、トリガ生成時スナップショット） */
export interface ActionMenuTarget {
  /** コメント renderer。流れて消えても以下のメタは保持される */
  messageEl: HTMLElement | null;
  /** 投稿者の識別子（2026-05 仕様では @ハンドル名。空文字なら不明） */
  authorChannelId: string;
  /** ブロック時点の表示名 */
  authorDisplayName: string;
  /** 同一コメント再アタッチ判定用キー */
  messageKey: string;
  /** コメント本文（プレビュー用スナップショット、流去後も使う） */
  text: string;
}

/** archive.ts が注入するアクションハンドラ */
export interface ActionMenuCallbacks {
  /** 🚫 ブロック。channelId 空なら blockUser 側で no-op + 失敗トースト */
  onBlock: (channelId: string, displayName: string) => void | Promise<void>;
  /**
   * ⚠️ 誤判定報告。フォームで選ばれた reportedLabel（スキップ時 undefined）と、
   * **メニュー操作開始時にスナップショットした reportKind** を渡す。
   * 送信時に reportKind を再計算しない（DOM トランジション競合解消、B5）。
   * 未注入ならボタン非表示。
   */
  onReport?: (
    target: ActionMenuTarget,
    reportedLabel: ReportedLabel | undefined,
    reportKind: ReportKind,
  ) => void | Promise<void>;
  /**
   * 報告フォームの文言用に FP/FN を解決する（フィルタ済み→FP / 表示中→FN）。
   * ⚠️ 押下時に **1 回だけ**呼んでスナップショットする。未注入時 'false_negative'。
   */
  getReportKind?: (target: ActionMenuTarget) => ReportKind;
  /** 📊 統計（任意、Phase 3.5 で本実装。未注入ならボタン非表示） */
  onStats?: (channelId: string, displayName: string) => void;
}

const MENU_WIDTH_EST = 160;
const MENU_HEIGHT_EST = 40;
const STYLE_ELEMENT_ID = 'fck-action-menu-styles';
const TRIGGER_CLASS = 'fck-trigger';
const TRIGGER_VIS_ATTR = 'data-fck-trigger-vis';

/**
 * 行内トリガの表示モード（B5-fix）。archive.ts が設定値で
 * {@link ActionMenuManager.setTriggerVisibility} を呼んで更新する。
 * 既定 hover_only。新規 attach トリガと既存トリガの両方に反映する。
 */
let currentTriggerVisibility: TriggerVisibility = 'hover_only';

const STYLE_TEXT = `
.${TRIGGER_CLASS} {
  position: absolute;
  top: 2px;
  /* YouTube ネイティブ 3 点 #menu（右端 ~4px / 幅 ~24px）の少し左。
     ※ #menu 親要素・余白は静的に断定できないため実機検証要（手動テスト）。 */
  right: 34px;
  width: 20px;
  height: 20px;
  padding: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 15, 15, 0.55);
  color: #fff;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  /* B5-fix: 既定は hover_only（通常は非表示。行ホバー/フォーカス/展開で出る）。
     data-fck-trigger-vis="always" のときだけ常時薄表示にする。 */
  opacity: 0;
  transition: opacity 0.12s;
  z-index: 60;
}
.${TRIGGER_CLASS}[data-fck-trigger-vis="always"] { opacity: 0.2; }
yt-live-chat-text-message-renderer:hover .${TRIGGER_CLASS},
yt-live-chat-paid-message-renderer:hover .${TRIGGER_CLASS},
.${TRIGGER_CLASS}:hover,
.${TRIGGER_CLASS}:focus-visible,
.${TRIGGER_CLASS}[aria-expanded="true"] { opacity: 1; }
/* B6a a11y(WCAG 2.4.11): 可変背景でも 3:1 を保証する二重リング
   （白内側 outline + 濃色外側 box-shadow）。単色 outline は濃色背景で消える。 */
.${TRIGGER_CLASS}:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 1px;
  box-shadow: 0 0 0 4px #1a73e8;
}
/* タッチ（hover 不可）はホバーで濃くできないので、モードに関わらず常時可視寄り。
   always の属性セレクタ（specificity 高）に負けないよう同セレクタも上書きする。 */
@media (hover: none) {
  .${TRIGGER_CLASS},
  .${TRIGGER_CLASS}[data-fck-trigger-vis="always"] { opacity: 0.6; }
}
/* B6a UI: 行内トリガ（right:34px・幅20px ≒ 右端0〜54px を占有）が、行の
   右端まで伸びたコメント本文と**横方向で重なる**問題への対処。YouTube
   ネイティブ 3 点メニューと同じレイアウト戦略＝本文コンテナに右余白を
   確保し、テキストがトリガ領域に侵入しないようにする。renderer 直下
   content のテキスト要素 message に inline-end パディングを足す
   （トリガ幅+間隔ぶん）。※ content / message の実 box は YouTube DOM
   依存のため値は保守的目安。最終確認は実機手動テスト（長文コメントでの
   非重なり）に残す。 */
yt-live-chat-text-message-renderer #message,
yt-live-chat-paid-message-renderer #message {
  padding-inline-end: 36px;
}

.fck-action-menu {
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
.fck-action-menu button {
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
.fck-action-menu button:hover { background: rgba(255, 255, 255, 0.2); }
.fck-action-menu button:focus-visible {
  /* B6a a11y(WCAG 2.4.11): 可変背景 3:1 保証の二重リング */
  outline: 2px solid #fff;
  outline-offset: 1px;
  box-shadow: 0 0 0 4px #1a73e8;
}
.fck-action-menu .fck-action-close { opacity: 0.6; font-size: 16px; }
.fck-action-menu .fck-action-close:hover,
.fck-action-menu .fck-action-close:focus-visible { opacity: 1; }
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
 * クリックメニューの fixed 配置座標を算出する純粋関数。
 *
 * - 既定はトリガ右隣（rect.right + 8）の垂直中央
 * - 右にはみ出すなら左側へ回し、左端も画面外なら 8px でクリップ
 * - 上下も 8px マージンでビューポート内にクリップ
 *
 * DOM 非依存なので単体テスト可能（menu-manager の唯一の非自明な純ロジック）。
 * 旧 computeActionBarPosition と同一アルゴリズム（基準がコメント矩形 →
 * 行内トリガ矩形に変わっただけ）。
 */
export function computeMenuPosition(
  rect: RectLike,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = MENU_WIDTH_EST,
  menuHeight = MENU_HEIGHT_EST,
): { left: number; top: number } {
  let left = rect.right + 8;
  if (left + menuWidth > viewportWidth) {
    left = Math.max(8, rect.left - menuWidth - 8);
  }
  let top = rect.top + rect.height / 2 - menuHeight / 2;
  top = Math.max(8, Math.min(top, viewportHeight - menuHeight - 8));
  return { left, top };
}

interface MenuState {
  target: ActionMenuTarget;
  menuEl: HTMLElement;
  /** A-2: 開いたトリガ要素。閉じる際にフォーカスを戻す。 */
  triggerEl: HTMLElement;
  /** 報告フォーム展開中フラグ（外側クリックで閉じない）。 */
  reportMode: boolean;
  /** ⚠️ 押下時にスナップショットした reportKind（送信時に再計算しない）。 */
  reportKind: ReportKind;
}

/**
 * 行内アンカー + クリックメニューの単一インスタンス管理クラス。
 * タブ内シングルトン（{@link actionMenuManager}）として使う。
 */
export class ActionMenuManager {
  private current: MenuState | null = null;
  private callbacks: ActionMenuCallbacks | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private outsidePointerHandler: ((e: Event) => void) | null = null;

  /** archive.ts のアクションを注入し、グローバル ESC / 外側クリックを有効化。 */
  init(callbacks: ActionMenuCallbacks): void {
    this.callbacks = callbacks;
    ensureStylesInjected();

    if (!this.keydownHandler) {
      this.keydownHandler = (e: KeyboardEvent) => {
        // ESC はメニュー / 報告フォームのどちらでも閉じる（B-1）
        if (e.key === 'Escape' && this.current) {
          e.stopPropagation();
          this.closeMenu();
        }
      };
      // capture=true: YouTube のキーボードショートカットに先んじて ESC を拾う
      document.addEventListener('keydown', this.keydownHandler, true);
    }

    if (!this.outsidePointerHandler) {
      this.outsidePointerHandler = (e: Event) => {
        if (!this.current) return;
        const t = e.target;
        if (!(t instanceof Node)) return;
        const { menuEl, triggerEl } = this.current;
        // メニュー内・トリガ上はメニュー自身が処理（外側ではない）
        if (menuEl.contains(t) || triggerEl.contains(t)) return;
        // 報告フォーム展開中は外側クリックで閉じない（入力消失防止）。
        // 閉じたいときは × / ESC を使う。
        if (this.current.reportMode) return;
        this.closeMenu();
      };
      // pointerdown capture でマウス/タッチ両対応の外側閉じ
      document.addEventListener('pointerdown', this.outsidePointerHandler, true);
    }
  }

  /**
   * コメント renderer に行内トリガ `<button>` を子要素として挿入する。
   * 多重挿入は `.fck-trigger` 既存チェックで防ぐ（archive 側の
   * data-fck-ab-attached ガードと二重で冪等）。
   */
  attachToMessage(
    renderer: HTMLElement,
    target: Omit<ActionMenuTarget, 'messageEl'>,
  ): void {
    if (renderer.querySelector(`:scope > .${TRIGGER_CLASS}`)) return;

    // 絶対配置の子を載せるため renderer を配置コンテキストにする。
    // YouTube renderer は #menu/#deleted-state のため通常 position:relative
    // だが、static の場合のみ relative を補う（実機検証要）。
    const pos = getComputedStyle(renderer).position;
    if (pos === 'static') renderer.style.position = 'relative';

    const snippet = buildPreviewText(target.text).short;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = TRIGGER_CLASS;
    trigger.textContent = '⋯';
    trigger.tabIndex = 0;
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    // B5-fix: 表示モード（hover_only / always）を data 属性で表現。CSS が参照。
    trigger.setAttribute(TRIGGER_VIS_ATTR, currentTriggerVisibility);
    trigger.setAttribute(
      'aria-label',
      `${target.authorDisplayName || 'このユーザー'} のコメント「${snippet}」への操作`,
    );
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.toggleMenu({ ...target, messageEl: renderer }, trigger);
    });
    renderer.appendChild(trigger);
  }

  /** 同じトリガなら閉じ、違う/未表示なら開く。 */
  private toggleMenu(target: ActionMenuTarget, trigger: HTMLElement): void {
    if (this.current && this.current.triggerEl === trigger) {
      this.closeMenu();
      return;
    }
    this.openMenu(target, trigger);
  }

  private openMenu(target: ActionMenuTarget, trigger: HTMLElement): void {
    if (!this.callbacks) return;
    if (this.current) this.closeMenu();

    const menuEl = this.createMenu(target);
    document.body.appendChild(menuEl);

    this.current = {
      target,
      menuEl,
      triggerEl: trigger,
      reportMode: false,
      reportKind: 'false_negative',
    };

    trigger.setAttribute('aria-expanded', 'true');
    // 実 DOM サイズ確定後に配置（縦長になる報告フォームにも対応、A-6 相当）
    this.reposition();

    // B-1 フォーカストラップ + メニュー内 roving（矢印）
    menuEl.addEventListener('keydown', (e) => this.handleMenuKeydown(e));

    // クリックで明示的に開いたので先頭操作要素へフォーカス
    const first = menuEl.querySelector<HTMLButtonElement>('button');
    first?.focus();
  }

  /** 実 DOM サイズを測ってビューポート内に配置し直す。 */
  private reposition(): void {
    if (!this.current) return;
    const { menuEl, triggerEl } = this.current;
    const anchorRect = triggerEl.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();
    const { left, top } = computeMenuPosition(
      anchorRect,
      window.innerWidth,
      window.innerHeight,
      menuRect.width || MENU_WIDTH_EST,
      menuRect.height || MENU_HEIGHT_EST,
    );
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
    // 縦がビューポートを超える場合は上寄せ + 内部スクロール
    if (menuRect.height > window.innerHeight - 16) {
      menuEl.style.top = '8px';
      menuEl.style.maxHeight = `${window.innerHeight - 16}px`;
      menuEl.style.overflowY = 'auto';
    }
  }

  /** 即座に閉じる（× / 外側クリック / ESC）。 */
  closeMenu(): void {
    if (!this.current) return;
    const { menuEl, triggerEl } = this.current;
    const focusInMenu =
      document.activeElement instanceof Node &&
      menuEl.contains(document.activeElement);
    menuEl.remove();
    this.current = null;
    // トリガの aria-expanded を戻し、キーボード操作中ならフォーカス復帰。
    // トリガが DOM から消えていれば no-op（フォーカスを body に落とさない）。
    if (document.contains(triggerEl)) {
      triggerEl.setAttribute('aria-expanded', 'false');
      if (focusInMenu) triggerEl.focus();
    }
  }

  /**
   * B-1 フォーカストラップ + メニュー内 roving。
   * - Tab/Shift+Tab: メニュー内の tabbable（tabIndex===0）を循環。
   *   radiogroup の現在 tabindex=0 radio / プレビュー ⤢ / 送信 を含む
   * - ←/→/↑/↓/Home/End: メニュー直下ボタンの roving（報告フォーム展開中は
   *   直下ボタンが無いので no-op。フォーム内の矢印は report-form が処理）
   */
  private handleMenuKeydown(e: KeyboardEvent): void {
    if (!this.current) return;
    const { menuEl } = this.current;

    if (e.key === 'Tab') {
      const tabbables = Array.from(
        menuEl.querySelectorAll<HTMLElement>('button'),
      ).filter((b) => b.tabIndex === 0 && !(b as HTMLButtonElement).disabled);
      e.preventDefault();
      if (tabbables.length === 0) return;
      const idx = tabbables.indexOf(document.activeElement as HTMLElement);
      let next: number;
      if (idx < 0) next = 0;
      else if (e.shiftKey) next = (idx - 1 + tabbables.length) % tabbables.length;
      else next = (idx + 1) % tabbables.length;
      tabbables[next].focus();
      return;
    }

    const rovingKeys = [
      'ArrowRight',
      'ArrowLeft',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
    ];
    if (!rovingKeys.includes(e.key)) return;
    const btns = Array.from(
      menuEl.querySelectorAll<HTMLButtonElement>(':scope > button'),
    );
    if (btns.length === 0) return; // 報告フォーム展開中（form 内は report-form 管理）
    const activeEl = document.activeElement;
    const idx = btns.findIndex((b) => b === activeEl);
    let nextIdx = idx < 0 ? 0 : idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown')
      nextIdx = (idx + 1) % btns.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      nextIdx = (idx - 1 + btns.length) % btns.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = btns.length - 1;
    e.preventDefault();
    for (const [i, b] of btns.entries()) {
      b.tabIndex = i === nextIdx ? 0 : -1;
    }
    btns[nextIdx].focus();
  }

  private createMenu(target: ActionMenuTarget): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'fck-action-menu';
    const snippet = buildPreviewText(target.text).short;
    menu.setAttribute('role', 'menu');
    menu.setAttribute(
      'aria-label',
      `${target.authorDisplayName || 'このユーザー'} のコメント「${snippet}」へのアクション`,
    );

    if (this.callbacks?.onStats) {
      menu.appendChild(
        this.makeButton('fck-action-stats', '📊', '統計を見る', (e) => {
          e.stopPropagation();
          this.closeMenu();
          this.callbacks?.onStats?.(
            target.authorChannelId,
            target.authorDisplayName,
          );
        }),
      );
    }

    menu.appendChild(
      this.makeButton(
        'fck-action-block',
        '🚫',
        'このユーザーをブロック',
        async (e) => {
          e.stopPropagation();
          const { authorChannelId, authorDisplayName } = target;
          this.closeMenu();
          await this.callbacks?.onBlock(authorChannelId, authorDisplayName);
        },
      ),
    );

    if (this.callbacks?.onReport) {
      menu.appendChild(
        this.makeButton('fck-action-report', '⚠️', '誤判定を報告', (e) => {
          e.stopPropagation();
          this.enterReportMode(target);
        }),
      );
    }

    menu.appendChild(
      this.makeButton('fck-action-close', '×', '閉じる', (e) => {
        e.stopPropagation();
        this.closeMenu();
      }),
    );

    // roving 初期化 — 先頭のみ Tab/矢印起点（tabIndex=0）、残りは -1。
    const btns = menu.querySelectorAll<HTMLButtonElement>('button');
    btns.forEach((b, i) => {
      b.tabIndex = i === 0 ? 0 : -1;
    });

    return menu;
  }

  private makeButton(
    cls: string,
    glyph: string,
    label: string,
    onClick: (e: MouseEvent) => void | Promise<void>,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.textContent = glyph;
    btn.title = label;
    btn.setAttribute('role', 'menuitem');
    btn.setAttribute('aria-label', label);
    btn.tabIndex = 0;
    // B6a silent-failure: onClick が async（🚫 onBlock 等）の場合の
    // Promise rejection / 同期 throw を握り潰さず、SR とログに出す。
    // makeButton の型を void|Promise<void> に広げ rejection を捕捉する。
    btn.addEventListener('click', (e) => {
      const handleErr = (err: unknown) => {
        console.error('[FreshChatKeeper] アクションメニュー操作に失敗:', err);
        announce('操作に失敗しました', { assertive: true });
      };
      try {
        const r = onClick(e);
        if (r && typeof (r as Promise<void>).then === 'function') {
          (r as Promise<void>).catch(handleErr);
        }
      } catch (err) {
        handleErr(err);
      }
    });
    return btn;
  }

  /**
   * ⚠️ 押下時: メニュー内容を誤判定報告フォームに差し替える。
   * reportKind を **この時点で 1 回だけ**スナップショットし、送信時には
   * 再計算しない（DOM トランジション競合解消、B5 silent-failure）。
   */
  private enterReportMode(target: ActionMenuTarget): void {
    if (!this.current || !this.callbacks?.onReport) return;
    const onReport = this.callbacks.onReport;
    const reportKind =
      this.callbacks.getReportKind?.(target) ?? 'false_negative';
    this.current.reportMode = true;
    this.current.reportKind = reportKind;

    const form = buildReportForm({
      text: target.text,
      reportKind,
      // B6a silent-failure: onReport を await し、保存成功時のみ
      // 「報告を送信しました」+ closeMenu。失敗（reject）は report-form 側の
      // submit ハンドラが捕捉して assertive 告知 + 再送可能化する。
      onSubmit: async (reportedLabel) => {
        await onReport(target, reportedLabel, reportKind);
        announce('報告を送信しました');
        this.closeMenu();
      },
      onCancel: () => this.closeMenu(),
    });

    const menuEl = this.current.menuEl;
    menuEl.textContent = '';
    menuEl.removeAttribute('role'); // menu ではなくなる（form 内に role 群）
    menuEl.setAttribute(
      'aria-label',
      reportKind === 'false_positive'
        ? '誤フィルタの報告フォーム'
        : '見逃しの報告フォーム',
    );
    menuEl.appendChild(form.element);
    // フォームは縦長になりがち。再計測して配置し直す。
    this.reposition();
    // B6a a11y: menu→報告フォームへ role が切り替わる（menu 喪失）ことを
    // SR に polite 告知（フォーカス移動だけだと文脈の変化が伝わりにくい）。
    announce(
      reportKind === 'false_positive'
        ? '誤フィルタの報告フォームを開きました'
        : '見逃しの報告フォームを開きました',
    );
    form.focusFirst();
  }

  /**
   * 行内トリガの表示モードを設定する（B5-fix）。
   * 新規 attach トリガに加え、**既存の attach 済みトリガ全件**にも即時反映
   * する（data 属性切替なので再 attach 不要）。archive.ts が起動時の設定値と
   * chrome.storage.onChanged で呼ぶ。
   */
  setTriggerVisibility(mode: TriggerVisibility): void {
    currentTriggerVisibility = mode;
    document
      .querySelectorAll<HTMLElement>(`.${TRIGGER_CLASS}`)
      .forEach((el) => el.setAttribute(TRIGGER_VIS_ATTR, mode));
  }

  /** テスト/デバッグ用: 現在表示中のターゲットを返す（なければ null）。 */
  getCurrentTarget(): ActionMenuTarget | null {
    return this.current?.target ?? null;
  }
}

/** タブ内シングルトン。 */
export const actionMenuManager = new ActionMenuManager();
