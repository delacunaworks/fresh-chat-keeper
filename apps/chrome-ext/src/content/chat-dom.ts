/**
 * YouTube チャットリプレイの DOM 操作ユーティリティ
 *
 * 重要: display:none は Flow Chat 等の他拡張に効かないため、デフォルトはテキスト書き換え方式。
 * displayMode='hidden' の場合のみ行要素に display:none を設定する（Flow Chat との非互換あり）。
 */

import type { DisplayMode } from '../shared/settings.js';

const ATTR_ORIGINAL = 'data-fck-original';
const ATTR_FILTERED = 'data-fck-filtered';
const ATTR_HIDDEN_ROW = 'data-fck-hidden-row';
/** 誤判定報告済みを示す属性。processMessage がこの要素を再フィルタしないために使用する。 */
export const ATTR_FALSE_POSITIVE = 'data-fck-false-positive';

const PLACEHOLDER = '⚠ ネタバレの可能性があるためフィルタされました（クリックで表示）';

// P3-UI-06: 誤判定報告はアクションバー ⚠️ に一本化。プレースホルダー経由の
// 旧 FP 報告ボタン（MISREPORT_BTN_STYLE / createMisreportButton / onMisreport）は
// 廃止した。ATTR_FALSE_POSITIVE 自体は processMessage の再フィルタ抑止ガードと
// して残置（現状セッターは無いが将来再利用余地。dead だが無害）。

/**
 * 要素ごとに登録済みのトグルリスナーを管理する。
 * setupPlaceholderToggle が再呼び出しされた場合に古いリスナーを解除する。
 */
const toggleListeners = new WeakMap<Element, AbortController>();

// ─── 公開 API ────────────────────────────────────────────────────────────────

/**
 * メッセージ要素をフィルタする。
 * - placeholder: テキストをプレースホルダーに書き換え、クリックでトグル可能（表示/非表示）
 * - hidden: 行要素に display:none を設定（Flow Chat 等では効かない場合あり）
 *
 * @param onReveal    誤判定ボタンクリック時のコールバック（revealedTexts に追加する用途）
 * @param onMisreport 誤判定ボタンクリック時のコールバック（placeholder モードのみ有効）
 */
export function filterMessageElement(
  el: Element,
  displayMode: DisplayMode,
  matchedKeyword?: string,
  matchedContext?: string,
  onReveal?: () => void,
): void {
  if (el.getAttribute(ATTR_FILTERED) === 'true') return;

  const originalText = el.textContent ?? '';
  if (!originalText.trim()) return;

  el.setAttribute(ATTR_FILTERED, 'true');
  if (matchedKeyword) {
    el.setAttribute('data-fck-matched-keyword', matchedKeyword);
  }
  if (matchedContext) {
    el.setAttribute('data-fck-matched-context', matchedContext);
  }

  if (displayMode === 'hidden') {
    // 行コンテナを非表示にする
    const row =
      el.closest('yt-live-chat-text-message-renderer') ??
      el.closest('yt-live-chat-paid-message-renderer') ??
      el.parentElement;
    if (row) {
      row.setAttribute(ATTR_HIDDEN_ROW, 'true');
      (row as HTMLElement).style.display = 'none';
    }
  } else {
    setupPlaceholderToggle(el, originalText, onReveal);
  }
}

/**
 * フィルタ済み要素の表示方式を、復元→再フィルタなしで直接切り替える。
 * フラッシュを防ぐため、ユーザーに元テキストが見える瞬間を作らない。
 */
export function switchDisplayMode(el: Element, nextMode: DisplayMode, onReveal?: () => void): void {
  if (el.getAttribute(ATTR_FILTERED) !== 'true') return;

  if (nextMode === 'hidden') {
    // placeholder → hidden
    // ATTR_ORIGINAL に退避済みのオリジナルテキストを使って行を非表示にする
    abortToggleListener(el);
    const original = el.getAttribute(ATTR_ORIGINAL);
    if (original !== null) {
      el.textContent = original;
      el.removeAttribute(ATTR_ORIGINAL);
    }
    const row =
      el.closest('yt-live-chat-text-message-renderer') ??
      el.closest('yt-live-chat-paid-message-renderer') ??
      el.parentElement;
    if (row) {
      row.setAttribute(ATTR_HIDDEN_ROW, 'true');
      (row as HTMLElement).style.display = 'none';
    }
  } else {
    // hidden → placeholder
    // hidden モードでは ATTR_ORIGINAL がないため現在の textContent がオリジナル
    const originalText = el.textContent ?? '';

    // 先にテキストをプレースホルダーに書き換えてから行を表示（表示瞬間のチラつき防止）
    setupPlaceholderToggle(el, originalText, onReveal);

    const hiddenRow = el.closest(`[${ATTR_HIDDEN_ROW}]`);
    if (hiddenRow) {
      hiddenRow.removeAttribute(ATTR_HIDDEN_ROW);
      (hiddenRow as HTMLElement).style.display = '';
    }
  }
}

