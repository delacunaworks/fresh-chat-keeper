/**
 * Phase 3.5（v0.5.0）視聴者フラグ DOM 表示層。
 *
 * 役割:
 * - 1 メッセージごとに `resolveFlagLevel` を呼んで作者名要素に
 *   `data-fck-flag` / `data-fck-flag-total` / `data-fck-flag-count` を付ける
 * - 設定の `displayStyle` を `<body data-fck-display-style="...">` で表現し、
 *   4 表示パターン（icon / color / hover_only / red_only）を **CSS のみ** で
 *   切り替える（設計文書 改訂1: hover 駆動 JS リスナーは持たない）
 * - L2 in-memory memoization で同一視聴者の連投を 1 回の resolve に圧縮
 *   （B4 持ち越し G-2、cached TTL 5 分と整合）
 *
 * DOM 介入はあるが MutationObserver は持たない（archive.ts の emit hook で
 * 駆動される pull モデル）。chrome.* / document.* / window.* を使う。
 */

import { getAuthorChannelIdFromElement } from '../author-extract.js';
import { STORAGE_KEY, type Settings, type UserFlaggingDisplayStyle } from '../../shared/settings.js';
import { SessionTracker } from './session-tracker.js';
import { getCurrentStreamerChannelId } from './stream-detector.js';
import { resolveFlagLevel, CACHED_TTL_MS } from './flag-level-resolver.js';
import type { FlagEvaluationResult } from '@fresh-chat-keeper/judgment-engine';

/** チャットメッセージ renderer の作者名要素セレクタ。 */
const AUTHOR_NAME_SELECTOR = '#author-name';

/** 全表示モード切替を司る body 属性名。 */
const BODY_DISPLAY_STYLE_ATTR = 'data-fck-display-style';

/** 作者名要素に付ける属性名。 */
const FLAG_ATTR = 'data-fck-flag';
const FLAG_TOTAL_ATTR = 'data-fck-flag-total';
const FLAG_COUNT_ATTR = 'data-fck-flag-count';

/** メッセージ renderer の selector（attach / re-process 用）。 */
export const MESSAGE_RENDERER_SELECTOR =
  'yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer';

// ─── L2 in-memory cache ─────────────────────────────────────────

interface L2Entry {
  result: FlagEvaluationResult;
  expiresAt: number;
}

/** Map<streamerId::userId, L2Entry>。同 session 内で resolveFlagLevel を集約。 */
const l2Cache = new Map<string, L2Entry>();

function l2Key(streamerId: string, userId: string): string {
  return `${streamerId}::${userId}`;
}

function l2Get(streamerId: string, userId: string, nowMs: number): FlagEvaluationResult | null {
  const e = l2Cache.get(l2Key(streamerId, userId));
  if (!e) return null;
  if (e.expiresAt <= nowMs) {
    l2Cache.delete(l2Key(streamerId, userId));
    return null;
  }
  return e.result;
}

function l2Set(streamerId: string, userId: string, result: FlagEvaluationResult, nowMs: number): void {
  l2Cache.set(l2Key(streamerId, userId), {
    result,
    expiresAt: nowMs + CACHED_TTL_MS,
  });
}

/**
 * L2 in-memory cache を全クリア。
 * archive.ts の onChanged で sensitivity / scope / enabled が変わったときに呼ぶ。
 * DOM 上の既存フラグ属性はこのクリア後の次の `applyFlagToMessage` で更新される
 * （MVP: 即時 DOM 反映はしない、ラグは数秒〜次の判定到着まで許容）。
 */
export function clearL2Cache(): void {
  l2Cache.clear();
}

// ─── モジュールスコープ状態 ─────────────────────────────────────

let currentSettings: Settings | null = null;
let sessionTrackerRef: SessionTracker | null = null;
let storageListenerInstalled = false;

// ─── 公開 API ───────────────────────────────────────────────────

/**
 * archive.ts 起動時に 1 回呼ぶ。
 * - 初期 displayStyle を body 属性にセット
 * - chrome.storage.onChanged を購読し、displayStyle / 感度 / scope / enabled
 *   変更に追従
 *
 * `tracker` は flag-level-resolver が session スコープを計算するのに必要。
 */
export function initUiOverlay(initialSettings: Settings, tracker: SessionTracker): void {
  currentSettings = initialSettings;
  sessionTrackerRef = tracker;
  ensureStyleInjected();
  setGlobalDisplayStyle(initialSettings.userFlagging.displayStyle);

  if (storageListenerInstalled) return;
  storageListenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    const prev = changes[STORAGE_KEY].oldValue as Settings | undefined;
    const next = changes[STORAGE_KEY].newValue as Settings | undefined;
    if (!next) return;
    onSettingsChanged(prev, next);
  });
}

/**
 * 1 メッセージの作者名要素にフラグ data 属性を付与する。
 * archive.ts の emit hook（recordAggregate と同じ場所）から呼ばれる。
 *
 * 流れ:
 * 1. enabled=false → 早期 return（既存属性は触らない、setEnabledForExisting 経路で除去済み想定）
 * 2. streamerId / userId / authorEl が揃わなければ skip
 * 3. L2 cache hit → 即座に attr 付与
 * 4. L2 miss → resolveFlagLevel → L2 set → attr 付与
 * 5. level=clean → 属性を **除去**（設計 L417 のとおり、フラグ無しは無印）
 */
