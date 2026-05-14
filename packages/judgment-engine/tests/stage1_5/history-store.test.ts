/**
 * HistoryStore の単体テスト。
 *
 * 検証観点:
 * - addMessage がユーザー別 / 横断双方に積まれる
 * - TTL 過ぎたエントリが読み出し時にフィルタされる
 * - サイズキャップが効く（USER_HISTORY_MAX / CHAT_HISTORY_MAX）
 * - pruneExpired で能動削除できる
 * - clear で全消去できる
 * - 未登録ユーザーで getUserHistory が空履歴を返す
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  HistoryStore,
  USER_HISTORY_MAX,
  USER_HISTORY_TTL_MS,
  CHAT_HISTORY_MAX,
  CHAT_HISTORY_TTL_MS,
} from '../../src/stage1_5/history-store.js';
import type { Message } from '../../src/types.js';

const BASE_TS = 1_700_000_000_000;

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    text: 'hello',
    authorChannelId: 'UC_alice',
    authorDisplayName: 'alice',
    timestamp: BASE_TS,
    ...overrides,
  };
}

describe('HistoryStore', () => {
  let store: HistoryStore;
  beforeEach(() => {
    store = new HistoryStore();
  });

  describe('addMessage / getUserHistory', () => {
    it('未登録ユーザーは空履歴を返す', () => {
      const hist = store.getUserHistory('UC_unknown', BASE_TS);
      expect(hist).toEqual({ channelId: 'UC_unknown', messages: [] });
    });

    it('追加したメッセージが getUserHistory で取り出せる', () => {
      store.addMessage(msg({ text: 'hi', timestamp: BASE_TS }));
      const hist = store.getUserHistory('UC_alice', BASE_TS);
      expect(hist.channelId).toBe('UC_alice');
      expect(hist.messages).toEqual([{ text: 'hi', timestamp: BASE_TS }]);
    });

    it('同一ユーザーの複数追加は時系列で保持される', () => {
      store.addMessage(msg({ text: 'a', timestamp: BASE_TS }));
      store.addMessage(msg({ text: 'b', timestamp: BASE_TS + 1000 }));
      store.addMessage(msg({ text: 'c', timestamp: BASE_TS + 2000 }));
      const hist = store.getUserHistory('UC_alice', BASE_TS + 3000);
      expect(hist.messages.map((m) => m.text)).toEqual(['a', 'b', 'c']);
    });

    it('ユーザーごとに履歴が分離される', () => {
      store.addMessage(msg({ authorChannelId: 'UC_alice', text: 'a' }));
      store.addMessage(msg({ authorChannelId: 'UC_bob', text: 'b' }));
      expect(store.getUserHistory('UC_alice', BASE_TS).messages.map((m) => m.text))
        .toEqual(['a']);
      expect(store.getUserHistory('UC_bob', BASE_TS).messages.map((m) => m.text))
        .toEqual(['b']);
    });

    it('TTL を過ぎたエントリは getUserHistory で読み出されない', () => {
      store.addMessage(msg({ text: 'old', timestamp: BASE_TS }));
      store.addMessage(msg({ text: 'new', timestamp: BASE_TS + USER_HISTORY_TTL_MS - 1 }));
      const now = BASE_TS + USER_HISTORY_TTL_MS;
      const hist = store.getUserHistory('UC_alice', now);
      // 'old' は now - BASE_TS = TTL なので境界（>=）でカット
      expect(hist.messages.map((m) => m.text)).toEqual(['new']);
    });

    it('USER_HISTORY_MAX を超えると古いものから削除される', () => {
      for (let i = 0; i < USER_HISTORY_MAX + 5; i++) {
        store.addMessage(msg({ text: `msg-${i}`, timestamp: BASE_TS + i }));
      }
      const hist = store.getUserHistory('UC_alice', BASE_TS + USER_HISTORY_MAX + 5);
      expect(hist.messages.length).toBe(USER_HISTORY_MAX);
      // 最古の 5 件が消えている
      expect(hist.messages[0].text).toBe('msg-5');
      expect(hist.messages[hist.messages.length - 1].text).toBe(
        `msg-${USER_HISTORY_MAX + 4}`,
      );
    });
  });

  describe('addMessage / getChatHistory', () => {
    it('複数ユーザーの投稿が横断履歴に集約される', () => {
      store.addMessage(msg({ authorChannelId: 'UC_alice', text: 'a' }));
      store.addMessage(msg({ authorChannelId: 'UC_bob', text: 'b' }));
      store.addMessage(msg({ authorChannelId: 'UC_carol', text: 'c' }));
      const chat = store.getChatHistory(BASE_TS);
      expect(chat.messages.map((m) => `${m.channelId}:${m.text}`)).toEqual([
        'UC_alice:a',
        'UC_bob:b',
        'UC_carol:c',
      ]);
    });

    it('TTL を過ぎたエントリは getChatHistory で読み出されない', () => {
      store.addMessage(msg({ text: 'old', timestamp: BASE_TS }));
      store.addMessage(msg({ text: 'new', timestamp: BASE_TS + CHAT_HISTORY_TTL_MS - 1 }));
      const now = BASE_TS + CHAT_HISTORY_TTL_MS;
      const hist = store.getChatHistory(now);
      expect(hist.messages.map((m) => m.text)).toEqual(['new']);
    });

    it('CHAT_HISTORY_MAX を超えると古いものから削除される', () => {
      // 異なるユーザーで投稿してチャット履歴を埋める
      for (let i = 0; i < CHAT_HISTORY_MAX + 3; i++) {
        store.addMessage(
          msg({
            authorChannelId: `UC_user_${i}`,
            text: `msg-${i}`,
            timestamp: BASE_TS + i,
          }),
        );
      }
      const stats = store.getStats();
      expect(stats.chatMessageCount).toBe(CHAT_HISTORY_MAX);
      const chat = store.getChatHistory(BASE_TS + CHAT_HISTORY_MAX + 3);
      // 古い 3 件が削除されているはず
      expect(chat.messages[0].text).toBe('msg-3');
    });
  });

  describe('pruneExpired', () => {
    it('期限切れエントリを能動削除する', () => {
      store.addMessage(msg({ text: 'old', timestamp: BASE_TS }));
      store.addMessage(msg({ text: 'new', timestamp: BASE_TS + USER_HISTORY_TTL_MS + 1000 }));
      store.pruneExpired(BASE_TS + USER_HISTORY_TTL_MS + 1000);
      const hist = store.getUserHistory('UC_alice', BASE_TS + USER_HISTORY_TTL_MS + 1000);
      expect(hist.messages.map((m) => m.text)).toEqual(['new']);
    });

    it('全エントリ期限切れのユーザーは Map から削除される', () => {
      store.addMessage(msg({ authorChannelId: 'UC_alice', timestamp: BASE_TS }));
      store.addMessage(msg({ authorChannelId: 'UC_bob', timestamp: BASE_TS + USER_HISTORY_TTL_MS + 1 }));
      store.pruneExpired(BASE_TS + USER_HISTORY_TTL_MS + 1);
      const stats = store.getStats();
      // UC_alice は完全期限切れで削除、UC_bob は残る
      expect(stats.userCount).toBe(1);
    });
  });

  describe('clear', () => {
    it('全履歴を破棄する', () => {
      store.addMessage(msg({ authorChannelId: 'UC_alice', text: 'a' }));
      store.addMessage(msg({ authorChannelId: 'UC_bob', text: 'b' }));
      store.clear();
      expect(store.getStats()).toEqual({ userCount: 0, chatMessageCount: 0 });
      expect(store.getUserHistory('UC_alice', BASE_TS).messages).toEqual([]);
      expect(store.getChatHistory(BASE_TS).messages).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('内部サイズを返す', () => {
      store.addMessage(msg({ authorChannelId: 'UC_alice', text: 'a' }));
      store.addMessage(msg({ authorChannelId: 'UC_alice', text: 'b' }));
      store.addMessage(msg({ authorChannelId: 'UC_bob', text: 'c' }));
      expect(store.getStats()).toEqual({ userCount: 2, chatMessageCount: 3 });
    });
  });
});
