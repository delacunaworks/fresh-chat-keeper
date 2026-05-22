/**
 * 「ブロック」タブ（P3-UI-04）。
 *
 * データ源は `fck_user_blocks`（B3 blocking.ts、shared
 * `FilterSettings.userBlocks` 同型）。popup から chrome.storage.local を
 * 直接読み書きする（DOM 非依存の user-blocks.ts 経由）。content 側
 * blocking.ts は chrome.storage.onChanged を購読しており、ここでの解除/全解除に
 * 反応して画面上のコメントを復元する（手動テスト「解除でコメント復元」）。
 *
 * 機能: 一覧表示・検索フィルタ・個別解除・全解除。
 * a11y: 検索 input に label、解除は実 button + aria-label + focus-visible。
 */

import { useEffect, useState } from 'react';
import {
  USER_BLOCKS_KEY,
  normalizeUserBlockStore,
  type UserBlockStore,
} from '../../shared/user-blocks.js';

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return '不明';
  }
}

export function UserBlocklist() {
  const [store, setStore] = useState<UserBlockStore | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let active = true;
    chrome.storage.local.get(USER_BLOCKS_KEY, (result) => {
      if (!active) return;
      setStore(normalizeUserBlockStore(result[USER_BLOCKS_KEY]));
    });
    // 他コンテキスト（content の block/unblock）変更を popup にも反映
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local' || !changes[USER_BLOCKS_KEY]) return;
      setStore(normalizeUserBlockStore(changes[USER_BLOCKS_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const persist = (next: UserBlockStore) => {
    setStore(next);
    void chrome.storage.local.set({ [USER_BLOCKS_KEY]: next });
  };

  const unblock = (channelId: string) => {
    if (!store) return;
    const metadata = { ...store.metadata };
    delete metadata[channelId];
    persist({
      channelIds: store.channelIds.filter((id) => id !== channelId),
      metadata,
    });
  };

  const unblockAll = () => {
    persist({ channelIds: [], metadata: {} });
  };

  if (!store) {
    return <div className="p-4 text-sm text-gray-400">読み込み中...</div>;
  }

  const ids = store.channelIds;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? ids.filter((id) => {
        const name = store.metadata[id]?.displayNameAtBlock ?? id;
        return (
          id.toLowerCase().includes(q) || name.toLowerCase().includes(q)
        );
      })
    : ids;

  return (
    <div>
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="text-xs font-medium text-gray-500 mb-1.5">
          ブロック中のユーザー ({ids.length})
        </div>
        <label className="sr-only" htmlFor="fck-blocklist-search">
          ブロック中ユーザーを検索
        </label>
        <input
          id="fck-blocklist-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="名前・IDで検索"
          className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm bg-white focus-visible:ring-2 focus-visible:ring-indigo-500 focus:outline-none"
        />
      </div>

      {ids.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-gray-400">
          ブロック中のユーザーはいません。
          <br />
          チャットのコメントにマウスを乗せて 🚫 でブロックできます。
        </div>
      ) : (
        <>
          <ul className="max-h-60 overflow-y-auto divide-y divide-gray-100">
            {filtered.length === 0 && (
              <li className="px-4 py-4 text-xs text-gray-400">
                「{query}」に一致するユーザーはいません
              </li>
            )}
            {filtered.map((id) => {
              const meta = store.metadata[id];
              const name = meta?.displayNameAtBlock ?? id;
              return (
                <li
                  key={id}
                  className="px-4 py-2.5 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-gray-800 truncate">{name}</div>
                    <div className="text-[11px] text-gray-400">
                      {meta ? `ブロック日: ${formatDate(meta.blockedAt)}` : id}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => unblock(id)}
                    aria-label={`${name} のブロックを解除`}
                    className="shrink-0 text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-indigo-500 focus:outline-none"
                  >
                    解除
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="px-4 py-3 border-t border-gray-100">
            <button
              type="button"
              onClick={unblockAll}
              className="w-full text-xs py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500 focus:outline-none"
            >
              全て解除（{ids.length}件）
            </button>
          </div>
        </>
      )}
    </div>
  );
}