/**
 * フィルタ済み要素を元に戻す（設定変更時や手動復元に使用）。
 * ATTR_FALSE_POSITIVE は保持する（誤判定報告済み状態は残す）。
 */
export function restoreMessageElement(el: Element): void {
  const filteredAttr = el.getAttribute(ATTR_FILTERED);
  if (filteredAttr !== 'true' && filteredAttr !== 'revealed') return;

  abortToggleListener(el);

  // hidden モード: 行コンテナの表示を戻す
  const hiddenRow = el.closest(`[${ATTR_HIDDEN_ROW}]`);
  if (hiddenRow) {
    hiddenRow.removeAttribute(ATTR_HIDDEN_ROW);
    (hiddenRow as HTMLElement).style.display = '';
  }

  // placeholder モード: テキストを復元（子要素 span/button も除去）
  const original = el.getAttribute(ATTR_ORIGINAL);
  if (original !== null) {
    el.textContent = original;
    el.removeAttribute(ATTR_ORIGINAL);
  }

  el.removeAttribute(ATTR_FILTERED);
}

// ─── 内部ヘルパー ─────────────────────────────────────────────────────────────

const HIDE_BTN_STYLE = [
  'margin-left:6px',
  'font-size:0.75em',
  'cursor:pointer',
  'opacity:0.65',
  'background:none',
  'border:1px solid currentColor',
  'border-radius:3px',
  'color:inherit',
  'padding:0 4px',
  'vertical-align:middle',
  'white-space:nowrap',
  'line-height:1.4',
].join(';');

/**
 * プレースホルダー表示とトグル動作をセットアップする。
 *
 * 状態機械:
 *   filtered (ATTR_FILTERED='true')
 *     → プレースホルダー span クリック → revealed (ATTR_FILTERED='revealed')
 *     → 「🔒 伏せる」ボタンクリック → filtered（繰り返し）
 *
 * 誤判定ボタンは初回 revealed 時に生成される。
 * 誤判定報告後は「✓ 報告済み」になり、ATTR_FALSE_POSITIVE を付与する。
 *
 * el 全体へのクリックリスナーは付けない（YouTubeのコンテキストメニューが発火するため）。
 * プレースホルダー span と各ボタン要素にのみリスナーを付け、stopPropagation() で伝播を止める。
 */
function setupPlaceholderToggle(
  el: Element,
  originalText: string,
  onReveal?: () => void,
): void {
  // 既存のトグルリスナーを解除してから再設定
  abortToggleListener(el);
  const ctrl = new AbortController();
  toggleListeners.set(el, ctrl);

  el.setAttribute(ATTR_ORIGINAL, originalText);
  el.textContent = '';

  // プレースホルダー span: クリックで revealed に遷移
  const textSpan = document.createElement('span');
  textSpan.textContent = PLACEHOLDER;
  (textSpan as HTMLElement).style.cursor = 'pointer';
  (textSpan as HTMLElement).style.opacity = '0.55';
  el.appendChild(textSpan);

  // 「🔒 伏せる」ボタン: revealed 状態で表示し、クリックで filtered に戻す
  const hideBtn = document.createElement('button');
  hideBtn.style.cssText = HIDE_BTN_STYLE;
  hideBtn.textContent = '🔒 伏せる';
  hideBtn.style.display = 'none';
  el.appendChild(hideBtn);

  // プレースホルダークリック: filtered → revealed
  // P3-UI-06: 誤判定報告ボタンはここに生やさない（アクションバー ⚠️ に一本化）。
  textSpan.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    if (el.getAttribute(ATTR_FILTERED) !== 'true') return;

    textSpan.textContent = originalText;
    (textSpan as HTMLElement).style.cursor = '';
    (textSpan as HTMLElement).style.opacity = '';
    hideBtn.style.display = '';
    el.setAttribute(ATTR_FILTERED, 'revealed');
    onReveal?.();
  }, { signal: ctrl.signal });

  // 「🔒 伏せる」クリック: revealed → filtered
  hideBtn.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    if (el.getAttribute(ATTR_FILTERED) !== 'revealed') return;

    textSpan.textContent = PLACEHOLDER;
    (textSpan as HTMLElement).style.cursor = 'pointer';
    (textSpan as HTMLElement).style.opacity = '0.55';
    hideBtn.style.display = 'none';
    el.setAttribute(ATTR_FILTERED, 'true');
  }, { signal: ctrl.signal });
}

/** 登録済みのトグルリスナーを解除する */
function abortToggleListener(el: Element): void {
  toggleListeners.get(el)?.abort();
  toggleListeners.delete(el);
}