export async function applyFlagToMessage(messageEl: HTMLElement): Promise<void> {
  if (!currentSettings || !sessionTrackerRef) return;
  if (!currentSettings.userFlagging.enabled) return;

  const streamerId = getCurrentStreamerChannelId();
  const userId = getAuthorChannelIdFromElement(messageEl);
  if (!streamerId || !userId) return;

  const renderer = findRenderer(messageEl);
  if (!renderer) return;

  const nowMs = Date.now();
  let result = l2Get(streamerId, userId, nowMs);
  if (!result) {
    result = await resolveFlagLevel(streamerId, userId, currentSettings, sessionTrackerRef);
    l2Set(streamerId, userId, result, nowMs);
  }

  applyAttrs(renderer, result);
}

/**
 * 既存 DOM 上の全メッセージにフラグ判定を再適用する（OFF→ON 切替時 / scope 変更時）。
 *
 * archive.ts の onChanged で enabled が false→true / scope 変更時に呼ばれる。
 * `MESSAGE_RENDERER_SELECTOR` で iframe document（content script のローカル
 * document）と親 document の両方を走査する。
 */
export async function reapplyFlagsToExistingMessages(): Promise<void> {
  if (!currentSettings || !sessionTrackerRef) return;
  if (!currentSettings.userFlagging.enabled) return;
  const docs = collectDocuments();
  const promises: Promise<void>[] = [];
  for (const doc of docs) {
    const renderers = doc.querySelectorAll<HTMLElement>(MESSAGE_RENDERER_SELECTOR);
    for (const el of Array.from(renderers)) {
      promises.push(applyFlagToMessage(el));
    }
  }
  await Promise.all(promises);
}

/**
 * 既存 DOM 上のフラグ属性を全件除去する（ON→OFF 切替時）。
 * L2 cache もクリアする。
 */
export function removeAllFlagAttrs(): void {
  const docs = collectDocuments();
  for (const doc of docs) {
    const flagged = doc.querySelectorAll<HTMLElement>(`[${FLAG_ATTR}]`);
    for (const el of Array.from(flagged)) {
      el.removeAttribute(FLAG_ATTR);
      el.removeAttribute(FLAG_TOTAL_ATTR);
      el.removeAttribute(FLAG_COUNT_ATTR);
    }
  }
  clearL2Cache();
}

// ─── 内部ヘルパー ───────────────────────────────────────────────

function setGlobalDisplayStyle(style: UserFlaggingDisplayStyle): void {
  try {
    const body = (typeof document !== 'undefined' ? document.body : null) ?? null;
    body?.setAttribute(BODY_DISPLAY_STYLE_ATTR, style);
    // chat iframe context の場合は parent document.body にも反映
    // （CSS は parent 側の body 属性を見る作りでないため iframe 側だけで十分だが、
    // 統一感のため両方に反映する）
    const parentBody = window.parent?.document?.body;
    if (parentBody && parentBody !== body) {
      parentBody.setAttribute(BODY_DISPLAY_STYLE_ATTR, style);
    }
  } catch {
    // ignore（非ブラウザ環境）
  }
}

function findRenderer(messageEl: HTMLElement): HTMLElement | null {
  if (messageEl.matches(MESSAGE_RENDERER_SELECTOR)) return messageEl;
  const closest =
    messageEl.closest('yt-live-chat-text-message-renderer') ??
    messageEl.closest('yt-live-chat-paid-message-renderer');
  return closest instanceof HTMLElement ? closest : null;
}

function applyAttrs(renderer: HTMLElement, result: FlagEvaluationResult): void {
  // level=clean はフラグ無し＝属性を持たない（設計 L417 / CSS 上で何も表示しない）
  if (result.level === 'clean') {
    removeFlagAttrsOn(renderer);
    return;
  }
  renderer.setAttribute(FLAG_ATTR, result.level);
  renderer.setAttribute(FLAG_TOTAL_ATTR, String(result.totalMessages));
  renderer.setAttribute(FLAG_COUNT_ATTR, String(result.totalFlagged));
}

function removeFlagAttrsOn(renderer: HTMLElement): void {
  renderer.removeAttribute(FLAG_ATTR);
  renderer.removeAttribute(FLAG_TOTAL_ATTR);
  renderer.removeAttribute(FLAG_COUNT_ATTR);
}

