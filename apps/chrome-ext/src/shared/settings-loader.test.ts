/**
 * settings-loader.ts のマイグレーションテスト（AR-3 / version 6 時点）。
 *
 * 検証観点:
 * - v6 そのまま読み出し → バックアップ作成されない / audioContext 欠落は DEFAULT 補完
 * - v5 → v6: fck_settings_v5_backup に退避、version=6、captionContext 廃止 → audioContext(既定 OFF)
 * - v4/v3/v2/v1 → v6: 各 backup に独立退避、audioContext 補完
 * - 未設定 → DEFAULT / 不正型 → DEFAULT フォールバック
 * - saveSettings は常に version: 6
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
  SETTINGS_V5_BACKUP_KEY,
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

describe('settings-loader: v6 そのまま読み出し', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('version=6 の保存値をそのまま使い、バックアップを作成しない', async () => {
    const stored = { ...DEFAULT_SETTINGS, gameId: 'rdr2', version: 6 };
    fake.store.set(STORAGE_KEY, stored);
    const loaded = await loadSettings();
    expect(loaded.gameId).toBe('rdr2');
    expect((loaded as Settings & { version?: number }).version).toBeUndefined();
    expect(fake.store.has(SETTINGS_V5_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V4_BACKUP_KEY)).toBe(false);
  });

  it('audioContext 欠落の v6 データは DEFAULT マージで補完される', async () => {
    const stored: Record<string, unknown> = { ...DEFAULT_SETTINGS, version: 6 };
    delete stored.audioContext;
    fake.store.set(STORAGE_KEY, stored);
    const loaded = await loadSettings();
    expect(loaded.audioContext).toEqual(DEFAULT_SETTINGS.audioContext);
    expect(loaded.audioContext.enabled).toBe(false);
  });
});

describe('settings-loader: v5 → v6 マイグレーション（captionContext 廃止）', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('v5（captionContext.enabled=true）を読むと v5_backup に退避、audioContext は一律 OFF で開始', async () => {
    const v5Data = {
      ...DEFAULT_SETTINGS,
      gameId: 'rdr2',
      version: 5,
      // 旧 captionContext（ON にしていたユーザー）— 値は引き継がない。
      captionContext: { enabled: true, windowSeconds: 120, qualityThreshold: 'strict' },
    };
    delete (v5Data as Record<string, unknown>).audioContext;
    fake.store.set(STORAGE_KEY, v5Data);

    const loaded = await loadSettings();

    expect(loaded.gameId).toBe('rdr2');
    // audioContext は DEFAULT（既定 OFF）で開始（旧 captionContext の ON は引き継がない）
    expect(loaded.audioContext).toEqual(DEFAULT_SETTINGS.audioContext);
    expect(loaded.audioContext.enabled).toBe(false);
    // 廃止フィールド captionContext は読み出し結果から消えている
    expect('captionContext' in loaded).toBe(false);
    // 旧 v5 データが backup に退避（captionContext 込みで丸ごと）
    expect(fake.store.get(SETTINGS_V5_BACKUP_KEY)).toEqual(v5Data);
    const written = fake.store.get(STORAGE_KEY) as { version?: number; captionContext?: unknown };
    expect(written.version).toBe(6);
    // 書き戻し後の保存値にも captionContext は残らない
    expect('captionContext' in written).toBe(false);
  });

  it('他世代 backup は v5 → v6 では作成されない（独立バックアップ）', async () => {
    fake.store.set(STORAGE_KEY, { ...DEFAULT_SETTINGS, version: 5 });
    await loadSettings();
    expect(fake.store.has(SETTINGS_V5_BACKUP_KEY)).toBe(true);
    expect(fake.store.has(SETTINGS_V1_BACKUP_KEY)).toBe(false);
    expect(fake.store.has(SETTINGS_V4_BACKUP_KEY)).toBe(false);
  });

  it('既存の v5 backup は上書きされない（一度書いたら不変）', async () => {
    const earlierBackup = { gameId: 'earlier', version: 5 };
    fake.store.set(SETTINGS_V5_BACKUP_KEY, earlierBackup);
    fake.store.set(STORAGE_KEY, { ...DEFAULT_SETTINGS, version: 5 });
    await loadSettings();
    expect(fake.store.get(SETTINGS_V5_BACKUP_KEY)).toEqual(earlierBackup);
  });
});

describe('settings-loader: v4 → v6 マイグレーション', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('v4 保存値を読むと fck_settings_v4_backup に退避され version: 6 で書き戻される', async () => {
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
    delete (v4Data as Record<string, unknown>).captionContext;
    delete (v4Data as Record<string, unknown>).audioContext;
    fake.store.set(STORAGE_KEY, v4Data);

    const loaded = await loadSettings();

    expect(loaded.gameId).toBe('rdr2');
    expect(loaded.userFlagging.enabled).toBe(true);
    expect(loaded.userFlagging.scope).toBe('7d');
    // audioContext は DEFAULT 補完（オプトイン既定 OFF）
    expect(loaded.audioContext).toEqual(DEFAULT_SETTINGS.audioContext);
    expect(fake.store.get(SETTINGS_V4_BACKUP_KEY)).toEqual(v4Data);
    const written = fake.store.get(STORAGE_KEY) as { version?: number };
    expect(written.version).toBe(6);
  });
});

describe('settings-loader: v3 → v6 マイグレーション', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('v3 保存値を読むと fck_settings_v3_backup に退避され version: 6 で書き戻される', async () => {
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
    expect(loaded.userFlagging).toEqual(DEFAULT_SETTINGS.userFlagging);
    expect(loaded.audioContext).toEqual(DEFAULT_SETTINGS.audioContext);
    expect(fake.store.get(SETTINGS_V3_BACKUP_KEY)).toEqual(v3Data);
    expect((fake.store.get(STORAGE_KEY) as { version?: number }).version).toBe(6);
  });
});

describe('settings-loader: v2 / v1 → v6 マイグレーション', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('v2 → fck_settings_v2_backup に退避 + audioContext 補完', async () => {
    const v2Data = { gameId: 'rdr2', enabled: true, version: 2 };
    fake.store.set(STORAGE_KEY, v2Data);
    const loaded = await loadSettings();
    expect(loaded.gameId).toBe('rdr2');
    expect(loaded.audioContext).toEqual(DEFAULT_SETTINGS.audioContext);
    expect(fake.store.get(SETTINGS_V2_BACKUP_KEY)).toEqual(v2Data);
    expect((fake.store.get(STORAGE_KEY) as { version: number }).version).toBe(6);
  });

  it('version フィールドなし（v1）→ fck_settings_v1_backup + audioContext 補完', async () => {
    const v1Data = { gameId: 'rdr2', enabled: true };
    fake.store.set(STORAGE_KEY, v1Data);
    const loaded = await loadSettings();
    expect(loaded.gameId).toBe('rdr2');
    expect(loaded.audioContext).toEqual(DEFAULT_SETTINGS.audioContext);
    expect(fake.store.get(SETTINGS_V1_BACKUP_KEY)).toEqual(v1Data);
    expect((fake.store.get(STORAGE_KEY) as { version: number }).version).toBe(6);
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

  it('保存時は常に version: 6 が付く', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, gameId: 'rdr2' });
    const stored = (globalThis as unknown as {
      chrome: { storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } } };
    }).chrome.storage.local.get(STORAGE_KEY);
    const v = ((await stored)[STORAGE_KEY] as { version: number }).version;
    expect(v).toBe(CURRENT_SETTINGS_VERSION);
    expect(v).toBe(6);
  });
});
