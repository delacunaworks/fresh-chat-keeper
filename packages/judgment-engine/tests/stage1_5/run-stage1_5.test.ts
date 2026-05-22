/**
 * runStage1_5 統合テスト。
 *
 * 検証観点:
 * - 履歴ストアとの統合（getUserHistory / getChatHistory / addMessage 副作用）
 * - settings.categories.spam.enabled の参照
 * - spam OFF / 未設定時に gray を返すこと（フィルタが発火しない）
 * - 履歴に積むタイミング（判定の後）
 * - 信頼度しきい値（0.8 未満は filter にしない）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  runStage1_5,
  HistoryStore,
} from '../../src/stage1_5/index.js';
import type { Message, JudgmentContext } from '../../src/types.js';
import type { FilterSettings } from '@fresh-chat-keeper/shared';

const BASE_TS = 1_700_000_000_000;

function buildSettings(spamEnabled: boolean | undefined): FilterSettings {
  const categories: FilterSettings['categories'] = {
    spoiler: { enabled: true, strength: 'standard' },
  };
  if (spamEnabled !== undefined) {
    categories.spam = { enabled: spamEnabled };
  }
  return {
    version: 3,
    enabled: true,
    displayMode: 'placeholder',
    filterMode: 'live',
    categories,
    customBlockWords: [],
    userTier: 'free',
  };
}

function buildContext(spamEnabled: boolean | undefined): JudgmentContext {
  return { settings: buildSettings(spamEnabled) };
}

function buildMessage(
  text: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id: 'm1',
    text,
    authorChannelId: 'UC_alice',
    authorDisplayName: 'alice',
    timestamp: BASE_TS,
    ...overrides,
  };
}

describe('runStage1_5', () => {
  let store: HistoryStore;
  beforeEach(() => {
    store = new HistoryStore();
  });

  describe('gray パス（明らかなスパム以外）', () => {
    it('履歴なしの普通のコメントは gray', () => {
      const r = runStage1_5(buildMessage('かわいい'), buildContext(true), store);
      expect(r).toEqual({ outcome: 'gray', reason: 'needs_stage2' });
    });

    it('gray を返した後、メッセージは履歴に積まれる', () => {
      runStage1_5(buildMessage('hi', { text: 'hi' }), buildContext(true), store);
      const hist = store.getUserHistory('UC_alice', BASE_TS);
      expect(hist.messages.map((m) => m.text)).toEqual(['hi']);
    });
  });

  describe('spam OFF 動作', () => {
    // B5-fix: character_repeat 撤去のため、スパム条件は url_spam で確実発火させる
    const URL_SPAM = 'https://a.com https://b.com https://c.com';

    it('spam.enabled = false なら、スパム条件を満たしても gray', () => {
      const r = runStage1_5(buildMessage(URL_SPAM), buildContext(false), store);
      expect(r.outcome).toBe('gray');
    });

    it('categories.spam 未設定（v2 既存ユーザー）でも gray（フェイルクローズド）', () => {
      const r = runStage1_5(
        buildMessage(URL_SPAM),
        buildContext(undefined),
        store,
      );
      expect(r.outcome).toBe('gray');
    });

    it('spam OFF でも履歴は更新される', () => {
      runStage1_5(buildMessage(URL_SPAM), buildContext(false), store);
      const stats = store.getStats();
      expect(stats.chatMessageCount).toBe(1);
    });
  });

  describe('spam ON でフィルタ発火', () => {
    it('URL 3つ羅列は filter', () => {
      const r = runStage1_5(
        buildMessage('https://a.com https://b.com https://c.com'),
        buildContext(true),
        store,
      );
      expect(r.outcome).toBe('filter');
      if (r.outcome === 'filter') {
        expect(r.label).toBe('spam');
        expect(r.reason).toBe('url_spam');
      }
    });

    it('連投検出（rapid_fire）も filter', () => {
      // B5-fix: 短文（≤6）は rapid_fire 対象外なので 7+ 文字の文言で検証する
      // 1件目: gray、履歴に積まれる
      runStage1_5(
        buildMessage('1つめの発言です', { text: '1つめの発言です', timestamp: BASE_TS - 5000 }),
        buildContext(true),
        store,
      );
      // 2件目: 履歴1件しかないので gray
      runStage1_5(
        buildMessage('2つめの発言です', { text: '2つめの発言です', timestamp: BASE_TS - 2000 }),
        buildContext(true),
        store,
      );
      // 3件目: 履歴に2件あり、10秒以内、別文言 → rapid_fire 発火
      const r = runStage1_5(
        buildMessage('3つめの発言です', { text: '3つめの発言です', timestamp: BASE_TS }),
        buildContext(true),
        store,
      );
      expect(r.outcome).toBe('filter');
      if (r.outcome === 'filter') {
        expect(r.reason).toBe('rapid_fire');
      }
    });
  });

  describe('履歴の積むタイミング', () => {
    it('自己コピペ検出のため、判定対象は判定後に積まれる（B6b: 連続 3 回で発火）', () => {
      // 同一文言を 3 回連続。1・2 件目は連続 3 未満で gray、3 件目で発火。
      // 判定が「履歴追加前」に行われる不変条件を担保する。
      const r1 = runStage1_5(
        buildMessage('宣伝です', { text: '宣伝です', timestamp: BASE_TS - 20_000 }),
        buildContext(true),
        store,
      );
      expect(r1.outcome).toBe('gray'); // 履歴空 → 連続 0
      const r2 = runStage1_5(
        buildMessage('宣伝です', { text: '宣伝です', timestamp: BASE_TS - 10_000 }),
        buildContext(true),
        store,
      );
      expect(r2.outcome).toBe('gray'); // 連続 1（履歴 1 件）→ 2 未満
      const r3 = runStage1_5(
        buildMessage('宣伝です', { text: '宣伝です', timestamp: BASE_TS }),
        buildContext(true),
        store,
      );
      expect(r3.outcome).toBe('filter'); // 連続 2（履歴 2 件連続）→ 発火
      if (r3.outcome === 'filter') {
        expect(r3.reason).toBe('self_copy_paste');
      }
    });
  });

  describe('横断履歴の利用（B6a: coordinated 撤去 → gray）', () => {
    it('別ユーザー3人の同一文言（長文・7字超定番含む）でも filter せず gray（Stage 2 委譲）', () => {
      // B6a: coordinated_copy_paste 撤去。コール&レスポンス／定番リアクションと
      // 協調スパムは文脈依存なので Stage 1.5 で確定せず Stage 2 LLM に委ねる
      const COPY = 'おつかれさまでした'; // 9 codepoints（7字超の定番挨拶）
      const t = BASE_TS - 3000;
      // 別ユーザーが先に同一文言を投稿
      runStage1_5(
        buildMessage(COPY, {
          text: COPY,
          authorChannelId: 'UC_bob',
          timestamp: t,
        }),
        buildContext(true),
        store,
      );
      runStage1_5(
        buildMessage(COPY, {
          text: COPY,
          authorChannelId: 'UC_carol',
          timestamp: t + 1000,
        }),
        buildContext(true),
        store,
      );
      runStage1_5(
        buildMessage(COPY, {
          text: COPY,
          authorChannelId: 'UC_dave',
          timestamp: t + 2000,
        }),
        buildContext(true),
        store,
      );
      // alice が同じ文言を流す → coordinated 撤去後は filter せず gray
      const r = runStage1_5(
        buildMessage(COPY, { text: COPY, timestamp: BASE_TS }),
        buildContext(true),
        store,
      );
      expect(r).toEqual({ outcome: 'gray', reason: 'needs_stage2' });
    });

    it('同一ユーザーの連続 3 回 self_copy_paste は横断履歴があっても filter', () => {
      const COPY = 'チャンネル登録お願いします';
      // alice 自身が連続 2 回（self_copy_paste の連続材料）
      runStage1_5(
        buildMessage(COPY, { text: COPY, timestamp: BASE_TS - 60_000 }),
        buildContext(true),
        store,
      );
      runStage1_5(
        buildMessage(COPY, { text: COPY, timestamp: BASE_TS - 30_000 }),
        buildContext(true),
        store,
      );
      // 別ユーザーも同一文言（旧 coordinated 材料、撤去後は影響しない。
      // alice の連続カウントは別 channelId なので途切れない）
      runStage1_5(
        buildMessage(COPY, {
          text: COPY,
          authorChannelId: 'UC_bob',
          timestamp: BASE_TS - 3000,
        }),
        buildContext(true),
        store,
      );
      const r = runStage1_5(
        buildMessage(COPY, { text: COPY, timestamp: BASE_TS }),
        buildContext(true),
        store,
      );
      expect(r.outcome).toBe('filter');
      if (r.outcome === 'filter') {
        expect(r.reason).toBe('self_copy_paste');
      }
    });
  });
});
