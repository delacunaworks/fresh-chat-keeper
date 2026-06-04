import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  JudgmentCache,
  createMemoryStorage,
  type CacheStorage,
} from '../../src/stage2/cache.js';
import type { Judgment, JudgmentContext } from '../../src/types.js';
import type { FilterSettings, GameContext } from '@fresh-chat-keeper/shared';

// ─── テスト用ヘルパー ──────────────────────────────────────────────
function buildSettings(overrides?: Partial<FilterSettings>): FilterSettings {
  return {
    version: 3,
    enabled: true,
    displayMode: 'placeholder',
    filterMode: 'archive',
    categories: { spoiler: { enabled: true, strength: 'standard' } },
    customBlockWords: [],
    userTier: 'free',
    ...overrides,
  };
}

function buildContext(game?: Partial<GameContext>, settings?: Partial<FilterSettings>): JudgmentContext {
  return {
    settings: buildSettings(settings),
    game: game
      ? {
          progressType: 'none',
          ...game,
        }
      : undefined,
  };
}

function buildJudgment(messageId: string): Judgment {
  return {
    messageId,
    labels: ['spoiler'],
    primary: 'spoiler',
    confidence: 0.9,
    stage: 'stage2',
    fromCache: false,
  };
}

// ─── テスト本体 ──────────────────────────────────────────────────
describe('JudgmentCache', () => {
  let storage: CacheStorage;
  let cache: JudgmentCache;

  beforeEach(() => {
    storage = createMemoryStorage();
    cache = new JudgmentCache({ storage });
  });

  describe('基本動作', () => {
    it('保存していないキーは null を返す', async () => {
      const ctx = buildContext();
      expect(await cache.get('未保存テキスト', ctx)).toBeNull();
    });

    it('保存して取得すると同じ判定が返る（fromCache: true）', async () => {
      const ctx = buildContext();
      const judgment = buildJudgment('m1');
      await cache.set('対象テキスト', ctx, judgment);
      const got = await cache.get('対象テキスト', ctx);
      expect(got).not.toBeNull();
      expect(got?.messageId).toBe('m1');
      expect(got?.fromCache).toBe(true);
    });

    it('元の判定 fromCache が false でも取得時は true に書き換わる', async () => {
      const ctx = buildContext();
      const judgment = { ...buildJudgment('m1'), fromCache: false };
      await cache.set('text', ctx, judgment);
      const got = await cache.get('text', ctx);
      expect(got?.fromCache).toBe(true);
    });

    it('明示削除すると取得できなくなる', async () => {
      const ctx = buildContext();
      await cache.set('text', ctx, buildJudgment('m1'));
      await cache.delete('text', ctx);
      expect(await cache.get('text', ctx)).toBeNull();
    });
  });

  describe('キー構築（buildKey）', () => {
    it('同じテキスト・同じコンテキストなら同じキー', () => {
      const ctx = buildContext();
      expect(cache.buildKey('hello', ctx)).toBe(cache.buildKey('hello', ctx));
    });

    it('異なるテキストなら異なるキー', () => {
      const ctx = buildContext();
      expect(cache.buildKey('a', ctx)).not.toBe(cache.buildKey('b', ctx));
    });

    it('正規化により全角・半角の差異は同一キーになる', () => {
      const ctx = buildContext();
      expect(cache.buildKey('ＡＢＣ', ctx)).toBe(cache.buildKey('abc', ctx));
    });

    it('正規化により前後空白・連続空白の差異は同一キーになる', () => {
      const ctx = buildContext();
      expect(cache.buildKey('  hello   world  ', ctx)).toBe(cache.buildKey('hello world', ctx));
    });

    it('ゲームIDが異なるとキーが変わる', () => {
      const ctxA = buildContext({ gameId: 'gA' });
      const ctxB = buildContext({ gameId: 'gB' });
      expect(cache.buildKey('text', ctxA)).not.toBe(cache.buildKey('text', ctxB));
    });

    it('進行状況が異なるとキーが変わる', () => {
      const ctxA = buildContext({
        gameId: 'g',
        progressType: 'chapter',
        currentChapter: 'ch1',
      });
      const ctxB = buildContext({
        gameId: 'g',
        progressType: 'chapter',
        currentChapter: 'ch3',
      });
      expect(cache.buildKey('text', ctxA)).not.toBe(cache.buildKey('text', ctxB));
    });

    it('フィルタ強度が異なるとキーが変わる', () => {
      const ctxA = buildContext(undefined, {
        categories: { spoiler: { enabled: true, strength: 'standard' } },
      });
      const ctxB = buildContext(undefined, {
        categories: { spoiler: { enabled: true, strength: 'strict' } },
      });
      expect(cache.buildKey('text', ctxA)).not.toBe(cache.buildKey('text', ctxB));
    });

    it('event 進行モデルでは completedEvents の順序差を吸収する', () => {
      const ctxA = buildContext({
        gameId: 'g',
        progressType: 'event',
        completedEvents: ['e1', 'e2', 'e3'],
      });
      const ctxB = buildContext({
        gameId: 'g',
        progressType: 'event',
        completedEvents: ['e3', 'e1', 'e2'],
      });
      expect(cache.buildKey('text', ctxA)).toBe(cache.buildKey('text', ctxB));
    });
  });

  // ─── P5-B4a: 字幕シグネチャ + 後方互換 ─────────────────────────────
  describe('キー構築（buildKey）: captionSig（P5-B4a）', () => {
    it('後方互換: captionSig 省略 と "nocap" 明示はバイト一致', () => {
      const ctx = buildContext();
      expect(cache.buildKey('hello', ctx)).toBe(cache.buildKey('hello', ctx, 'nocap'));
    });

    it('後方互換: nocap キーは v0.5.0 形式（${contextHash}:${textHash}、コロン 1 個）', () => {
      const ctx = buildContext();
      const key = cache.buildKey('hello', ctx, 'nocap');
      // 字幕要素が挿入されていない = コロン区切りが 2 要素（contextHash:textHash）
      expect(key.split(':').length).toBe(2);
    });

    it('字幕あり（c2）は nocap と異なるキー', () => {
      const ctx = buildContext();
      expect(cache.buildKey('hello', ctx, 'c2')).not.toBe(cache.buildKey('hello', ctx, 'nocap'));
    });

    it('字幕あり: 同じ captionSig（c2）なら同じキー', () => {
      const ctx = buildContext();
      expect(cache.buildKey('hello', ctx, 'c2')).toBe(cache.buildKey('hello', ctx, 'c2'));
    });

    it('字幕あり: 異なる captionSig（c2 vs c3）で別キー', () => {
      const ctx = buildContext();
      expect(cache.buildKey('hello', ctx, 'c2')).not.toBe(cache.buildKey('hello', ctx, 'c3'));
    });

    it('字幕ありキーは contextHash:captionSig:textHash（コロン 2 個・c2 を含む）', () => {
      const ctx = buildContext();
      const key = cache.buildKey('hello', ctx, 'c2');
      expect(key.split(':').length).toBe(3);
      expect(key.split(':')[1]).toBe('c2');
    });

    it('get/set も captionSig を尊重（c2 で set → nocap で get は別キーで miss）', async () => {
      const ctx = buildContext();
      await cache.set('hello', ctx, buildJudgment('m1'), 'c2');
      expect(await cache.get('hello', ctx, 'c2')).not.toBeNull(); // 同 sig でヒット
      expect(await cache.get('hello', ctx, 'nocap')).toBeNull(); // 別 sig（既存キャッシュ）でミス
      expect(await cache.get('hello', ctx)).toBeNull(); // 省略=nocap でもミス
    });
  });

  describe('TTL（有効期限）', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('ttlMs 未指定なら期限切れにならない', async () => {
      const ctx = buildContext();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await cache.set('t', ctx, buildJudgment('m1'));
      // 1年進めても残っている
      vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
      expect(await cache.get('t', ctx)).not.toBeNull();
    });

    it('ttlMs 指定下、TTL 内は取得できる', async () => {
      cache = new JudgmentCache({ storage, ttlMs: 60_000 });
      const ctx = buildContext();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await cache.set('t', ctx, buildJudgment('m1'));
      vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
      expect(await cache.get('t', ctx)).not.toBeNull();
    });

    it('ttlMs 指定下、TTL 超過すると null かつ自動削除される', async () => {
      cache = new JudgmentCache({ storage, ttlMs: 60_000 });
      const ctx = buildContext();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await cache.set('t', ctx, buildJudgment('m1'));
      vi.setSystemTime(new Date('2026-01-01T00:02:00Z'));
      const result = await cache.get('t', ctx);
      expect(result).toBeNull();
      // 自動削除を確認するため、時間を戻して再 get でも null が返ること
      vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
      expect(await cache.get('t', ctx)).toBeNull();
    });
  });
});
