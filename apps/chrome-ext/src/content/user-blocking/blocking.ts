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

/** 1 ユーザー分のブロックメタ情報 */
export interface UserBlockMetadata {
  displayNameAtBlock: string;
  blockedAt: number;
  reason?: string;
}

/** `fck_user_blocks` の保存構造（shared FilterSettings.userBlocks と同型） */
export interface UserBlockStore {
  channelIds: string[];
  metadata: Record<string, UserBlockMetadata>;
}

export const USER_BLOCKS_KEY = 'fck_user_blocks';

/** ブロック対象メッセージのフィルタ理由（誤判定報告メタ等で使用） */
const BLOCK_REASON = 'ユーザーブロック';

/** チャットメッセージ renderer のセレクタ（通常 + スパチャ） */
const RENDERER_SELECTOR =
  'yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer';
/** renderer 内の本文要素 */
const MESSAGE_SELECTOR = '#message';

/** 高速同期判定用のメモリキャッシュ（processMessage のホットパスから参照）。 */
let blockedSet = new Set<string>();
let storeCache: UserBlockStore = { channelIds: [], metadata: {} };
let loaded = false;

function emptyStore(): UserBlockStore {
  return { channelIds: [], metadata: {} };
}

/** 不正な保存値に強い正規化（型不一致は空構造へ fail-safe）。 */
function normalizeStore(raw: unknown): UserBlockStore {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return emptyStore();
  }
  const r = raw as Record<string, unknown>;
  const channelIds = Array.isArray(r.channelIds)
    ? r.channelIds.filter((v): v is string => typeof v === 'string')
    : [];
  const metadata: Record<string, UserBlockMetadata> = {};
  if (typeof r.metadata === 'object' && r.metadata !== null && !Array.isArray(r.metadata)) {
    for (const [id, m] of Object.entries(r.metadata as Record<string, unknown>)) {
      if (typeof m !== 'object' || m === null) continue;
      const mm = m as Record<string, unknown>;
      if (
        typeof mm.displayNameAtBlock === 'string' &&
        typeof mm.blockedAt === 'number' &&
        !Number.isNaN(mm.blockedAt)
      ) {
        metadata[id] = {
          displayNameAtBlock: mm.displayNameAtBlock,
          blockedAt: mm.blockedAt,
          ...(typeof mm.reason === 'string' ? { reason: mm.reason } : {}),
        };
      }
    }
  }
  return { channelIds, metadata };
}

/**
 * 起動時に一度だけ呼ぶ。`fck_user_blocks` をメモリへ読み込む。
 * 以降 {@link isUserBlocked} が同期判定可能になる。
 */
export async function initUserBlocks(): Promise<void> {
  if (loaded) return;
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
