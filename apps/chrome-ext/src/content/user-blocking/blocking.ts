/**
 * ユーザーブロック処理（P3-UI-02）。
 *
 * 保存先は専用キー `fck_user_blocks`（CLAUDE.md 命名規則 `fck_<category>`）。
 * chrome-ext 独自 `Settings` 型には手を入れない（新カテゴリ/ブロック UI フィールド
 * 追加は B4 / P3-UI-04 スコープ）。shared FilterSettings.userBlocks と同型構造に
 * 揃えてあるので、将来 B4 で設定 UI に統合する際の移行が容易。
 *
 * 遡及非表示は CLAUDE.md 設計原則6（display:none ではなくテキスト書き換え）に
 * 従い、既存スポイラーフィルタと同じ {@link filterMessageElement}
 * （data-fck-original 退避 + プレースホルダー）を再利用する。Flow Chat 等の
 * 弾幕拡張併用時も効く。
 */

import {
  filterMessageElement,
  restoreMessageElement,
} from '../chat-dom.js';
import { getAuthorChannelIdFromElement } from '../author-extract.js';
import type { DisplayMode } from '../../shared/settings.js';
import {
  USER_BLOCKS_KEY,
  emptyUserBlockStore as emptyStore,
  normalizeUserBlockStore as normalizeStore,
  type UserBlockStore,
} from '../../shared/user-blocks.js';

export {
  USER_BLOCKS_KEY,
  type UserBlockMetadata,
  type UserBlockStore,
} from '../../shared/user-blocks.js';

/** ブロック対象メッセージのフィルタ理由（誤判定報告メタ等で使用） */
const BLOCK_REASON = 'ユーザーブロック';

/** チャットメッセージ renderer のセレクタ（通常 + スパチャ） */
const RENDERER_SELECTOR =
  'yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer';
/** renderer 内の本文要素 */
const MESSAGE_SELECTOR = '#message';

/** 高速同期判定用のメモリキャッシュ（processMessage のホットパスから参照）。 */
let blockedSet = new Set<string>();
let storeCache: UserBlockStore = emptyStore();
let loaded = false;

/** 外部変更時の遡及非表示に使う displayMode を返すプロバイダ（既定 placeholder） */
let displayModeProvider: () => DisplayMode = () => 'placeholder';
let storageListenerAttached = false;

/**
 * 起動時に一度だけ呼ぶ。`fck_user_blocks` をメモリへ読み込む。
 * 以降 {@link isUserBlocked} が同期判定可能になる。
 *
 * P3-UI-04: popup の UserBlocklist タブが `fck_user_blocks` を直接書き換える
 * （別コンテキスト）。content 側はその変更を購読し、解除されたユーザーの
 * コメントを復元・新規ブロックを遡及非表示する（手動テスト「解除でコメント復元」）。
 *
 * @param getDisplayMode 外部変更時の遡及非表示に使う表示方式プロバイダ
 */
export async function initUserBlocks(
  getDisplayMode?: () => DisplayMode,
): Promise<void> {
  if (getDisplayMode) displayModeProvider = getDisplayMode;
  if (!loaded) {
    try {
      const result = await chrome.storage.local.get(USER_BLOCKS_KEY);
      storeCache = normalizeStore(result[USER_BLOCKS_KEY]);
    } catch (err) {
      // chrome.storage 失敗時はブロックなしで継続（フィルタ機能自体は生かす）。
      // サイレント失敗を避けるためログ。
      console.error('[FreshChatKeeper] ユーザーブロックの読み込みに失敗:', err);
      storeCache = emptyStore();
    }
    blockedSet = new Set(storeCache.channelIds);
    loaded = true;
  }

  if (!storageListenerAttached) {
    storageListenerAttached = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[USER_BLOCKS_KEY]) return;
      const next = normalizeStore(changes[USER_BLOCKS_KEY].newValue);
      const nextSet = new Set(next.channelIds);
      const prevSet = blockedSet;
      // 自分（content）の blockUser/unblockUser 由来の変更も発火するが、
      // diff ベースなので冪等（既に hide/restore 済みなら no-op）。
      const added = [...nextSet].filter((id) => !prevSet.has(id));
      const removed = [...prevSet].filter((id) => !nextSet.has(id));
      storeCache = next;
      blockedSet = nextSet;
      const mode = displayModeProvider();
      for (const id of added) hideExistingMessagesFromUser(id, mode);
      for (const id of removed) restoreMessagesFromUser(id);
    });
  }
}

/** 同期ブロック判定（initUserBlocks 後に有効）。空 channelId は常に false。 */
export function isUserBlocked(channelId: string): boolean {
  if (!channelId) return false;
  return blockedSet.has(channelId);
}

