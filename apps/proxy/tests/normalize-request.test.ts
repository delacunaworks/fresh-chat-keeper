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
  primaryToVerdict,
  checkRateLimit,
  isValidV2Settings,
} = __test__;

const VALID_V2_SETTINGS = {
  version: 2,
  enabled: true,
  displayMode: 'placeholder',
  filterMode: 'archive',
  categories: { spoiler: { enabled: true, strength: 'standard' } },
  customBlockWords: [],
  userTier: 'free',
};

// default export が壊れていないことの軽い確認
describe('worker default export', () => {
  it('exposes a fetch handler', () => {
    expect(typeof workerModule.fetch).toBe('function');
  });
});

describe('handleJudge: バリデーション', () => {
  // ネイティブ Rate Limiting binding の最小モック（常に通す）。
  // 本物の `RateLimit` は `.limit({ key })` → `{ success }` を返す。
  function createMockRateLimiter(): unknown {
    return { async limit() { return { success: true }; } };
  }

  function buildEnv() {
    return { ANTHROPIC_API_KEY: 'test-key', JUDGE_RATE_LIMITER: createMockRateLimiter() };
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

  describe('HARD-04: 新形式 settings の実行時検証', () => {
    it('context.settings 欠損（context のみ）→ 400', async () => {
      const req = buildRequest({
        messages: [{ id: 'm1', text: 'hi' }],
        context: {}, // settings なし
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await workerModule.fetch(req, buildEnv() as any);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Invalid context.settings format');
    });

    it('categories.spoiler.strength が不正 enum 値 → 400', async () => {
      const badSettings = {
        ...VALID_V2_SETTINGS,
        categories: { spoiler: { enabled: true, strength: 'extreme' } }, // 不正
      };
      const req = buildRequest({
        messages: [{ id: 'm1', text: 'hi' }],
        context: { settings: badSettings },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await workerModule.fetch(req, buildEnv() as any);
      expect(res.status).toBe(400);
    });

    it('categories.spoiler が undefined → 400', async () => {
      const badSettings = {
        ...VALID_V2_SETTINGS,
        categories: {}, // spoiler なし
      };
      const req = buildRequest({
        messages: [{ id: 'm1', text: 'hi' }],
        context: { settings: badSettings },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await workerModule.fetch(req, buildEnv() as any);
      expect(res.status).toBe(400);
    });

    it('正しい v2 settings は 400 にならない（実通信失敗で fallback）', async () => {
      const req = buildRequest({
        messages: [{ id: 'm1', text: 'hi' }],
        context: { settings: VALID_V2_SETTINGS },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await workerModule.fetch(req, buildEnv() as any);
      expect(res.status).not.toBe(400);
    });
  });
});

describe('isValidV2Settings (HARD-04 unit)', () => {
  it('正しい v2 settings → true', () => {
    expect(isValidV2Settings(VALID_V2_SETTINGS)).toBe(true);
  });

  it('null / undefined / プリミティブ → false', () => {
    expect(isValidV2Settings(null)).toBe(false);
    expect(isValidV2Settings(undefined)).toBe(false);
    expect(isValidV2Settings('string')).toBe(false);
    expect(isValidV2Settings(42)).toBe(false);
  });

  it('version が数値でない → false', () => {
    expect(isValidV2Settings({ ...VALID_V2_SETTINGS, version: 'two' })).toBe(false);
  });

  it('enabled が boolean でない → false', () => {
    expect(isValidV2Settings({ ...VALID_V2_SETTINGS, enabled: 'true' })).toBe(false);
  });

  it('categories.spoiler.strength が enum 外 → false', () => {
    expect(
      isValidV2Settings({
        ...VALID_V2_SETTINGS,
        categories: { spoiler: { enabled: true, strength: 'extreme' } },
      }),
    ).toBe(false);
  });

  it('categories.spoiler.enabled が boolean でない → false', () => {
    expect(
      isValidV2Settings({
        ...VALID_V2_SETTINGS,
        categories: { spoiler: { enabled: 'yes', strength: 'standard' } },
      }),
    ).toBe(false);
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

    // ─── Phase 5 P5-B4c: recentAudio（字幕文脈）の通過 ───────────────
    it('context.recentAudio があれば JudgmentContext.recentAudio へそのまま通す', () => {
      const result = normalizeRequest({
        messages: [{ id: 'm', text: 'x' }],
        context: {
          settings: VALID_V2_SETTINGS,
          recentAudio: { text: 'このボス強い、次の部屋行こう', qualityScore: 0.8 },
        },
      });
      expect(result.context.recentAudio).toEqual({
        text: 'このボス強い、次の部屋行こう',
        qualityScore: 0.8,
      });
    });

    it('context.recentAudio が無ければ recentAudio は undefined（後方互換: v0.5.0 と同一）', () => {
      const result = normalizeRequest({
        messages: [{ id: 'm', text: 'x' }],
        context: { settings: VALID_V2_SETTINGS },
      });
      expect(result.context.recentAudio).toBeUndefined();
    });
  });
});

describe('checkRateLimit (HARD-01: Rate Limiting binding 障害時 fail-open)', () => {
  /**
   * ネイティブ `RateLimit` binding のモック。`limit()` の戻り値 `{ success }` を
   * 差し替えるか、例外を投げさせる。
   */
  function createMockRateLimiter(
    behavior: { success: boolean } | { throws: Error },
  ): unknown {
    return {
      async limit() {
        if ('throws' in behavior) throw behavior.throws;
        return { success: behavior.success };
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

  it('正常系: limit() が success:true を返せば true', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await checkRateLimit('1.2.3.4', createMockRateLimiter({ success: true }) as any);
    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('上限超過時（success:false）は false', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await checkRateLimit('1.2.3.4', createMockRateLimiter({ success: false }) as any);
    expect(result).toBe(false);
  });

  it('limit() が throw しても fail-open で true を返し、warn ログを出す', async () => {
    const limiter = createMockRateLimiter({ throws: new Error('rate limit binding down') });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await checkRateLimit('1.2.3.4', limiter as any);
    expect(result).toBe(true);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain('failing open');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('rate limit binding down');
  });
});

describe('verdict 計算', () => {
  /**
   * primaryToVerdict 用の最小 settings ビルダー。Phase 3 は categories の
   * ON/OFF が verdict 計算に効くため、各テストで該当カテゴリを明示する。
   */
  function buildSettings(
    overrides?: Partial<{
      harassment: boolean;
      spam: boolean;
      offTopic: boolean;
      backseat: boolean;
    }>,
  ) {
    return {
      version: 3 as const,
      enabled: true,
      displayMode: 'placeholder' as const,
      filterMode: 'archive' as const,
      categories: {
        spoiler: { enabled: true, strength: 'standard' as const },
        harassment: { enabled: overrides?.harassment ?? false, strength: 'standard' as const },
        spam: { enabled: overrides?.spam ?? false },
        offTopic: { enabled: overrides?.offTopic ?? false, strength: 'standard' as const },
        backseat: { enabled: overrides?.backseat ?? false, strength: 'standard' as const },
      },
      customBlockWords: [],
      userTier: 'free' as const,
    };
  }

  it('uncertainVerdict は lenient モードで allow に倒す', () => {
    expect(uncertainVerdict('lenient')).toBe('allow');
    expect(uncertainVerdict('standard')).toBe('uncertain');
    expect(uncertainVerdict('strict')).toBe('uncertain');
  });

  describe('primaryToVerdict (Phase 3 マルチラベル)', () => {
    it('safe → 常に allow（filterMode/カテゴリ設定に関係なく）', () => {
      const s = buildSettings();
      expect(primaryToVerdict('safe', s, 'lenient')).toBe('allow');
      expect(primaryToVerdict('safe', s, 'standard')).toBe('allow');
      expect(primaryToVerdict('safe', s, 'strict')).toBe('allow');
    });

    it('spoiler → 常に block（強度はプロンプト側で処理済み）', () => {
      const s = buildSettings();
      expect(primaryToVerdict('spoiler', s, 'lenient')).toBe('block');
      expect(primaryToVerdict('spoiler', s, 'standard')).toBe('block');
      expect(primaryToVerdict('spoiler', s, 'strict')).toBe('block');
    });

    it('harassment: enabled=true → block', () => {
      expect(primaryToVerdict('harassment', buildSettings({ harassment: true }), 'standard')).toBe(
        'block',
      );
    });

    it('harassment: enabled=false → allow（OFF カテゴリは判定を発火しない）', () => {
      expect(primaryToVerdict('harassment', buildSettings({ harassment: false }), 'standard')).toBe(
        'allow',
      );
    });

    it('spam: enabled=true → block', () => {
      expect(primaryToVerdict('spam', buildSettings({ spam: true }), 'standard')).toBe('block');
    });

    it('spam: enabled=false → allow', () => {
      expect(primaryToVerdict('spam', buildSettings({ spam: false }), 'standard')).toBe('allow');
    });

    it('off_topic: enabled=true → block', () => {
      expect(primaryToVerdict('off_topic', buildSettings({ offTopic: true }), 'standard')).toBe(
        'block',
      );
    });

    it('off_topic: enabled=false → allow', () => {
      expect(primaryToVerdict('off_topic', buildSettings({ offTopic: false }), 'standard')).toBe(
        'allow',
      );
    });

    it('backseat: enabled=true → block', () => {
      expect(primaryToVerdict('backseat', buildSettings({ backseat: true }), 'standard')).toBe(
        'block',
      );
    });

    it('backseat: enabled=false → allow', () => {
      expect(primaryToVerdict('backseat', buildSettings({ backseat: false }), 'standard')).toBe(
        'allow',
      );
    });

    describe('未知の primary（型外）→ uncertainVerdict にフォールバック', () => {
      let warnSpy: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      });
      afterEach(() => {
        warnSpy.mockRestore();
      });

      it('不明 primary + standard → uncertain', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(primaryToVerdict('unknown' as any, buildSettings(), 'standard')).toBe('uncertain');
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy.mock.calls[0]?.[0]).toContain('Unknown primary label');
      });

      it('不明 primary + lenient → allow（uncertainVerdict 経由）', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(primaryToVerdict('garbage' as any, buildSettings(), 'lenient')).toBe('allow');
      });
    });
  });
});
