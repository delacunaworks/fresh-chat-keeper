/**
 * detectSpam の単体テスト。
 *
 * 検証観点:
 * - 6 パターン（rapid_fire / self_copy_paste / coordinated_copy_paste /
 *   character_repeat / url_spam / emoji_spam）それぞれが検出される
 * - 正当なコメントを誤検出しない（false-positive 抑制）
 * - 評価順の優先度（連投が自己コピペより先に判定される 等）
 * - サロゲートペア（絵文字）の文字連打判定が正しく動く
 */

import { describe, it, expect } from 'vitest';
import {
  detectSpam,
  SPAM_DETECTION_THRESHOLDS,
} from '../../src/stage1_5/spam-detector.js';
import type {
  UserMessageHistory,
  ChatWideHistory,
} from '../../src/stage1_5/history-store.js';
import type { Message } from '../../src/types.js';

const NOW = 1_700_000_000_000;

function msg(text: string, ts: number = NOW): Message {
  return {
    id: 'm1',
    text,
    authorChannelId: 'UC_alice',
    authorDisplayName: 'alice',
    timestamp: ts,
  };
}

function userHist(
  entries: Array<{ text: string; timestamp: number }>,
  channelId = 'UC_alice',
): UserMessageHistory {
  return { channelId, messages: entries };
}

function chatHist(
  entries: Array<{ text: string; channelId: string; timestamp: number }>,
): ChatWideHistory {
  return { messages: entries };
}

const emptyChat: ChatWideHistory = { messages: [] };
const emptyUser: UserMessageHistory = { channelId: 'UC_alice', messages: [] };

