/**
 * Stage2Batcher テスト。
 *
 * 時間制御は vi.useFakeTimers() でモック化し、200msウィンドウや 20件上限の
 * 動作を決定的に検証する。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Stage2Batcher } from '../../src/stage2/batcher.js';
import { JudgmentCache, createMemoryStorage } from '../../src/stage2/cache.js';
import { createMockTransport, createFailingTransport } from '../../src/stage2/api-client.js';
import type {
  Message,
  JudgmentContext,
  Judgment,
  JudgeRequestPayload,
  JudgeResponsePayload,
} from '../../src/types.js';
import type { FilterSettings, GameContext } from '@fresh-chat-keeper/shared';

const SETTINGS: FilterSettings = {
  version: 3,
  enabled: true,
  displayMode: 'placeholder',
  filterMode: 'archive',
  categories: { spoiler: { enabled: true, strength: 'standard' } },
  customBlockWords: [],
  userTier: 'free',
};

function buildContext(game?: Partial<GameContext>): JudgmentContext {
  return {
    settings: SETTINGS,
    game: game ? { progressType: 'none', ...game } : undefined,
  };
}

function buildMessage(text: string, id = `m_${Math.random().toString(36).slice(2, 8)}`): Message {
  return {
    id,
    text,
    authorChannelId: 'UC',
    authorDisplayName: 'tester',
    timestamp: 1_700_000_000_000,
  };
}

/** id -> verdict のマップで応答するハンドラを作成 */
function respondWith(map: Record<string, 'allow' | 'block'>): (p: JudgeRequestPayload) => JudgeResponsePayload {
  return (p) => ({
    results: p.messages.map((m) => ({
      messageId: m.id,
      verdict: map[m.id] ?? 'allow',
      stage: 2,
      confidence: 0.9,
    })),
  });
}

