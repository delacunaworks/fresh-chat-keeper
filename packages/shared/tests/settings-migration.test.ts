/**
 * `migrateSettings` テスト（Phase 3 / v3 化済み）。
 *
 * カバー範囲:
 * - 不正入力 (null/undefined/プリミティブ/配列) → デフォルト v3
 * - 完全な v1 → v3 変換（新カテゴリは OFF / userBlocks は空）
 * - 部分的に欠けた v1 → 安全に補完
 * - v2 → v3 変換（既存カテゴリ値は保持、新規 strength と userBlocks を補完）
 * - v3 idempotency（再投入で値が変わらない）
 * - 部分的に欠けた v3 → 安全に補完
 * - 不正な型の値（数値が来るべき所に文字列等）→ デフォルトで上書き
 * - userBlocks の構造バリデーション（不正 metadata エントリを脱落）
 */

import { describe, it, expect } from 'vitest';
import {
  migrateSettings,
  SETTINGS_V1_BACKUP_KEY,
  SETTINGS_V2_BACKUP_KEY,
} from '../src/settings-migration.js';
import type {
  FilterSettings,
  FilterSettingsV1,
  FilterSettingsV2,
  GameContext,
} from '../src/types/settings.js';

/**
 * v3 のデフォルトをそのまま比較するための定数。
 * 新カテゴリ4種・userBlocks が populate された状態。
 */
const DEFAULT_V3: FilterSettings = {
  version: 3,
  enabled: true,
  displayMode: 'placeholder',
  filterMode: 'archive',
  categories: {
    spoiler: { enabled: true, strength: 'standard' },
    harassment: { enabled: false, strength: 'standard' },
    spam: { enabled: false },
    offTopic: { enabled: false, strength: 'standard' },
    backseat: { enabled: false, strength: 'standard' },
  },
  userBlocks: { channelIds: [], metadata: {} },
  customBlockWords: [],
  userTier: 'free',
};

