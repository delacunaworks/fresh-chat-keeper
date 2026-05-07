/**
 * proxy/src/index.ts の内部ヘルパー（リクエスト正規化）テスト。
 *
 * 旧形式・新形式の両方を統一表現に変換する `normalizeRequest` の挙動を保護する。
 * Anthropic API への実通信は別レイヤーなので、ここでは純粋な正規化ロジックのみを検証。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import workerModule from '../src/index.js';
import { __test__ } from '../src/index.js';

const {
  isNewFormat,
  normalizeRequest,
  legacyModeToStrength,
  strengthToLegacyMode,
  buildGameContextFromLegacy,
  buildGenreTemplateField,
  uncertainVerdict,
  categoryToVerdict,
  checkRateLimit,
} = __test__;

// default export が壊れていないことの軽い確認
describe('worker default export', () => {
  it('exposes a fetch handler', () => {
    expect(typeof workerModule.fetch).toBe('function');
  });
});

describe('handleJudge: バリデーション', () => {
  // インメモリ KV モック（rate-limit 用、最低限のメソッドのみ実装）
  function createMockKV(): unknown {
    const store = new Map<string, string>();
    return {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
    };
  }

  function buildEnv() {
    return { ANTHROPIC_API_KEY: 'test-key', RATE_LIMIT_KV: createMockKV() };
  }

  function buildRequest(body: unknown, token = 'test-uuid') {
    return new Request('http://localhost/api/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fck-token': token },
      body: JSON.stringify(body),
    });
  }

  it('21 件以上のメッセージは 400 で拒否される（MAX_MESSAGES_PER_REQUEST 上限）', async () => {
    const messages = Array.from({ length: 21 }, (_, i) => ({ id: String(i), text: `m${i}` }));
    const req = buildRequest({ messages, gameId: 'g' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await workerModule.fetch(req, buildEnv() as any);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('20');
  });

  it('20 件ちょうどは上限で許可される（実通信は test-key が無効なので fallback verdict が返る）', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: `m${i}` }));
    const req = buildRequest({ messages, gameId: 'g' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await workerModule.fetch(req, buildEnv() as any);
    // 上限チェックを通過 → 200 (Anthropic API 失敗で uncertain fallback) または何らかの非 400
    expect(res.status).not.toBe(400);
  });
});

describe('isNewFormat', () => {
  it('returns true when body has a `context` object', () => {
    expect(
      isNewFormat({
        messages: [],
        context: { settings: {} },
      }),
    ).toBe(true);
  });

  it('returns false when body has no `context`', () => {
    expect(
      isNewFormat({
        messages: [],
        gameId: 'g',
        filterMode: 'standard',
      }),
    ).toBe(false);
  });

  it('returns false when context is null', () => {
    expect(isNewFormat({ messages: [], context: null })).toBe(false);
  });
});

describe('legacyModeToStrength / strengthToLegacyMode (round trip)', () => {
  it.each([
    ['lenient', 'loose'] as const,
    ['standard', 'standard'] as const,
    ['strict', 'strict'] as const,
  ])('legacy %s ↔ strength %s', (legacy, strength) => {
    expect(legacyModeToStrength(legacy)).toBe(strength);
    expect(strengthToLegacyMode(strength)).toBe(legacy);
  });

  it("legacy 'off' は standard にマップ（spoiler.strength の値域外を吸収）", () => {
    expect(legacyModeToStrength('off')).toBe('standard');
  });
});

describe('buildGenreTemplateField', () => {
  it('空配列 → undefined', () => {
    expect(buildGenreTemplateField([])).toBeUndefined();
  });

  it('単一 ID → そのまま返す', () => {
    expect(buildGenreTemplateField(['rpg'])).toBe('rpg');
  });

  it('複数 ID → name 解決して `・` で結合', () => {
    const result = buildGenreTemplateField(['rpg', 'mystery']);
    expect(result).toContain('RPG');
    expect(result).toContain('推理');
    expect(result).toContain('・');
  });

  it('未知の ID は文字列をそのまま使う（fallback）', () => {
    const result = buildGenreTemplateField(['rpg', 'unknown-genre']);
    expect(result).toContain('RPG');
    expect(result).toContain('unknown-genre');
  });
});

describe('buildGameContextFromLegacy', () => {
  it('gameId / progress / videoTitle が揃った旧リクエストを GameContext に変換', () => {
    const ctx = buildGameContextFromLegacy({
      messages: [],
      gameId: 'ace-attorney-1',
      progress: {
        gameId: 'ace-attorney-1',
        progressModel: 'chapter',
        currentChapterId: 'ch3',
      },
      filterMode: 'standard',
      videoTitle: '逆転裁判 実況',
    });
    expect(ctx).toEqual({
      gameId: 'ace-attorney-1',
      gameTitle: '逆転裁判 実況',
      progressType: 'chapter',
      currentChapter: 'ch3',
    });
  });

  it('selectedGenreTemplates のみ → genreTemplate にマップ、progressType: none', () => {
    const ctx = buildGameContextFromLegacy({
      messages: [],
      selectedGenreTemplates: ['rpg'],
      filterMode: 'standard',
    });
    expect(ctx?.progressType).toBe('none');
    expect(ctx?.genreTemplate).toBe('rpg');
    expect(ctx?.gameId).toBeUndefined();
  });

  it('genre ショートハンドのみ → genreTemplate にマップ', () => {
    const ctx = buildGameContextFromLegacy({
      messages: [],
      genre: 'mystery',
      filterMode: 'standard',
    });
    expect(ctx?.genreTemplate).toBe('mystery');
  });

  it('selectedGenreTemplates 優先（genre は無視される）', () => {
    const ctx = buildGameContextFromLegacy({
      messages: [],
      selectedGenreTemplates: ['rpg'],
      genre: 'mystery',
      filterMode: 'standard',
    });
    expect(ctx?.genreTemplate).toBe('rpg');
  });

  it('event ベース progress を変換', () => {
    const ctx = buildGameContextFromLegacy({
      messages: [],
      gameId: 'g',
      progress: {
        gameId: 'g',
        progressModel: 'event',
        completedEventIds: ['e1', 'e2'],
      },
      filterMode: 'standard',
    });
    expect(ctx?.progressType).toBe('event');
    expect(ctx?.completedEvents).toEqual(['e1', 'e2']);
  });

  it('全フィールド未指定 → undefined（context 不要と判断）', () => {
    expect(
      buildGameContextFromLegacy({
        messages: [],
        filterMode: 'standard',
      }),
    ).toBeUndefined();
  });
});

describe('normalizeRequest', () => {
  describe('旧形式', () => {
    it('現行 v0.2.0 拡張のリクエストを正しく正規化', () => {
      const result = normalizeRequest({
        messages: [{ id: 'm1', text: 'hello' }],
        gameId: 'ace-attorney-1',
        progress: {
          gameId: 'ace-attorney-1',
          progressModel: 'chapter',
          currentChapterId: 'ch3',
        },
        filterMode: 'strict',
      });
      expect(result.messages).toEqual([{ id: 'm1', text: 'hello' }]);
      expect(result.context.game?.gameId).toBe('ace-attorney-1');
      expect(result.context.game?.currentChapter).toBe('ch3');
      expect(result.context.settings.categories.spoiler.strength).toBe('strict');
      expect(result.tier).toBe('free');
      expect(result.legacyFilterMode).toBe('strict');
    });

    it('filterMode 未指定 → standard / loose にデフォルト', () => {
      const result = normalizeRequest({
        messages: [{ id: 'm1', text: 'x' }],
        gameId: 'g',
      });
      expect(result.legacyFilterMode).toBe('standard');
      expect(result.context.settings.categories.spoiler.strength).toBe('standard');
    });

    it('lenient → strength: loose にマップ', () => {
      const result = normalizeRequest({
        messages: [{ id: 'm1', text: 'x' }],
        gameId: 'g',
        filterMode: 'lenient',
      });
      expect(result.legacyFilterMode).toBe('lenient');
      expect(result.context.settings.categories.spoiler.strength).toBe('loose');
    });

    it('複数 selectedGenreTemplates が結合された日本語表示名になる', () => {
      const result = normalizeRequest({
        messages: [{ id: 'm', text: 'x' }],
        selectedGenreTemplates: ['rpg', 'mystery'],
        filterMode: 'standard',
      });
      const tpl = result.context.game?.genreTemplate ?? '';
      expect(tpl).toContain('RPG');
      expect(tpl).toContain('推理');
      expect(tpl).toContain('・');
    });
  });

  describe('新形式', () => {
    it('context + tier を持つリクエストはそのまま JudgmentContext として採用', () => {
      const result = normalizeRequest({
        messages: [{ id: 'm', text: 'x' }],
        context: {
          game: {
            gameId: 'ace-attorney-1',
            progressType: 'chapter',
            currentChapter: 'ch3',
          },
          settings: {
            version: 2,
            enabled: true,
            displayMode: 'placeholder',
            filterMode: 'archive',
            categories: { spoiler: { enabled: true, strength: 'strict' } },
            customBlockWords: [],
            userTier: 'premium',
          },
        },
        tier: 'premium',
      });
      expect(result.tier).toBe('premium');
      expect(result.context.game?.gameId).toBe('ace-attorney-1');
      expect(result.context.settings.categories.spoiler.strength).toBe('strict');
      expect(result.legacyFilterMode).toBe('strict');
    });

    it('tier 未指定 → free にデフォルト', () => {
      const result = normalizeRequest({
        messages: [{ id: 'm', text: 'x' }],
        context: {
          settings: {
            version: 2,
            enabled: true,
            displayMode: 'placeholder',
            filterMode: 'archive',
            categories: { spoiler: { enabled: true, strength: 'standard' } },
            customBlockWords: [],
            userTier: 'free',
          },
        },
      });
      expect(result.tier).toBe('free');
    });

    it('settings.categories.spoiler.strength: loose → legacyFilterMode: lenient', () => {
      const result = normalizeRequest({
        messages: [{ id: 'm', text: 'x' }],
        context: {
          settings: {
            version: 2,
            enabled: true,
            displayMode: 'placeholder',
            filterMode: 'archive',
            categories: { spoiler: { enabled: true, strength: 'loose' } },
            customBlockWords: [],
            userTier: 'free',
          },
        },
      });
      expect(result.legacyFilterMode).toBe('lenient');
    });
  });
});

describe('checkRateLimit (HARD-01: KV 障害時 fail-open)', () => {
  function createMockKV(overrides?: Partial<{ get: () => Promise<string | null>; put: () => Promise<void> }>): unknown {
    const store = new Map<string, string>();
    return {
      async get(key: string) {
        if (overrides?.get) return overrides.get();
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        if (overrides?.put) return overrides.put();
        store.set(key, value);
      },
    };
  }

  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('正常系: KV から count を取得して制限内なら true', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await checkRateLimit('1.2.3.4', createMockKV() as any);
    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('上限超過時は false', async () => {
    const kv = createMockKV({
      get: async () => '99', // RATE_LIMIT_MAX (30) を超えた値
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await checkRateLimit('1.2.3.4', kv as any);
    expect(result).toBe(false);
  });

  it('KV.get が throw しても fail-open で true を返し、warn ログを出す', async () => {
    const kv = createMockKV({
      get: async () => {
        throw new Error('KV connection failed');
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await checkRateLimit('1.2.3.4', kv as any);
    expect(result).toBe(true);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain('failing open');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('KV connection failed');
  });

  it('KV.put が throw しても fail-open で true を返す', async () => {
    const kv = createMockKV({
      put: async () => {
        throw new Error('KV write failed');
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await checkRateLimit('1.2.3.4', kv as any);
    expect(result).toBe(true);
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

describe('verdict 計算', () => {
  it('uncertainVerdict は lenient モードで allow に倒す', () => {
    expect(uncertainVerdict('lenient')).toBe('allow');
    expect(uncertainVerdict('standard')).toBe('uncertain');
    expect(uncertainVerdict('strict')).toBe('uncertain');
  });

  it('categoryToVerdict: direct_spoiler は常に block', () => {
    expect(categoryToVerdict('direct_spoiler', 'lenient')).toBe('block');
    expect(categoryToVerdict('direct_spoiler', 'standard')).toBe('block');
    expect(categoryToVerdict('direct_spoiler', 'strict')).toBe('block');
  });

  it('categoryToVerdict: foreshadowing_hint は lenient で allow', () => {
    expect(categoryToVerdict('foreshadowing_hint', 'lenient')).toBe('allow');
    expect(categoryToVerdict('foreshadowing_hint', 'standard')).toBe('block');
    expect(categoryToVerdict('foreshadowing_hint', 'strict')).toBe('block');
  });

  it('categoryToVerdict: gameplay_hint は strict のみ block', () => {
    expect(categoryToVerdict('gameplay_hint', 'lenient')).toBe('allow');
    expect(categoryToVerdict('gameplay_hint', 'standard')).toBe('allow');
    expect(categoryToVerdict('gameplay_hint', 'strict')).toBe('block');
  });

  it('categoryToVerdict: safe は常に allow', () => {
    expect(categoryToVerdict('safe', 'lenient')).toBe('allow');
    expect(categoryToVerdict('safe', 'standard')).toBe('allow');
    expect(categoryToVerdict('safe', 'strict')).toBe('allow');
  });

  describe('HARD-03: 未知の spoiler_category へのフォールバック', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('未知の category（LLM ハルシネーション）→ uncertainVerdict にフォールバック', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = categoryToVerdict('unknown' as any, 'standard');
      expect(result).toBe('uncertain');
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]?.[0]).toContain('Unknown spoiler_category');
    });

    it('未知の category + lenient モード → allow（uncertainVerdict の挙動）', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(categoryToVerdict('garbage' as any, 'lenient')).toBe('allow');
    });
  });
});
