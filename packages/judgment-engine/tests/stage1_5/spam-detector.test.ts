/**
 * detectSpam の単体テスト。
 *
 * 検証観点:
 * - 4 パターン（rapid_fire / self_copy_paste / url_spam / emoji_spam）
 *   それぞれが検出される
 * - B5-fix: character_repeat は Stage 1.5 から撤去（gray→Stage 2 委譲）
 * - B6a: coordinated_copy_paste は Stage 1.5 から撤去（gray→Stage 2 委譲。
 *   コール&レスポンス／定番リアクションと協調スパムは文脈依存）
 * - B5-fix: 短文（≤6 コードポイント）は rapid_fire の対象外
 *   （定番リアクション「ざわざわ」「うおお」「草」「888」保護）。
 *   self_copy_paste / url_spam / emoji_spam は短文でも維持
 * - 正当なコメントを誤検出しない（false-positive 抑制）
 * - 評価順の優先度（連投が自己コピペより先に判定される 等）
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
        msg('面白かったです', NOW),
        userHist([{ text: 'よかったです', timestamp: NOW - 60_000 }]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('「888」は短文なので連投/横断に巻き込まれず none', () => {
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

    it('空文字列は none', () => {
      const r = detectSpam(msg(''), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'none' });
    });
  });

  // ─── B5-fix: 短文リアクション保護 ───────────────────────────────
  describe('短文リアクション保護（B5-fix）', () => {
    it('「ざわざわ」を連投しても rapid_fire にならない（短文除外）', () => {
      const r = detectSpam(
        msg('ざわざわ', NOW),
        userHist([
          { text: 'うおお', timestamp: NOW - 6000 },
          { text: 'すごい', timestamp: NOW - 3000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('「草」を別アカ3人が同時刻に流しても none（coordinated 撤去 B6a）', () => {
      const r = detectSpam(
        msg('草', NOW),
        emptyUser,
        chatHist([
          { text: '草', channelId: 'UC_b', timestamp: NOW - 3000 },
          { text: '草', channelId: 'UC_c', timestamp: NOW - 2000 },
          { text: '草', channelId: 'UC_d', timestamp: NOW - 1000 },
        ]),
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('「888」連投も rapid_fire にならない（短文除外）', () => {
      const r = detectSpam(
        msg('888', NOW),
        userHist([
          { text: '88', timestamp: NOW - 5000 },
          { text: '8888', timestamp: NOW - 2000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('短文でも self_copy_paste は維持（同一短文 連続 3 回）', () => {
      const r = detectSpam(
        msg('宣伝', NOW),
        userHist([
          { text: '宣伝', timestamp: NOW - 60_000 },
          { text: '宣伝', timestamp: NOW - 30_000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'self_copy_paste', confidence: 0.95 });
    });

    it('境界: 7 コードポイントは短文でない → rapid_fire 発火', () => {
      // SHORT_TEXT_MAX_CODEPOINTS=6 なので 7 文字は対象
      const r = detectSpam(
        msg('あいうえおかき', NOW), // 7 codepoints
        userHist([
          { text: '別1', timestamp: NOW - 6000 },
          { text: '別2', timestamp: NOW - 3000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'rapid_fire', confidence: 0.9 });
    });
  });

  // ─── B5-fix: character_repeat 撤去（Stage 2 委譲）───────────────
  describe('character_repeat 撤去（B5-fix）', () => {
    it('「あ」×15 は spam にならず none（Stage 2 LLM へ委譲）', () => {
      const r = detectSpam(msg('あ'.repeat(15)), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'none' });
    });

    it('「うおおおお」（叫び）は none', () => {
      const r = detectSpam(msg('うおおおお'), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'none' });
    });

    it('絵文字連打（😊×10、旧 character_repeat）も none（emoji_spam 長未満）', () => {
      const r = detectSpam(msg('😊'.repeat(10)), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'none' });
    });
  });

  // ─── rapid_fire: 連投 ───────────────────────────────────────
  describe('rapid_fire', () => {
    it('10秒以内に他の発言が2件あれば rapid_fire（長文）', () => {
      const r = detectSpam(
        msg('これは3つめの発言です', NOW),
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
        msg('これは4つめの発言です', NOW),
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
        msg('これは2つめの発言です', NOW),
        userHist([{ text: '1つめ', timestamp: NOW - 3000 }]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('10秒超の発言は rapid_fire のカウントに入らない', () => {
      const r = detectSpam(
        msg('これは現在の発言です', NOW),
        userHist([
          { text: '昔の発言1', timestamp: NOW - 20_000 },
          { text: '昔の発言2', timestamp: NOW - 15_000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });
  });

  // ─── self_copy_paste: 連続自己コピペ（B6b: 連続 3 回以上）─────
  describe('self_copy_paste（連続 3 回以上、B6b）', () => {
    it('連続 2 回（履歴に同一 1 件）は通る＝none', () => {
      // 「あじまるあじまる」コールで "あじまる" を誤送信→再送信した
      // 連続 2 回ケースを誤検出しないこと
      const r = detectSpam(
        msg('あじまる', NOW),
        userHist([{ text: 'あじまる', timestamp: NOW - 5000 }]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('連続 3 回（履歴に同一が連続 2 件）はブロック', () => {
      const r = detectSpam(
        msg('チャンネル登録お願いします', NOW),
        userHist([
          { text: 'チャンネル登録お願いします', timestamp: NOW - 60_000 },
          { text: 'チャンネル登録お願いします', timestamp: NOW - 30_000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'self_copy_paste', confidence: 0.95 });
    });

    it('連続 4 回以上もブロック', () => {
      const r = detectSpam(
        msg('宣伝です', NOW),
        userHist([
          { text: '宣伝です', timestamp: NOW - 100_000 },
          { text: '宣伝です', timestamp: NOW - 80_000 },
          { text: '宣伝です', timestamp: NOW - 50_000 },
        ]),
        emptyChat,
      );
      expect(r.type).toBe('self_copy_paste');
    });

    it('「同一 2 → 別 → 同一 2」は連続が途切れているので通る＝none', () => {
      // 履歴 [A,A,B,A] + 今回 A → 末尾から A(1), B で連続終了 → 連続 1 < 2
      const r = detectSpam(
        msg('A', NOW),
        userHist([
          { text: 'A', timestamp: NOW - 50_000 },
          { text: 'A', timestamp: NOW - 40_000 },
          { text: 'B', timestamp: NOW - 30_000 },
          { text: 'A', timestamp: NOW - 10_000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('非連続で計 3 回（[A,B,A]+A）も連続でないので通る＝none', () => {
      const r = detectSpam(
        msg('A', NOW),
        userHist([
          { text: 'A', timestamp: NOW - 50_000 },
          { text: 'B', timestamp: NOW - 30_000 },
          { text: 'A', timestamp: NOW - 10_000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('時間差が大きくても連続 3 回ならブロック（時間は不問）', () => {
      const r = detectSpam(
        msg('同じ宣伝文', NOW),
        userHist([
          { text: '同じ宣伝文', timestamp: NOW - 250_000 },
          { text: '同じ宣伝文', timestamp: NOW - 120_000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'self_copy_paste', confidence: 0.95 });
    });

    it('text が完全一致でないと self_copy_paste にはならない', () => {
      const r = detectSpam(
        msg('応援してます！', NOW),
        userHist([
          { text: '応援してます', timestamp: NOW - 60_000 },
          { text: '応援してます', timestamp: NOW - 30_000 },
        ]),
        emptyChat,
      );
      expect(r).toEqual({ type: 'none' });
    });
  });

  // ─── 優先順位検証 ──────────────────────────────────────────
  describe('優先順位', () => {
    it('連投条件 + 自己コピペ条件を同時に満たすと rapid_fire が優先', () => {
      // 長文（>6）。10秒以内に他の発言が2件 + 過去に同一文言あり → rapid_fire 優先
      const r = detectSpam(
        msg('これはスパムです', NOW),
        userHist([
          { text: '別の発言1', timestamp: NOW - 5000 },
          { text: '別の発言2', timestamp: NOW - 3000 },
          { text: 'これはスパムです', timestamp: NOW - 60_000 }, // 自己コピペ材料
        ]),
        emptyChat,
      );
      expect(r.type).toBe('rapid_fire');
    });
  });

  // ─── coordinated_copy_paste 撤去（B6a、Stage 2 委譲）─────────
  describe('coordinated_copy_paste 撤去（B6a）', () => {
    it('別アカウント3人が同一文言（長文）でも none（協調スパムは Stage 2 委譲）', () => {
      const r = detectSpam(
        msg('お祭り騒ぎだワッショイ', NOW),
        emptyUser,
        chatHist([
          { text: 'お祭り騒ぎだワッショイ', channelId: 'UC_bob', timestamp: NOW - 3000 },
          { text: 'お祭り騒ぎだワッショイ', channelId: 'UC_carol', timestamp: NOW - 2000 },
          { text: 'お祭り騒ぎだワッショイ', channelId: 'UC_dave', timestamp: NOW - 1000 },
        ]),
      );
      expect(r).toEqual({ type: 'none' });
    });

    it('7 文字超の定番リアクション（うぽつです/おつかれさまでした）も none', () => {
      const greeting = detectSpam(
        msg('おつかれさまでした', NOW),
        emptyUser,
        chatHist([
          { text: 'おつかれさまでした', channelId: 'UC_b', timestamp: NOW - 3000 },
          { text: 'おつかれさまでした', channelId: 'UC_c', timestamp: NOW - 2000 },
          { text: 'おつかれさまでした', channelId: 'UC_d', timestamp: NOW - 1000 },
          { text: 'おつかれさまでした', channelId: 'UC_e', timestamp: NOW - 500 },
        ]),
      );
      expect(greeting).toEqual({ type: 'none' });
    });

    it('coordinated 撤去後も同一ユーザーの連続 3 回 self_copy_paste は検出（横断履歴があっても）', () => {
      const r = detectSpam(
        msg('チャンネル登録よろしく', NOW),
        userHist([
          { text: 'チャンネル登録よろしく', timestamp: NOW - 60_000 },
          { text: 'チャンネル登録よろしく', timestamp: NOW - 30_000 },
        ]),
        chatHist([
          { text: 'チャンネル登録よろしく', channelId: 'UC_x', timestamp: NOW - 3000 },
          { text: 'チャンネル登録よろしく', channelId: 'UC_y', timestamp: NOW - 2000 },
          { text: 'チャンネル登録よろしく', channelId: 'UC_z', timestamp: NOW - 1000 },
        ]),
      );
      expect(r).toEqual({ type: 'self_copy_paste', confidence: 0.95 });
    });
  });

  // ─── url_spam: URL 羅列（短文でも維持）──────────────────────
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
      expect(r).toEqual({ type: 'none' });
    });
  });

  // ─── emoji_spam: 絵文字スパム ──────────────────────────────
  describe('emoji_spam', () => {
    it('同一絵文字 25 個（旧 character_repeat）は emoji_spam', () => {
      // character_repeat 撤去後は emoji_spam が拾う（長さ・比率とも条件超え）
      const r = detectSpam(msg('🎉'.repeat(25)), emptyUser, emptyChat);
      expect(r).toEqual({ type: 'emoji_spam', confidence: 0.8 });
    });

    it('複数種類の絵文字を多用すると emoji_spam', () => {
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
    it('しきい値が外部から参照可能（B6a で COORDINATED_THRESHOLD 撤去）', () => {
      expect(SPAM_DETECTION_THRESHOLDS.RAPID_FIRE_WINDOW_MS).toBe(10_000);
      expect(SPAM_DETECTION_THRESHOLDS.RAPID_FIRE_THRESHOLD).toBe(2);
      expect(SPAM_DETECTION_THRESHOLDS.URL_SPAM_THRESHOLD).toBe(3);
      expect(SPAM_DETECTION_THRESHOLDS.EMOJI_SPAM_RATIO).toBe(0.8);
      expect(SPAM_DETECTION_THRESHOLDS.EMOJI_SPAM_MIN_LENGTH).toBe(20);
      expect(SPAM_DETECTION_THRESHOLDS.SHORT_TEXT_MAX_CODEPOINTS).toBe(6);
      const t = SPAM_DETECTION_THRESHOLDS as Record<string, unknown>;
      // B5-fix / B6a で撤去した定数は公開オブジェクトに存在しない
      expect(t.CHARACTER_REPEAT_MIN_LENGTH).toBeUndefined();
      expect(t.COORDINATED_THRESHOLD).toBeUndefined();
    });
  });
});