function onSettingsChanged(prev: Settings | undefined, next: Settings): void {
  currentSettings = next;

  const prevUF = prev?.userFlagging;
  const nextUF = next.userFlagging;
  if (!nextUF) return;

  // displayStyle 変更 → body 属性更新（CSS 即座反映）
  if (prevUF?.displayStyle !== nextUF.displayStyle) {
    setGlobalDisplayStyle(nextUF.displayStyle);
  }

  // sensitivity / scope / enabled 変更 → L2 cache クリア
  const sensitivityChanged =
    JSON.stringify(prevUF?.sensitivity) !== JSON.stringify(nextUF.sensitivity);
  const scopeChanged = prevUF?.scope !== nextUF.scope;
  const enabledChanged = prevUF?.enabled !== nextUF.enabled;

  if (sensitivityChanged || scopeChanged || enabledChanged) {
    clearL2Cache();
  }

  // ON→OFF: 既存属性を全除去
  if (prevUF?.enabled === true && nextUF.enabled === false) {
    removeAllFlagAttrs();
    return;
  }

  // OFF→ON or scope/sensitivity 変更時: 既存 DOM に再適用
  if ((!prevUF?.enabled && nextUF.enabled) || sensitivityChanged || scopeChanged) {
    void reapplyFlagsToExistingMessages();
  }
}

function collectDocuments(): Document[] {
  const docs: Document[] = [];
  try {
    if (typeof document !== 'undefined') docs.push(document);
    const parentDoc = window.parent?.document;
    if (parentDoc && parentDoc !== document) docs.push(parentDoc);
  } catch {
    // ignore
  }
  return docs;
}

// ─── CSS injection ─────────────────────────────────────────────

const STYLE_ELEMENT_ID = 'fck-user-flagging-styles';

const STYLE_TEXT = `
/* === Phase 3.5 視聴者フラグ表示（4 パターン、JS ホバーリスナー無し） === */

/* 共通: clean（data-fck-flag が無い）は何も表示しない（属性が無い時点で
   CSS セレクタにマッチしないので追加スタイル不要） */

/* ─── パターン1: icon（デフォルト） ─── */
[${BODY_DISPLAY_STYLE_ATTR}="icon"] [${FLAG_ATTR}="yellow"] ${AUTHOR_NAME_SELECTOR}::before {
  content: "\\1F7E1 ";
  margin-right: 2px;
}
[${BODY_DISPLAY_STYLE_ATTR}="icon"] [${FLAG_ATTR}="red"] ${AUTHOR_NAME_SELECTOR}::before {
  content: "\\1F534 ";
  margin-right: 2px;
}
[${BODY_DISPLAY_STYLE_ATTR}="icon"] [${FLAG_ATTR}="grey"] ${AUTHOR_NAME_SELECTOR}::before {
  content: "\\B7";
  color: #888;
  margin-right: 4px;
}

/* ─── パターン2: color（ユーザー名を着色） ─── */
[${BODY_DISPLAY_STYLE_ATTR}="color"] [${FLAG_ATTR}="yellow"] ${AUTHOR_NAME_SELECTOR} {
  color: #d4a017;
  font-weight: 600;
}
[${BODY_DISPLAY_STYLE_ATTR}="color"] [${FLAG_ATTR}="red"] ${AUTHOR_NAME_SELECTOR} {
  color: #d32f2f;
  font-weight: 700;
}

/* ─── パターン3: hover_only（純 CSS、JS 不要） ─── */
[${BODY_DISPLAY_STYLE_ATTR}="hover_only"] [${FLAG_ATTR}="yellow"]:hover ${AUTHOR_NAME_SELECTOR}::before {
  content: "\\1F7E1 ";
  margin-right: 2px;
}
[${BODY_DISPLAY_STYLE_ATTR}="hover_only"] [${FLAG_ATTR}="red"]:hover ${AUTHOR_NAME_SELECTOR}::before {
  content: "\\1F534 ";
  margin-right: 2px;
}

/* ─── パターン4: red_only（red のみ明確表示、yellow / grey は無印） ─── */
[${BODY_DISPLAY_STYLE_ATTR}="red_only"] [${FLAG_ATTR}="red"] ${AUTHOR_NAME_SELECTOR}::before {
  content: "\\1F534 ";
  margin-right: 2px;
}
`;

function ensureStyleInjected(): void {
  try {
    const docs = collectDocuments();
    for (const doc of docs) {
      if (doc.getElementById(STYLE_ELEMENT_ID)) continue;
      const style = doc.createElement('style');
      style.id = STYLE_ELEMENT_ID;
      style.textContent = STYLE_TEXT;
      (doc.head ?? doc.documentElement).appendChild(style);
    }
  } catch {
    // ignore（非ブラウザ環境）
  }
}

// ─── テスト用 ───────────────────────────────────────────────────

/** @internal テスト用 */
export const __test__ = {
  reset(): void {
    currentSettings = null;
    sessionTrackerRef = null;
    storageListenerInstalled = false;
    l2Cache.clear();
  },
  l2Size(): number {
    return l2Cache.size;
  },
  setStateForTest(settings: Settings, tracker: SessionTracker): void {
    currentSettings = settings;
    sessionTrackerRef = tracker;
  },
  setGlobalDisplayStyle,
  triggerOnSettingsChanged: onSettingsChanged,
  FLAG_ATTR,
  FLAG_TOTAL_ATTR,
  FLAG_COUNT_ATTR,
  BODY_DISPLAY_STYLE_ATTR,
  STYLE_ELEMENT_ID,
};
