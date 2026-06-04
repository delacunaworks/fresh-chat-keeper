/**
 * Phase 3.5 B3 / Phase 5 P5-B4b: settings-loader.ts のマイグレーションテスト。
 *
 * 検証観点（v0.6.0 / version 5 時点）:
 * - v5 そのまま読み出し → バックアップ作成されない
 * - v4 → v5: fck_settings_v4_backup に退避、書き戻し後 version=5、
 *   captionContext が DEFAULT 補完される
 * - v3 → v5: fck_settings_v3_backup に退避（v4 backup と独立）
 * - v2 → v5: fck_settings_v2_backup に退避
 * - v1 → v5: fck_settings_v1_backup に退避
 * - 未設定 → DEFAULT 値（version 付与なし、初期保護）
 * - 不正型（string/array/null）→ DEFAULT_SETTINGS フォールバック
 * - userFlagging / captionContext 欠落の v5 → stripVersion DEFAULT マージで補完
 * - バックアップ既存時は上書きしない（既存パターン踏襲）
 * - saveSettings は常に version: 5 を付ける
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  loadSettings,
  saveSettings,
  CURRENT_SETTINGS_VERSION,
  SETTINGS_V1_BACKUP_KEY,
  SETTINGS_V2_BACKUP_KEY,
  SETTINGS_V3_BACKUP_KEY,
  SETTINGS_V4_BACKUP_KEY,
} from './settings-loader.js';
import { DEFAULT_SETTINGS, STORAGE_KEY, type Settings } from './settings.js';

// ─── chrome.storage.local の fake ─────────────────────────────────

interface FakeStorage {
  store: Map<string, unknown>;
}

function installFakeChrome(): FakeStorage {
  const store = new Map<string, unknown>();
  const fake = {
    storage: {
      local: {
        get: async (key: string | string[] | null) => {
          const keys = Array.isArray(key) ? key : key ? [key] : [...store.keys()];
          const out: Record<string, unknown> = {};
          for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) store.set(k, v);
        },
        remove: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) store.delete(k);
        },
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { store };
}

describe('settings-loader: v5 そのまま読み出し', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('version=5 の保存値をそのまま使い、バックアップを作成しない', async () => {
    const stored = { ...DEFAULT_SETTINGS, gameId: 'rdr2', version: 5 };
    fake.store.set(STORAGE_KEY, stored);
    const loaded = await loadSettings();
    expect(loaded.gameId).toBe('rdr2');
    expect((loaded as Settings & { version?: number }).version).toBeUndefined();
    expect(fake.store.has(SETTINGS_V1_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V2_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V3_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V4_BACKUP_KEY)).toBe(false);
  });

  it('captionContext 欠落の v5 データは DEFAULT マージで補完される', async () => {
    const stored: Record<string, unknown> = { ...DEFAULT_SETTINGS, version: 5 };
    delete stored.captionContext;
    fake.store.set(STORAGE_KEY, stored);
    const loaded = await loadSettings();
    expect(loaded.captionContext).toEqual(DEFAULT_SETTINGS.captionContext);
    expect(loaded.captionContext.enabled).toBe(false);
    expect(loaded.captionContext.windowSeconds).toBe(60);
    expect(loaded.captionContext.qualityThreshold).toBe('standard');
  });

  it('userFlagging 欠落の v5 データも DEFAULT マージで補完される', async () => {
    const stored: Record<string, unknown> = { ...DEFAULT_SETTINGS, version: 5 };
    delete stored.userFlagging;
    fake.store.set(STORAGE_KEY, stored);
    const loaded = await loadSettings();
    expect(loaded.userFlagging).toEqual(DEFAULT_SETTINGS.userFlagging);
    expect(loaded.userFlagging.enabled).toBe(false);
  });
});

describe('settings-loader: v4 → v5 マイグレーション', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('v4 保存値を読むと fck_settings_v4_backup に退避され version: 5 で書き戻される', async () => {
    const v4Data = {
      ...DEFAULT_SETTINGS,
      gameId: 'rdr2',
      userFlagging: {
        enabled: true,
        scope: '7d',
        displayStyle: 'color',
        sensitivity: { yellow: 0.15, red: 0.3 },
      },
      version: 4,
    };
    // v4 には captionContext が無い想定（既存 v0.5.0 ユーザー）
    delete (v4Data as Record<string, unknown>).captionContext;
    fake.store.set(STORAGE_KEY, v4Data);

    const loaded = await loadSettings();

    expect(loaded.gameId).toBe('rdr2');
    // 既存 userFlagging は保持される
    expect(loaded.userFlagging.enabled).toBe(true);
    expect(loaded.userFlagging.scope).toBe('7d');
    // captionContext は DEFAULT 補完（オプトイン既定 OFF）
    expect(loaded.captionContext).toEqual(DEFAULT_SETTINGS.captionContext);
    expect(loaded.captionContext.enabled).toBe(false);
    // 旧 v4 データが backup に退避
    expect(fake.store.get(SETTINGS_V4_BACKUP_KEY)).toEqual(v4Data);
    const written = fake.store.get(STORAGE_KEY) as { version?: number };
    expect(written.version).toBe(5);
  });

  it('v1/v2/v3 backup は v4 → v5 では作成されない（独立バックアップ）', async () => {
    fake.store.set(STORAGE_KEY, { ...DEFAULT_SETTINGS, version: 4 });
    await loadSettings();
    expect(fake.store.has(SETTINGS_V4_BACKUP_KEY)).toBe(true);
    expect(fake.store.has(SETTINGS_V1_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V2_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V3_BACKUP_KEY)).toBe(false);
  });

  it('既存の v4 backup は上書きされない（一度書いたら不変）', async () => {
    const earlierBackup = { gameId: 'earlier', version: 4 };
    fake.store.set(SETTINGS_V4_BACKUP_KEY, earlierBackup);
    fake.store.set(STORAGE_KEY, { ...DEFAULT_SETTINGS, version: 4 });
    await loadSettings();
    expect(fake.store.get(SETTINGS_V4_BACKUP_KEY)).toEqual(earlierBackup);
  });
});

describe('settings-loader: v3 → v5 マイグレーション', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('v3 保存値を読むと fck_settings_v3_backup に退避され version: 5 で書き戻される', async () => {
    const v3Data = {
      enabled: true,
      gameId: 'ace-attorney-1',
      filterMode: 'standard',
      displayMode: 'placeholder',
      proxyUrl: 'http://localhost:8787',
      collectionApiUrl: 'http://localhost:8788',
      customNgWords: [],
      progressByGame: {},
      selectedGenreTemplates: [],
      triggerVisibility: 'hover_only',
      categories: {
        harassment: { enabled: false, strength: 'standard' },
        spam: { enabled: false },
        offTopic: { enabled: false, strength: 'standard' },
        backseat: { enabled: false, strength: 'standard' },
      },
      version: 3,
    };
    fake.store.set(STORAGE_KEY, v3Data);

    const loaded = await loadSettings();

    expect(loaded.gameId).toBe('ace-attorney-1');
    expect(loaded.userFlagging).toEqual(DEFAULT_SETTINGS.userFlagging); // DEFAULT 補完
    expect(loaded.captionContext).toEqual(DEFAULT_SETTINGS.captionContext); // v5 新フィールドも補完
    expect(fake.store.get(SETTINGS_V3_BACKUP_KEY)).toEqual(v3Data);
    const written = fake.store.get(STORAGE_KEY) as { version?: number };
    expect(written.version).toBe(5);
  });

  it('v1 / v2 / v4 backup は v3 → v5 では作成されない（独立バックアップ）', async () => {
    fake.store.set(STORAGE_KEY, { ...DEFAULT_SETTINGS, version: 3 });
    await loadSettings();
    expect(fake.store.has(SETTINGS_V3_BACKUP_KEY)).toBe(true);
    expect(fake.store.has(SETTINGS_V1_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V2_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V4_BACKUP_KEY)).toBe(false);
  });

  it('既存の v3 backup は上書きされない（一度書いたら不変）', async () => {
    const earlierBackup = { gameId: 'earlier', version: 3 };
    fake.store.set(SETTINGS_V3_BACKUP_KEY, earlierBackup);
    fake.store.set(STORAGE_KEY, { ...DEFAULT_SETTINGS, version: 3 });
    await loadSettings();
    expect(fake.store.get(SETTINGS_V3_BACKUP_KEY)).toEqual(earlierBackup);
  });
});

describe('settings-loader: v2 → v5 マイグレーション', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('v2 → fck_settings_v2_backup に退避（v3/v4 backup と独立）+ captionContext 補完', async () => {
    const v2Data = { gameId: 'rdr2', enabled: true, version: 2 };
    fake.store.set(STORAGE_KEY, v2Data);

    const loaded = await loadSettings();

    expect(loaded.gameId).toBe('rdr2');
    expect(loaded.captionContext).toEqual(DEFAULT_SETTINGS.captionContext); // 飛び級でも補完
    expect(fake.store.get(SETTINGS_V2_BACKUP_KEY)).toEqual(v2Data);
    expect(fake.store.has(SETTINGS_V3_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V4_BACKUP_KEY)).toBe(false);
    expect((fake.store.get(STORAGE_KEY) as { version: number }).version).toBe(5);
  });
});

describe('settings-loader: v1 → v5 マイグレーション', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('version フィールドなし → fck_settings_v1_backup に退避 + version 5 + captionContext 補完', async () => {
    const v1Data = { gameId: 'rdr2', enabled: true }; // version なし
    fake.store.set(STORAGE_KEY, v1Data);

    const loaded = await loadSettings();

    expect(loaded.gameId).toBe('rdr2');
    expect(loaded.captionContext).toEqual(DEFAULT_SETTINGS.captionContext);
    expect(fake.store.get(SETTINGS_V1_BACKUP_KEY)).toEqual(v1Data);
    expect(fake.store.has(SETTINGS_V2_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V3_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V4_BACKUP_KEY)).toBe(false);
    expect((fake.store.get(STORAGE_KEY) as { version: number }).version).toBe(5);
  });
});

describe('settings-loader: 異常系', () => {
  let fake: FakeStorage;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fake = installFakeChrome();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('未設定 → DEFAULT を返し、ストレージは触らない', async () => {
    const loaded = await loadSettings();
    expect(loaded).toEqual(DEFAULT_SETTINGS);
    expect(fake.store.size).toBe(0);
  });

  it('不正型（string）→ DEFAULT へフォールバック + v1 backup に退避（warn ログあり）', async () => {
    fake.store.set(STORAGE_KEY, 'garbage');
    const loaded = await loadSettings();
    expect(loaded).toEqual(DEFAULT_SETTINGS);
    expect(fake.store.get(SETTINGS_V1_BACKUP_KEY)).toBe('garbage');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('不正型（array）→ DEFAULT へフォールバック', async () => {
    fake.store.set(STORAGE_KEY, [1, 2, 3]);
    const loaded = await loadSettings();
    expect(loaded).toEqual(DEFAULT_SETTINGS);
  });
});

describe('settings-loader: saveSettings', () => {
  beforeEach(() => {
    installFakeChrome();
  });

  it('保存時は常に version: 5 が付く', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, gameId: 'rdr2' });
    const stored = (globalThis as unknown as {
      chrome: { storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } } };
    }).chrome.storage.local.get(STORAGE_KEY);
    const v = ((await stored)[STORAGE_KEY] as { version: number }).version;
    expect(v).toBe(CURRENT_SETTINGS_VERSION);
    expect(v).toBe(5);
  });
});
