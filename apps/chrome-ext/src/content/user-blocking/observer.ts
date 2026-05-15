/**
 * チャット流去（コメント要素 DOM 削除）の監視。
 *
 * Hover-Safe Pattern 原則4「DOM 削除耐性」の実装。ライブ/リプレイチャットは
 * 古いコメントを次々 DOM から削除するため、アクションバー表示中に対象コメントが
 * 消えることがある。その際バー自体は維持し、対象コメント参照だけ無効化する
 * （操作は保持済みの channelId / displayName で継続可能）。
 *
 * スコープ（P3-UI-01）: 監視と参照無効化のみ。
 */

import { actionBarManager } from './hover-manager.js';

let removalObserver: MutationObserver | null = null;

/**
 * チャットコンテナ配下の要素削除を監視し、アクションバーの対象参照を
 * 無効化する。多重呼び出しは前の observer を破棄してから張り直す。
 */
export function setupChatRemovalObserver(chatContainer: Element): void {
  removalObserver?.disconnect();
  removalObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.removedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          actionBarManager.invalidateMessageRef(node);
        }
      });
    }
  });
  removalObserver.observe(chatContainer, { childList: true, subtree: true });
}

/** 監視を停止する（コンテキスト無効化時など）。 */
export function teardownChatRemovalObserver(): void {
  removalObserver?.disconnect();
  removalObserver = null;
}