describe('Stage2Batcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('集約タイミング', () => {
    it('200ms ウィンドウ経過で1回まとめて送信される', async () => {
      const calls: JudgeRequestPayload[] = [];
      const transport = createMockTransport((p) => {
        calls.push(p);
        return respondWith({})(p);
      });

      const batcher = new Stage2Batcher({ transport, modelTier: 'free' });
      const ctx = buildContext({ gameId: 'g' });

      const p1 = batcher.enqueue(buildMessage('a', 'a'), ctx);
      const p2 = batcher.enqueue(buildMessage('b', 'b'), ctx);
      const p3 = batcher.enqueue(buildMessage('c', 'c'), ctx);

      // ウィンドウ未経過
      expect(calls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(200);

      const results = await Promise.all([p1, p2, p3]);
      expect(calls).toHaveLength(1);
      expect(calls[0].messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
      expect(results.every((r) => r.primary === 'safe')).toBe(true);
    });

    it('200ms 未満では送信されない', async () => {
      const calls: JudgeRequestPayload[] = [];
      const transport = createMockTransport((p) => {
        calls.push(p);
        return respondWith({})(p);
      });
      const batcher = new Stage2Batcher({ transport, modelTier: 'free' });
      const ctx = buildContext({ gameId: 'g' });

      void batcher.enqueue(buildMessage('a', 'a'), ctx);
      await vi.advanceTimersByTimeAsync(199);
      expect(calls).toHaveLength(0);
    });

    it('カスタム windowMs を尊重する', async () => {
      const calls: JudgeRequestPayload[] = [];
      const transport = createMockTransport((p) => {
        calls.push(p);
        return respondWith({})(p);
      });
      const batcher = new Stage2Batcher({ transport, modelTier: 'free', windowMs: 50 });
      const ctx = buildContext({ gameId: 'g' });

      const p = batcher.enqueue(buildMessage('a', 'a'), ctx);
      await vi.advanceTimersByTimeAsync(50);
      await p;
      expect(calls).toHaveLength(1);
    });
  });

  describe('最大バッチサイズ', () => {
    it('20件到達で即送信される（タイマー待たない）', async () => {
      const calls: JudgeRequestPayload[] = [];
      const transport = createMockTransport((p) => {
        calls.push(p);
        return respondWith({})(p);
      });
      const batcher = new Stage2Batcher({ transport, modelTier: 'free' });
      const ctx = buildContext({ gameId: 'g' });

      const promises: Promise<Judgment>[] = [];
      for (let i = 0; i < 20; i++) {
        promises.push(batcher.enqueue(buildMessage('x', `id${i}`), ctx));
      }

      // タイマーを進めずに resolve できる（即送信されているため）
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(promises);

      expect(calls).toHaveLength(1);
      expect(calls[0].messages).toHaveLength(20);
    });

    it('カスタム maxBatch を尊重する（5件で送信）', async () => {
      const calls: JudgeRequestPayload[] = [];
      const transport = createMockTransport((p) => {
        calls.push(p);
        return respondWith({})(p);
      });
      const batcher = new Stage2Batcher({ transport, modelTier: 'free', maxBatch: 5 });
      const ctx = buildContext({ gameId: 'g' });

      const promises: Promise<Judgment>[] = [];
      for (let i = 0; i < 5; i++) {
        promises.push(batcher.enqueue(buildMessage('x', `id${i}`), ctx));
      }
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(promises);
      expect(calls).toHaveLength(1);
      expect(calls[0].messages).toHaveLength(5);
    });
  });

  describe('コンテキストグループ化', () => {
    it('異なる gameId は別バッチになる', async () => {
      const calls: JudgeRequestPayload[] = [];
      const transport = createMockTransport((p) => {
        calls.push(p);
        return respondWith({})(p);
      });
      const batcher = new Stage2Batcher({ transport, modelTier: 'free' });

      const ctxA = buildContext({ gameId: 'gA' });
      const ctxB = buildContext({ gameId: 'gB' });

      const p1 = batcher.enqueue(buildMessage('m', 'a1'), ctxA);
      const p2 = batcher.enqueue(buildMessage('m', 'b1'), ctxB);
      const p3 = batcher.enqueue(buildMessage('m', 'a2'), ctxA);

      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([p1, p2, p3]);

      expect(calls).toHaveLength(2);
      const sizes = calls.map((c) => c.messages.length).sort();
      expect(sizes).toEqual([1, 2]); // gA: 2件、gB: 1件
    });

    it('event progress の順序差は同一バッチに統合される', async () => {
      const calls: JudgeRequestPayload[] = [];
      const transport = createMockTransport((p) => {
        calls.push(p);
        return respondWith({})(p);
      });
      const batcher = new Stage2Batcher({ transport, modelTier: 'free' });

      const ctxA = buildContext({
        gameId: 'g',
        progressType: 'event',
        completedEvents: ['e1', 'e2'],
      });
      const ctxB = buildContext({
        gameId: 'g',
        progressType: 'event',
        completedEvents: ['e2', 'e1'], // 同じ集合、順序違い
      });

      const p1 = batcher.enqueue(buildMessage('m', 'a'), ctxA);
      const p2 = batcher.enqueue(buildMessage('m', 'b'), ctxB);
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([p1, p2]);

      expect(calls).toHaveLength(1);
      expect(calls[0].messages).toHaveLength(2);
    });
  });

  describe('キャッシュ統合', () => {
    it('キャッシュヒットしたメッセージはバッチに含めず即返却', async () => {
      const calls: JudgeRequestPayload[] = [];
      const transport = createMockTransport((p) => {
        calls.push(p);
        return respondWith({})(p);
      });
      const cache = new JudgmentCache({ storage: createMemoryStorage() });
      const ctx = buildContext({ gameId: 'g' });

      // 事前に1件キャッシュ
      const cachedJudgment: Judgment = {
        messageId: 'precached',
        labels: ['safe'],
        primary: 'safe',
        confidence: 1.0,
        stage: 'stage2',
        fromCache: false,
      };
      await cache.set('cachedText', ctx, cachedJudgment);

      const batcher = new Stage2Batcher({ transport, cache, modelTier: 'free' });

      // キャッシュヒット
      const hitPromise = batcher.enqueue(buildMessage('cachedText', 'hit'), ctx);
      // 通常メッセージ
      const newPromise = batcher.enqueue(buildMessage('newText', 'new'), ctx);

      // hit はタイマー進めなくても resolve
      const hitResult = await hitPromise;
      expect(hitResult.fromCache).toBe(true);
      expect(hitResult.messageId).toBe('hit');

      await vi.advanceTimersByTimeAsync(200);
      const newResult = await newPromise;

      expect(calls).toHaveLength(1);
      expect(calls[0].messages.map((m) => m.id)).toEqual(['new']);
      expect(newResult.fromCache).toBe(false);
    });

    it('Transport の判定結果がキャッシュに保存される', async () => {
      const transport = createMockTransport((p) =>
        respondWith({ x: 'block' })(p),
      );
      const cache = new JudgmentCache({ storage: createMemoryStorage() });
      const batcher = new Stage2Batcher({ transport, cache, modelTier: 'free' });
      const ctx = buildContext({ gameId: 'g' });

      const p = batcher.enqueue(buildMessage('text-x', 'x'), ctx);
      await vi.advanceTimersByTimeAsync(200);
      await p;

      // 別 messageId で同じテキスト → キャッシュヒット
      const p2 = batcher.enqueue(buildMessage('text-x', 'x2'), ctx);
      const result = await p2; // タイマー不要
      expect(result.fromCache).toBe(true);
      expect(result.messageId).toBe('x2');
    });
  });

  describe('エラー伝播', () => {
    it('Transport が reject したら同バッチの全 pending が reject', async () => {
      const transport = createFailingTransport(new Error('502'));
      const batcher = new Stage2Batcher({ transport, modelTier: 'free' });
      const ctx = buildContext({ gameId: 'g' });

      const p1 = batcher.enqueue(buildMessage('a', 'a'), ctx);
      const p2 = batcher.enqueue(buildMessage('b', 'b'), ctx);
      // 早めに catch を attach して unhandled rejection を防ぐ
      const safe1 = p1.catch((e) => e);
      const safe2 = p2.catch((e) => e);

      await vi.advanceTimersByTimeAsync(200);

      const [r1, r2] = await Promise.all([safe1, safe2]);
      expect(r1).toBeInstanceOf(Error);
      expect((r1 as Error).message).toBe('502');
      expect(r2).toBeInstanceOf(Error);
      expect((r2 as Error).message).toBe('502');
    });

    it('レスポンスに該当 messageId が無いと当該 pending のみ reject', async () => {
      // 1件目だけ返して2件目は省略
      const transport = createMockTransport((p) => ({
        results: [{
          messageId: p.messages[0].id,
          verdict: 'allow',
          stage: 2,
        }],
      }));
      const batcher = new Stage2Batcher({ transport, modelTier: 'free' });
      const ctx = buildContext({ gameId: 'g' });

      const p1 = batcher.enqueue(buildMessage('a', 'a'), ctx);
      const p2 = batcher.enqueue(buildMessage('b', 'b'), ctx);
      // 早めに catch を attach
      const safe1 = p1.then((j) => j, (e) => e);
      const safe2 = p2.then((j) => j, (e) => e);

      await vi.advanceTimersByTimeAsync(200);

      const [r1, r2] = await Promise.all([safe1, safe2]);
      expect(r1).toMatchObject({ messageId: 'a', primary: 'safe' });
      expect(r2).toBeInstanceOf(Error);
      expect((r2 as Error).message).toContain('No judgment returned');
    });
  });

  describe('順序保持', () => {
    it('同期的に複数 enqueue した順序がペイロードに保持される', async () => {
      const calls: JudgeRequestPayload[] = [];
      const transport = createMockTransport((p) => {
        calls.push(p);
        // 入力順を保ったまま全 allow を返す（reject にならないように）
        return {
          results: p.messages.map((m) => ({
            messageId: m.id,
            verdict: 'allow' as const,
            stage: 2 as const,
          })),
        };
      });
      const batcher = new Stage2Batcher({ transport, modelTier: 'free' });
      const ctx = buildContext({ gameId: 'g' });

      const ids = ['z', 'a', 'm', 'b'];
      const promises = ids.map((id) => batcher.enqueue(buildMessage(`text-${id}`, id), ctx));
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all(promises);

      expect(calls).toHaveLength(1);
      expect(calls[0].messages.map((m) => m.id)).toEqual(ids);
    });
  });
});
