/**
 * Stage 1.5 で使うメモリ内履歴ストア。
 *
 * 目的:
 * - ユーザー別履歴: 連投 / 自己コピペ判定に必要
 * - チャット横断履歴: 横断コピペ（複数アカウントによる同一文言投稿）判定に必要
 *
 * 設計方針:
 * - DOM / chrome.* 非依存（純粋なメモリ内 Map / 配列）
 * - TTL でメモリ膨張を防ぐ（古いメッセージは `getXxxHistory` で読む際にフィルタ）
 * - サイズキャップでも防御（TTL が緩い場合や時刻が単調増加でない場合）
 * - 配信切り替え時は呼び出し側で {@link HistoryStore.clear} する責務
 *
 * 設計 ground truth: `dev-docs/phase-3-multilabel.md` 「履歴ストア」
 */

import type { Message } from '../types.js';

/** ユーザー別履歴の保持件数上限（投稿者単位） */
export const USER_HISTORY_MAX = 20;
/** ユーザー別履歴の TTL（5分） */
export const USER_HISTORY_TTL_MS = 5 * 60 * 1000;
/** チャット横断履歴の保持件数上限 */
export const CHAT_HISTORY_MAX = 500;
/** チャット横断履歴の TTL（10分） */
export const CHAT_HISTORY_TTL_MS = 10 * 60 * 1000;

export interface UserHistoryEntry {
  text: string;
  timestamp: number;
}

export interface UserMessageHistory {
  channelId: string;
  messages: UserHistoryEntry[];
}

export interface ChatHistoryEntry {
  text: string;
  channelId: string;
  timestamp: number;
}

export interface ChatWideHistory {
  messages: ChatHistoryEntry[];
}

/**
 * メモリ内履歴ストア。
 *
 * 典型的な利用パターン:
 * ```ts
 * const store = new HistoryStore();
 * // Stage 1.5 が message を受け取ったタイミングで:
 * const userHist = store.getUserHistory(message.authorChannelId, now);
 * const chatHist = store.getChatHistory(now);
 * const spam = detectSpam(message, userHist, chatHist);
 * store.addMessage(message); // 履歴に追加（spam 判定の後）
 * ```
 *
 * メモリ管理:
 * - サイズキャップ: ユーザー別 {@link USER_HISTORY_MAX}、横断 {@link CHAT_HISTORY_MAX}
 * - TTL: 読み出し時にフィルタ。`pruneExpired(now)` で能動的に削除も可能
 */
export class HistoryStore {
  private readonly userHistories = new Map<string, UserMessageHistory>();
  private readonly chatHistory: ChatWideHistory = { messages: [] };

  /**
   * メッセージを履歴に追加する。
   *
   * spam 判定の「直前」ではなく「直後」に呼ぶこと。判定対象自身が
   * 履歴にあると「自己コピペ」として誤検出するため。
   */
  addMessage(message: Message): void {
    const entry: UserHistoryEntry = {
      text: message.text,
      timestamp: message.timestamp,
    };

    let userHistory = this.userHistories.get(message.authorChannelId);
    if (!userHistory) {
      userHistory = { channelId: message.authorChannelId, messages: [] };
      this.userHistories.set(message.authorChannelId, userHistory);
    }
    userHistory.messages.push(entry);
    if (userHistory.messages.length > USER_HISTORY_MAX) {
      userHistory.messages.splice(0, userHistory.messages.length - USER_HISTORY_MAX);
    }

    this.chatHistory.messages.push({
      text: message.text,
      channelId: message.authorChannelId,
      timestamp: message.timestamp,
    });
    if (this.chatHistory.messages.length > CHAT_HISTORY_MAX) {
      this.chatHistory.messages.splice(
        0,
        this.chatHistory.messages.length - CHAT_HISTORY_MAX,
      );
    }
  }

  /**
   * 指定ユーザーの履歴を返す（TTL 内のもののみ）。
   * 未登録ユーザーの場合は空の履歴を返す。
   */
  getUserHistory(channelId: string, now: number): UserMessageHistory {
    const raw = this.userHistories.get(channelId);
    if (!raw) return { channelId, messages: [] };
    return {
      channelId,
      messages: raw.messages.filter(
        (m) => now - m.timestamp < USER_HISTORY_TTL_MS,
      ),
    };
  }

  /**
   * チャット横断履歴を返す（TTL 内のもののみ）。
   */
  getChatHistory(now: number): ChatWideHistory {
    return {
      messages: this.chatHistory.messages.filter(
        (m) => now - m.timestamp < CHAT_HISTORY_TTL_MS,
      ),
    };
  }

  /**
   * TTL を過ぎたエントリを能動的に削除し、メモリを解放する。
   * 配信が長時間続く場合に定期的に呼び出すことで、ユーザー別 Map に
   * 全エントリ期限切れの島が溜まるのを防ぐ。
   */
  pruneExpired(now: number): void {
    for (const [channelId, history] of this.userHistories) {
      history.messages = history.messages.filter(
        (m) => now - m.timestamp < USER_HISTORY_TTL_MS,
      );
      if (history.messages.length === 0) {
        this.userHistories.delete(channelId);
      }
    }
    this.chatHistory.messages = this.chatHistory.messages.filter(
      (m) => now - m.timestamp < CHAT_HISTORY_TTL_MS,
    );
  }

  /**
   * すべての履歴を破棄する。配信切り替え（URL 変更）時に呼ぶ。
   */
  clear(): void {
    this.userHistories.clear();
    this.chatHistory.messages = [];
  }

  /**
   * 内部状態のサイズ情報を返す（テスト・デバッグ用）。
   */
  getStats(): { userCount: number; chatMessageCount: number } {
    return {
      userCount: this.userHistories.size,
      chatMessageCount: this.chatHistory.messages.length,
    };
  }
}