describe('detectSpam', () => {
  // ─── none: 正当なコメントを誤検出しない ────────────────────────
  describe('none (false-positive 抑制)', () => {
    it('履歴なしの普通のコメントは none', () => {
      const r = detectSpam(msg('かわいい！'), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'none' });
    });

    it('同じユーザーが少し前に別の発言をしているだけ（1件）なら none', () => {
      const r = detectSpam(
        msg('かわいい', NOW),
        userHist([{ text: 'おはよう', timestamp: NOW - 5000 }]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('感想を2回投稿しても、間が10秒超なら none', () => {
      const r = detectSpam(
        msg('かわいい', NOW),
        userHist([{ text: 'よかった', timestamp: NOW - 60_000 }]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('「888」は character_repeat（10未満）にならず none', () => {
      // 888 のような短い祝意表現を誤検出しないこと
      const r = detectSpam(msg('888'), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'none' });
    });

    it('「www」も none', () => {
      const r = detectSpam(msg('www'), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'none' });
    });

    it('URLが1つだけなら none', () => {
      const r = detectSpam(
        msg('参考: https://example.com/article'),
        emptyUser,
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('URLが2つでも none（しきい値は3）', () => {
      const r = detectSpam(
        msg('https://a.com と https://b.com を見て'),
        emptyUser,
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('絵文字が少しだけ含まれる普通の長文は none', () => {
      const r = detectSpam(
        msg('今日の配信めちゃくちゃ面白かった！次も楽しみ😊'),
        emptyUser,
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('絵文字短文（10文字以下）は none', () => {
      const r = detectSpam(msg('😊😊😊'), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'none' });
    });

    it('別ユーザー2人が同一文言を投稿しても、しきい値3に満たないので none', () => {
      const r = detectSpam(
        msg('応援してます'),
        emptyUser,
        chatHist([
          { text: '応援してます', channelId: 'UC_bob', timestamp: NOW - 1000 },
          { text: '応援してます', channelId: 'UC_carol', timestamp: NOW - 500 },
        ]),
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('空文字列は none', () => {
      const r = detectSpam(msg(''), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'none' });
    });
  });

  // ─── rapid_fire: 連投 ───────────────────────────────────────
  describe('rapid_fire', () => {
    it('10秒以内に他の発言が2件あれば rapid_fire', () => {
      const r = detectSpam(
        msg('3つめの発言', NOW),
        userHist([
          { text: '1つめ', timestamp: NOW - 8000 },
          { text: '2つめ', timestamp: NOW - 4000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'rapid_fire', confidence: 0.9 });
    });

    it('10秒以内3件あれば rapid_fire', () => {
      const r = detectSpam(
        msg('4つめの発言', NOW),
        userHist([
          { text: '1つめ', timestamp: NOW - 9000 },
          { text: '2つめ', timestamp: NOW - 6000 },
          { text: '3つめ', timestamp: NOW - 3000 },
        ]),
        emptyChat,
      );
      expect(r.type).toBe('rapid_fire');
    });

    it('1件だけなら rapid_fire にならない', () => {
      const r = detectSpam(
        msg('2つめの発言', NOW),
        userHist([{ text: '1つめ', timestamp: NOW - 3000 }]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('10秒超の発言は rapid_fire のカウントに入らない', () => {
      const r = detectSpam(
        msg('現在の発言', NOW),
        userHist([
          { text: '昔の発言1', timestamp: NOW - 20_000 },
          { text: '昔の発言2', timestamp: NOW - 15_000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });
  });

  // ─── self_copy_paste: 自己コピペ ────────────────────────────
  describe('self_copy_paste', () => {
    it('同一ユーザーが過去に同じ文言を投稿していたら self_copy_paste', () => {
      const r = detectSpam(
        msg('チャンネル登録お願いします', NOW),
        userHist([
          {
            text: 'チャンネル登録お願いします',
            timestamp: NOW - 60_000,
          },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'self_copy_paste', confidence: 0.95 });
    });

    it('複数回投稿していたら self_copy_paste', () => {
      const r = detectSpam(
        msg('宣伝です', NOW),
        userHist([
          { text: '宣伝です', timestamp: NOW - 100_000 },
          { text: '宣伝です', timestamp: NOW - 50_000 },
        ]),
        emptyChat,
      );
      expect(r.type).toBe('self_copy_paste');
    });

    it('text が完全一致でないと self_copy_paste にはならない', () => {
      const r = detectSpam(
        msg('応援してます！', NOW),
        userHist([{ text: '応援してます', timestamp: NOW - 60_000 }]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });
  });

  // ─── 優先順位検証 ──────────────────────────────────────────
  describe('優先順位', () => {
    it('連投条件 + 自己コピペ条件を同時に満たすと rapid_fire が優先', () => {
      // 10秒以内に他の発言が2件 + 過去に同一文言あり → rapid_fire が先に判定
      const r = detectSpam(
        msg('スパム', NOW),
        userHist([
          { text: '別1', timestamp: NOW - 5000 },
          { text: '別2', timestamp: NOW - 3000 },
          { text: 'スパム', timestamp: NOW - 60_000 }, // 自己コピペ材料
        ]),
        emptyChat,
      );
      expect(r.type).toBe('rapid_fire');
    });
  });

  // ─── coordinated_copy_paste: 横断コピペ ─────────────────────
  describe('coordinated_copy_paste', () => {
    it('別アカウント3人が同一文言なら coordinated_copy_paste', () => {
      const r = detectSpam(
        msg('お祭り騒ぎ！', NOW),
        emptyUser,
        chatHist([
          { text: 'お祭り騒ぎ！', channelId: 'UC_bob', timestamp: NOW - 3000 },
          { text: 'お祭り騒ぎ！', channelId: 'UC_carol', timestamp: NOW - 2000 },
          { text: 'お祭り騒ぎ！', channelId: 'UC_dave', timestamp: NOW - 1000 },
        ]),
      );
      expect(r).toEqual({ type: 'coordinated_copy_paste', confidence: 0.85 });
    });

    it('同一アカウントが3回投稿しても coordinated_copy_paste にはならない', () => {
      const r = detectSpam(
        msg('もう一度', NOW),
        emptyUser,
        chatHist([
          { text: 'もう一度', channelId: 'UC_bob', timestamp: NOW - 3000 },
          { text: 'もう一度', channelId: 'UC_bob', timestamp: NOW - 2000 },
          { text: 'もう一度', channelId: 'UC_bob', timestamp: NOW - 1000 },
        ]),
      );
      // 別アカウント数は 1 だけ → 3未満で発火しない
      expect(r).toEqual({ type: 'none' });
    });

    it('投稿者自身のチャンネルからの発言は coordinated_copy_paste のカウントに入らない', () => {
      const r = detectSpam(
        msg('応援', NOW),
        emptyUser,
        chatHist([
          { text: '応援', channelId: 'UC_alice', timestamp: NOW - 3000 },
          { text: '応援', channelId: 'UC_bob', timestamp: NOW - 2000 },
          { text: '応援', channelId: 'UC_carol', timestamp: NOW - 1000 },
        ]),
      );
      // UC_alice は除外、別アカウントは2 → 3未満
      expect(r).toEqual({ type: 'none' });
    });
  });

  // ─── character_repeat: 文字連打 ─────────────────────────────
  describe('character_repeat', () => {
    it('「あ」×10 は character_repeat', () => {
      const r = detectSpam(msg('あ'.repeat(10)), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'character_repeat', confidence: 0.95 });
    });

    it('「あ」×20 も character_repeat', () => {
      const r = detectSpam(msg('あ'.repeat(20)), emptyUser, emptyChat);
      expect(r.type).toBe('character_repeat');
    });

    it('「あ」×9 は character_repeat にならない（しきい値10）', () => {
      const r = detectSpam(msg('あ'.repeat(9)), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'none' });
    });

    it('部分的に同一文字が並ぶ（「おはよう！ああああああああああ」）は対象外', () => {
      // 全体一致パターンなので、これは character_repeat にはならない
      const r = detectSpam(
        msg('おはよう！あああああああああ'),
        emptyUser,
        emptyChat,
      );
      expect(r.type).toBe('none');
    });

    it('絵文字（サロゲートペア）の連打も検出する', () => {
      // 😊 はサロゲートペア。Array.from で1コードポイントとして扱われる
      const text = '😊'.repeat(10);
      const r = detectSpam(msg(text), emptyUser, emptyChat);
      expect(r.type).toBe('character_repeat');
    });
  });

  // ─── url_spam: URL 羅列 ─────────────────────────────────────
  describe('url_spam', () => {
    it('URL が3つあれば url_spam', () => {
      const r = detectSpam(
        msg('https://a.com https://b.com https://c.com'),
        emptyUser,
        emptyChat,
      );
      expect(r).toEqual({ type: 'url_spam', confidence: 0.9 });
    });

    it('URL が4つあっても url_spam', () => {
      const r = detectSpam(
        msg('https://a.com https://b.com https://c.com https://d.com'),
        emptyUser,
        emptyChat,
      );
      expect(r.type).toBe('url_spam');
    });

    it('http のみ（https なし）でも url_spam', () => {
      const r = detectSpam(
        msg('http://a.com http://b.com http://c.com'),
        emptyUser,
        emptyChat,
      );
      expect(r.type).toBe('url_spam');
    });

    it('URLっぽくない文字列（example.com）は url_spam にならない', () => {
      const r = detectSpam(
        msg('example.com と sample.com と test.com を見比べてください'),
        emptyUser,
        emptyChat,
      );
      // プロトコル無しの「.com」はマッチさせていない
      expect(r).toEqual({ type: 'none' });
    });
  });

  // ─── emoji_spam: 絵文字スパム ──────────────────────────────
  describe('emoji_spam', () => {
    it('絵文字 25 個（長さ・比率ともに条件超え）は emoji_spam', () => {
      const r = detectSpam(msg('🎉'.repeat(25)), emptyUser, emptyChat);
      // 全部同一絵文字なので character_repeat が先に発火する
      // → これを emoji_spam として確認するには異なる絵文字を混ぜる
      expect(r.type).toBe('character_repeat');
    });

    it('複数種類の絵文字を多用すると emoji_spam', () => {
      // 5 種類 × 5 = 25 コードポイント、すべて絵文字
      const r = detectSpam(
        msg('🎉🎊🎈🎁🎂'.repeat(5)),
        emptyUser,
        emptyChat,
      );
      expect(r).toEqual({ type: 'emoji_spam', confidence: 0.8 });
    });

    it('短い絵文字列（10文字程度）は emoji_spam にならない', () => {
      const r = detectSpam(msg('🎉🎊🎈🎁🎂🎉🎊🎈🎁'), emptyUser, emptyChat);
      // EMOJI_SPAM_MIN_LENGTH = 20 超え必須
      expect(r.type).toBe('none');
    });

    it('日本語＋絵文字混在で日本語が多めなら emoji_spam にならない', () => {
      const r = detectSpam(
        msg('今日の配信本当に楽しかったです、ありがとうございました🎉🎊'),
        emptyUser,
        emptyChat,
      );
      expect(r.type).toBe('none');
    });
  });

  // ─── しきい値定数の公開 ────────────────────────────────────
  describe('SPAM_DETECTION_THRESHOLDS', () => {
    it('しきい値が外部から参照可能', () => {
      expect(SPAM_DETECTION_THRESHOLDS.RAPID_FIRE_WINDOW_MS).toBe(10_000);
      expect(SPAM_DETECTION_THRESHOLDS.RAPID_FIRE_THRESHOLD).toBe(2);
      expect(SPAM_DETECTION_THRESHOLDS.COORDINATED_THRESHOLD).toBe(3);
      expect(SPAM_DETECTION_THRESHOLDS.CHARACTER_REPEAT_MIN_LENGTH).toBe(10);
      expect(SPAM_DETECTION_THRESHOLDS.URL_SPAM_THRESHOLD).toBe(3);
      expect(SPAM_DETECTION_THRESHOLDS.EMOJI_SPAM_RATIO).toBe(0.8);
      expect(SPAM_DETECTION_THRESHOLDS.EMOJI_SPAM_MIN_LENGTH).toBe(20);
    });
  });
});