describe('migrateSettings (v3)', () => {
  describe('不正入力 → デフォルト v3', () => {
    it('null → デフォルト', () => {
      expect(migrateSettings(null)).toEqual(DEFAULT_V3);
    });

    it('undefined → デフォルト', () => {
      expect(migrateSettings(undefined)).toEqual(DEFAULT_V3);
    });

    it('数値 → デフォルト', () => {
      expect(migrateSettings(42)).toEqual(DEFAULT_V3);
    });

    it('文字列 → デフォルト', () => {
      expect(migrateSettings('not an object')).toEqual(DEFAULT_V3);
    });

    it('配列 → デフォルト（プレーンオブジェクトでない）', () => {
      expect(migrateSettings([1, 2, 3])).toEqual(DEFAULT_V3);
    });

    it('空オブジェクト → v1 として処理されデフォルトに近い形になる', () => {
      const result = migrateSettings({});
      expect(result.version).toBe(3);
      expect(result.enabled).toBe(true);
      expect(result.categories.spoiler.strength).toBe('standard');
      expect(result.userTier).toBe('free');
      expect(result.customBlockWords).toEqual([]);
      expect(result.userBlocks).toEqual({ channelIds: [], metadata: {} });
    });
  });

  describe('完全な v1 → v3 変換', () => {
    it('全フィールド埋まった v1 を v3 に正しく変換', () => {
      const v1: FilterSettingsV1 = {
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'live',
        filterStrength: 'strict',
        customBlockWords: ['秘密', 'ネタバレ注意'],
        gameContext: {
          gameId: 'ace-attorney-1',
          progressType: 'chapter',
          currentChapter: 'ch3',
        },
      };
      const result = migrateSettings(v1);
      expect(result).toEqual<FilterSettings>({
        version: 3,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'live',
        categories: {
          spoiler: { enabled: true, strength: 'strict' },
          harassment: { enabled: false, strength: 'standard' },
          spam: { enabled: false },
          offTopic: { enabled: false, strength: 'standard' },
          backseat: { enabled: false, strength: 'standard' },
        },
        userBlocks: { channelIds: [], metadata: {} },
        customBlockWords: ['秘密', 'ネタバレ注意'],
        userTier: 'free',
        gameContext: {
          gameId: 'ace-attorney-1',
          progressType: 'chapter',
          currentChapter: 'ch3',
        },
      });
    });

    it('v1 enabled: false でも categories.spoiler.enabled は true を維持', () => {
      const v1: FilterSettingsV1 = {
        enabled: false,
        displayMode: 'hidden',
        filterMode: 'archive',
        filterStrength: 'loose',
      };
      const result = migrateSettings(v1);
      expect(result.enabled).toBe(false);
      expect(result.categories.spoiler.enabled).toBe(true);
      expect(result.categories.spoiler.strength).toBe('loose');
    });

    it('v1 customBlockWords 未定義 → 空配列', () => {
      const v1 = {
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        filterStrength: 'standard',
      };
      const result = migrateSettings(v1);
      expect(result.customBlockWords).toEqual([]);
    });
  });

  describe('部分的に欠けた v1 → 安全に補完', () => {
    it('filterStrength のみ → 他はデフォルト', () => {
      const result = migrateSettings({ filterStrength: 'strict' });
      expect(result.categories.spoiler.strength).toBe('strict');
      expect(result.enabled).toBe(true);
      expect(result.displayMode).toBe('placeholder');
      expect(result.filterMode).toBe('archive');
    });

    it('filterStrength が不正値 → standard に倒す', () => {
      const result = migrateSettings({ filterStrength: 'extreme' });
      expect(result.categories.spoiler.strength).toBe('standard');
    });

    it('displayMode が不正値 → placeholder に倒す', () => {
      const result = migrateSettings({ displayMode: 'invalid' });
      expect(result.displayMode).toBe('placeholder');
    });

    it('customBlockWords が string[] でない → 空配列', () => {
      const result = migrateSettings({ customBlockWords: 'not-an-array' });
      expect(result.customBlockWords).toEqual([]);
    });

    it('customBlockWords に非 string が混じる → 空配列', () => {
      const result = migrateSettings({ customBlockWords: ['ok', 42, 'word'] });
      expect(result.customBlockWords).toEqual([]);
    });

    it('gameContext が不正な構造 → undefined（脱落）', () => {
      const result = migrateSettings({
        filterStrength: 'standard',
        gameContext: { foo: 'bar' },
      });
      expect(result.gameContext).toBeUndefined();
    });

    it('gameContext が妥当 → 保持', () => {
      const game: GameContext = {
        gameId: 'g',
        progressType: 'event',
        completedEvents: ['e1', 'e2'],
      };
      const result = migrateSettings({ filterStrength: 'standard', gameContext: game });
      expect(result.gameContext).toEqual(game);
    });
  });

  describe('v2 → v3 変換', () => {
    it('完全な v2 を v3 に変換（既存値は保持、新カテゴリは OFF、userBlocks は空）', () => {
      const v2: FilterSettingsV2 = {
        version: 2,
        enabled: true,
        displayMode: 'hidden',
        filterMode: 'live',
        categories: { spoiler: { enabled: true, strength: 'strict' } },
        customBlockWords: ['NG1'],
        userTier: 'premium',
      };
      const result = migrateSettings(v2);
      expect(result.version).toBe(3);
      expect(result.enabled).toBe(true);
      expect(result.displayMode).toBe('hidden');
      expect(result.categories.spoiler).toEqual({ enabled: true, strength: 'strict' });
      expect(result.categories.harassment).toEqual({ enabled: false, strength: 'standard' });
      expect(result.categories.spam).toEqual({ enabled: false });
      expect(result.categories.offTopic).toEqual({ enabled: false, strength: 'standard' });
      expect(result.categories.backseat).toEqual({ enabled: false, strength: 'standard' });
      expect(result.userBlocks).toEqual({ channelIds: [], metadata: {} });
      expect(result.customBlockWords).toEqual(['NG1']);
      expect(result.userTier).toBe('premium');
    });

    it('v2 で harassment が既に設定されていれば保持', () => {
      const v2 = {
        version: 2,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        categories: {
          spoiler: { enabled: true, strength: 'standard' },
          harassment: { enabled: true, strength: 'strict' },
        },
        customBlockWords: [],
        userTier: 'free',
      };
      const result = migrateSettings(v2);
      expect(result.categories.harassment).toEqual({ enabled: true, strength: 'strict' });
    });

    it('v2 の offTopic（enabled のみ、strength なし）→ v3 で strength: standard を補完', () => {
      const v2 = {
        version: 2,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        categories: {
          spoiler: { enabled: true, strength: 'standard' },
          offTopic: { enabled: true }, // v2: strength なし
        },
        customBlockWords: [],
        userTier: 'free',
      };
      const result = migrateSettings(v2);
      expect(result.categories.offTopic).toEqual({ enabled: true, strength: 'standard' });
    });

    it('v2 の backseat（enabled のみ）→ v3 で strength: standard を補完', () => {
      const v2 = {
        version: 2,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        categories: {
          spoiler: { enabled: true, strength: 'standard' },
          backseat: { enabled: true },
        },
        customBlockWords: [],
        userTier: 'free',
      };
      const result = migrateSettings(v2);
      expect(result.categories.backseat).toEqual({ enabled: true, strength: 'standard' });
    });
  });

  describe('v3 idempotency', () => {
    it('v3 を渡しても変わらない', () => {
      const v3: FilterSettings = {
        version: 3,
        enabled: false,
        displayMode: 'hidden',
        filterMode: 'live',
        categories: {
          spoiler: { enabled: false, strength: 'strict' },
          harassment: { enabled: true, strength: 'loose' },
          spam: { enabled: true },
          offTopic: { enabled: true, strength: 'loose' },
          backseat: { enabled: true, strength: 'strict' },
        },
        userBlocks: {
          channelIds: ['UC_blocked1', 'UC_blocked2'],
          metadata: {
            UC_blocked1: { displayNameAtBlock: 'A', blockedAt: 1700000000000 },
            UC_blocked2: { displayNameAtBlock: 'B', blockedAt: 1700000001000, reason: 'spam' },
          },
        },
        customBlockWords: ['a', 'b'],
        userTier: 'premium',
        gameContext: { gameId: 'g', progressType: 'none' },
      };
      const result = migrateSettings(v3);
      expect(result).toEqual(v3);
    });

    it('再マイグレーション（migrate(migrate(v1))）でも安定', () => {
      const v1: FilterSettingsV1 = {
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        filterStrength: 'strict',
      };
      const once = migrateSettings(v1);
      const twice = migrateSettings(once);
      expect(twice).toEqual(once);
    });

    it('migrate(v2) を再マイグレーションしても安定', () => {
      const v2: FilterSettingsV2 = {
        version: 2,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        categories: {
          spoiler: { enabled: true, strength: 'standard' },
          harassment: { enabled: true, strength: 'strict' },
        },
        customBlockWords: [],
        userTier: 'free',
      };
      const once = migrateSettings(v2);
      const twice = migrateSettings(once);
      expect(twice).toEqual(once);
    });
  });

  describe('部分的に欠けた v3 → 安全に補完', () => {
    it('v3 で categories.spoiler が欠落 → デフォルトで補完', () => {
      const result = migrateSettings({
        version: 3,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        categories: {},
        customBlockWords: [],
        userTier: 'free',
      });
      expect(result.categories.spoiler).toEqual({ enabled: true, strength: 'standard' });
    });

    it('v3 で userTier が不正値 → free に倒す', () => {
      const result = migrateSettings({
        version: 3,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        categories: { spoiler: { enabled: true, strength: 'standard' } },
        customBlockWords: [],
        userTier: 'enterprise',
      });
      expect(result.userTier).toBe('free');
    });

    it('v3 で gameContext が不正な構造 → 脱落', () => {
      const result = migrateSettings({
        version: 3,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        categories: { spoiler: { enabled: true, strength: 'standard' } },
        customBlockWords: [],
        userTier: 'free',
        gameContext: 'not-an-object',
      });
      expect(result.gameContext).toBeUndefined();
    });

    it('v3 で userBlocks が未指定 → デフォルトで空構造', () => {
      const result = migrateSettings({
        version: 3,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        categories: { spoiler: { enabled: true, strength: 'standard' } },
        customBlockWords: [],
        userTier: 'free',
      });
      expect(result.userBlocks).toEqual({ channelIds: [], metadata: {} });
    });
  });

  describe('userBlocks の構造バリデーション', () => {
    it('channelIds に非 string が混ざる → 空配列に倒す', () => {
      const result = migrateSettings({
        version: 3,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        categories: { spoiler: { enabled: true, strength: 'standard' } },
        customBlockWords: [],
        userTier: 'free',
        userBlocks: { channelIds: ['UC_a', 42, 'UC_b'], metadata: {} },
      });
      expect(result.userBlocks?.channelIds).toEqual([]);
    });

    it('metadata に不正 entry が混ざる → 該当 entry を脱落させ、妥当な entry は保持', () => {
      const result = migrateSettings({
        version: 3,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        categories: { spoiler: { enabled: true, strength: 'standard' } },
        customBlockWords: [],
        userTier: 'free',
        userBlocks: {
          channelIds: ['UC_a', 'UC_bad', 'UC_b'],
          metadata: {
            UC_a: { displayNameAtBlock: 'A', blockedAt: 1700000000000 },
            UC_bad: { displayNameAtBlock: 'X' }, // blockedAt 欠落
            UC_b: { displayNameAtBlock: 'B', blockedAt: 1700000001000, reason: 'spam' },
          },
        },
      });
      expect(Object.keys(result.userBlocks?.metadata ?? {})).toEqual(['UC_a', 'UC_b']);
      expect(result.userBlocks?.metadata.UC_b.reason).toBe('spam');
    });

    it('metadata.blockedAt が NaN → 該当 entry を脱落', () => {
      const result = migrateSettings({
        version: 3,
        enabled: true,
        displayMode: 'placeholder',
        filterMode: 'archive',
        categories: { spoiler: { enabled: true, strength: 'standard' } },
        customBlockWords: [],
        userTier: 'free',
        userBlocks: {
          channelIds: ['UC_a'],
          metadata: {
            UC_a: { displayNameAtBlock: 'A', blockedAt: Number.NaN },
          },
        },
      });
      expect(result.userBlocks?.metadata).toEqual({});
    });
  });

  describe('バックアップキー定数', () => {
    it('CLAUDE.md の命名規約 fck_<original>_v{N}_backup に従う', () => {
      expect(SETTINGS_V1_BACKUP_KEY).toBe('fck_settings_v1_backup');
      expect(SETTINGS_V2_BACKUP_KEY).toBe('fck_settings_v2_backup');
    });
  });
});
