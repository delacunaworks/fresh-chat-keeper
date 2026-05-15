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
}

/** UI-02 / UI-03 が注入するアクションハンドラ */
export interface ActionBarCallbacks {
  /** 🚫 ブロック（UI-02 が blockUser を注入） */
  onBlock: (channelId: string, displayName: string) => void | Promise<void>;
  /** ⚠️ 誤判定報告（任意、未注入ならボタン非表示） */
  onReport?: (target: ActionBarTarget) => void;
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
.fck-action-bar .fck-action-close:hover { opacity: 1; }
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
}

/**
 * アクションバーの単一インスタンス管理クラス。タブ内シングルトン
 * （{@link actionBarManager}）として使う。
 */
export class ActionBarManager {
  private current: HoverState | null = null;
  private callbacks: ActionBarCallbacks | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

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
  }

  /** コメント要素にホバーリスナーをアタッチする。 */
  attachToMessage(messageEl: HTMLElement, target: Omit<ActionBarTarget, 'messageEl'>): void {
    // タッチデバイス（hover 不可）: タップで開く / 別所タップで閉じる
    const isTouch =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none)').matches;

    if (isTouch) {
      messageEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showActionBar(messageEl, target);
      });
      return;
    }

    messageEl.addEventListener('mouseenter', () =>
      this.showActionBar(messageEl, target),
    );
    messageEl.addEventListener('mouseleave', () => this.scheduleHide());
  }

  showActionBar(
    messageEl: HTMLElement,
    target: Omit<ActionBarTarget, 'messageEl'>,
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
    this.positionActionBar(actionBar, messageEl);
    document.body.appendChild(actionBar);

    actionBar.addEventListener('mouseenter', () => this.cancelHide());
    actionBar.addEventListener('mouseleave', () => this.scheduleHide());

    this.current = { target: fullTarget, actionBar, hideTimer: null };
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
      // authorChannelId / displayName は保持済みなのでブロック操作は継続可能
    }
  }

  /** 即座に閉じる（×ボタン / ESC / 他コメントへの移動）。原則5。 */
  hideNow(): void {
    if (!this.current) return;
    this.cancelHide();
    this.current.actionBar.remove();
    this.current = null;
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

  private positionActionBar(actionBar: HTMLElement, messageEl: HTMLElement): void {
    const rect = messageEl.getBoundingClientRect();
    const { left, top } = computeActionBarPosition(
      rect,
      window.innerWidth,
      window.innerHeight,
    );
    actionBar.style.left = `${left}px`;
    actionBar.style.top = `${top}px`;
  }

  private createActionBar(target: ActionBarTarget): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'fck-action-bar';
    // a11y: ボタン群なので toolbar ロール + ラベル
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute(
      'aria-label',
      `${target.authorDisplayName || 'このユーザー'} へのアクション`,
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
          const t = target;
          this.hideNow();
          this.callbacks?.onReport?.(t);
        }),
      );
    }

    bar.appendChild(
      this.makeButton('fck-action-close', '×', '閉じる', (e) => {
        e.stopPropagation();
        this.hideNow();
      }),
    );

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
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** テスト用: 現在表示中のターゲットを返す（なければ null）。 */
  getCurrentTarget(): ActionBarTarget | null {
    return this.current?.target ?? null;
  }
}

/** タブ内シングルトン。 */
export const actionBarManager = new ActionBarManager();