/** 現在のブロックストアのスナップショット（読み取り専用用途）。 */
export function getUserBlockStore(): UserBlockStore {
  return { channelIds: [...storeCache.channelIds], metadata: { ...storeCache.metadata } };
}

/**
 * storeCache を chrome.storage に永続化する。
 * B4a hardening C: 失敗を握り潰さず boolean で返す（呼び出し側がロールバック）。
 */
async function persist(): Promise<boolean> {
  try {
    await chrome.storage.local.set({ [USER_BLOCKS_KEY]: storeCache });
    return true;
  } catch (err) {
    console.error('[FreshChatKeeper] ユーザーブロックの永続化に失敗:', err);
    return false;
  }
}

/**
 * ユーザーをブロックする。
 * - `fck_user_blocks` に追加して永続化（重複はスキップ）
 * - 画面上の当該ユーザーの既存コメントを遡及非表示（テキスト書き換え方式）
 *
 * B4a hardening C: 永続化失敗時はメモリキャッシュ（storeCache / blockedSet）を
 * ロールバックし `false` を返す（DOM 非表示も行わない＝状態の不整合を避ける）。
 * 呼び出し側はトーストで失敗を可視化する。
 *
 * @returns 永続化成功（または既ブロックで no-op）なら true、失敗なら false
 */
export async function blockUser(
  channelId: string,
  displayName: string,
  displayMode: DisplayMode,
): Promise<boolean> {
  if (!channelId) {
    console.warn('[FreshChatKeeper] ブロック対象の channelId が空のため中止');
    return false;
  }
  if (blockedSet.has(channelId)) {
    // 既にブロック済み: 遡及非表示だけ再適用（永続化は不要、成功扱い）
    hideExistingMessagesFromUser(channelId, displayMode);
    return true;
  }

  // 楽観的に in-memory 更新 → 永続化 → 失敗ならロールバック
  storeCache.channelIds.push(channelId);
  storeCache.metadata[channelId] = {
    displayNameAtBlock: displayName,
    blockedAt: Date.now(),
  };
  blockedSet.add(channelId);

  const ok = await persist();
  if (!ok) {
    storeCache.channelIds = storeCache.channelIds.filter((id) => id !== channelId);
    delete storeCache.metadata[channelId];
    blockedSet.delete(channelId);
    return false;
  }

  hideExistingMessagesFromUser(channelId, displayMode);
  return true;
}

/**
 * ブロックを解除する。
 * - `fck_user_blocks` から除去して永続化
 * - 画面上の当該ユーザーのブロック済みコメントを復元
 *
 * B4a hardening C: 永続化失敗時はメモリキャッシュをロールバックし `false`。
 *
 * @returns 永続化成功（または未ブロックで no-op）なら true、失敗なら false
 */
export async function unblockUser(channelId: string): Promise<boolean> {
  if (!blockedSet.has(channelId)) return true;

  const removedMeta = storeCache.metadata[channelId];
  storeCache.channelIds = storeCache.channelIds.filter((id) => id !== channelId);
  delete storeCache.metadata[channelId];
  blockedSet.delete(channelId);

  const ok = await persist();
  if (!ok) {
    // ロールバック（順序は問わない、blockedSet が真実源）
    if (!storeCache.channelIds.includes(channelId)) {
      storeCache.channelIds.push(channelId);
    }
    if (removedMeta) storeCache.metadata[channelId] = removedMeta;
    blockedSet.add(channelId);
    return false;
  }

  restoreMessagesFromUser(channelId);
  return true;
}

/**
 * 画面上の当該ユーザーの既存コメントを遡及的に非表示にする。
 * テキスト書き換え方式（filterMessageElement）を使う（設計原則6）。
 */
export function hideExistingMessagesFromUser(
  channelId: string,
  displayMode: DisplayMode,
): void {
  const renderers = document.querySelectorAll(RENDERER_SELECTOR);
  for (const renderer of Array.from(renderers)) {
    if (getAuthorChannelIdFromElement(renderer) !== channelId) continue;
    const msg = renderer.querySelector(MESSAGE_SELECTOR);
    if (msg) {
      filterMessageElement(msg, displayMode, BLOCK_REASON);
    }
  }
}

/** ブロック解除時、当該ユーザーのコメントを復元する。 */
export function restoreMessagesFromUser(channelId: string): void {
  const renderers = document.querySelectorAll(RENDERER_SELECTOR);
  for (const renderer of Array.from(renderers)) {
    if (getAuthorChannelIdFromElement(renderer) !== channelId) continue;
    const msg = renderer.querySelector(MESSAGE_SELECTOR);
    if (msg) {
      restoreMessageElement(msg);
    }
  }
}
