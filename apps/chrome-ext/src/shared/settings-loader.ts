/**
 * 設定ローダー（マイグレーション統合版）。
 *
 * 既存 v0.2.0 ユーザーの fck_settings は version フィールドを持たない。
 * 拡張更新後の最初の起動で本ローダーが:
 *   1. fck_settings を読み込む
 *   2. version === 2 でなければ:
 *      - 旧データを `fck_settings_v1_backup` にバックアップ
 *      - `version: 2` を付与し DEFAULT_SETTINGS と merge して fck_settings に書き戻す
 *   3. version === 2 ならそのまま使用
 *
 * 設計判断（INTEG-01 時点）:
 * - shared の {@link import('@fresh-chat-keeper/shared').migrateSettings} は
 *   judgment-engine 用の v2 形式 (`categories.spoiler.{enabled,strength}` 構造) を
 *   返すが、chrome-ext の既存 Settings 型は `progressByGame` /
 *   `selectedGenreTemplates` / `proxyUrl` / `customNgWords` 等を保持する独自構造
 * - shared の migrateSettings をそのまま通すと chrome-ext 固有データが消失するため、
 *   chrome-ext 内部では既存 Settings 型を維持しつつ、`version: 2` フィールドの
 *   付与とバックアップ生成だけを担当する軽量マイグレーションを実装
 * - judgment-engine への引き渡し時のみ `filter-orchestrator.ts` 内で v2 形式に変換
 */

import {
  DEFAULT_SETTINGS,
  STORAGE_KEY,
  type Settings,
} from './settings.js';

/** マイグレーション時に作成されるバックアップキー */
export const SETTINGS_V1_BACKUP_KEY = 'fck_settings_v1_backup';

/**
 * 旧名拡張時代に使用していた `flc_*` プレフィックスキー。
 * 名称変更（"Fresh Live Chat" → "Fresh Chat Keeper"）以降、現コードは
 * すべて `fck_*` プレフィックスのみを使用するため、これらは orphan データ。
 *
 * `cleanupLegacyPrefixKeys()` で chrome.storage.local から削除する。
 */
const LEGACY_PREFIX_KEYS = [
  'flc_anon_token',
  'flc_filter_count',
  'flc_judge_cache',
  'flc_settings',
  'flc_stage2_usage',
] as const;

/**
 * 旧名拡張時代の `flc_*` プレフィックスキーを chrome.storage.local から削除する。
 *
 * - 該当キーが1つも存在しなければ no-op（早期リターン）
 * - 存在する場合は一括削除し、件数をログ出力
 * - 拡張起動ごとの重複実行を避けるため、background service worker 側の
 *   `onInstalled` / `onStartup` から呼び出すこと（content/popup からは呼ばない）
 *
 * @returns 削除したキーの件数（0 の場合は no-op）
 */
export async function cleanupLegacyPrefixKeys(): Promise<number> {
  const found = await chrome.storage.local.get([...LEGACY_PREFIX_KEYS]);
  const existingKeys = LEGACY_PREFIX_KEYS.filter((k) => k in found);
  if (existingKeys.length === 0) return 0;
  await chrome.storage.local.remove(existingKeys);
  console.log(
    `[FreshChatKeeper] Cleaned up ${existingKeys.length} legacy flc_* keys: ${existingKeys.join(', ')}`,
  );
  return existingKeys.length;
}

/**
 * 拡張内部で扱う Settings に version フィールドを付与した型。
 * chrome.storage 上の保存表現でのみ使用する（読み出し後はトップレベルから version を除いた {@link Settings} に統一）。
 */
export type StoredSettingsV2 = Settings & { version: 2 };

/**
 * chrome.storage.local から設定を読み込む。
 * v1 → v2 マイグレーションが必要な場合は自動的にバックアップを作成して書き戻す。
 *
 * 副作用:
 * - 初回マイグレーション時のみ `fck_settings_v1_backup` に旧データを保存
 * - 初回マイグレーション時のみ `fck_settings` を v2 形式に書き戻す
 */
export async function loadSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const raw = result[STORAGE_KEY];

  // 完全に未設定 → DEFAULT を返す（version 付与はしない、初期状態の保護）
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_SETTINGS };
  }

  // v2 既存
  if (isStoredV2(raw)) {
    return stripVersion(raw);
  }

  // v1 → v2 マイグレーション
  return await migrateLegacyToV2(raw);
}

function isStoredV2(raw: unknown): raw is StoredSettingsV2 {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as { version?: unknown }).version === 2
  );
}

function stripVersion(raw: StoredSettingsV2): Settings {
  const { version: _ignore, ...rest } = raw;
  void _ignore;
  return { ...DEFAULT_SETTINGS, ...rest };
}

/**
 * chrome.storage.local に設定を保存する。常に `version: 2` を付与するため、
 * 書き込み後の値は再度 {@link loadSettings} が v2 として認識する（v1 へ戻らない）。
 *
 * 直接 `chrome.storage.local.set({ [STORAGE_KEY]: ... })` を呼ぶと version
 * フィールドが剥がれてマイグレーションが繰り返し実行されるため、すべての
 * 設定保存はこの関数を経由する必要がある。
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const stored: StoredSettingsV2 = { ...settings, version: 2 };
  await chrome.storage.local.set({ [STORAGE_KEY]: stored });
}

async function migrateLegacyToV2(raw: unknown): Promise<Settings> {
  const isValidShape = typeof raw === 'object' && raw !== null && !Array.isArray(raw);

  if (!isValidShape) {
    // chrome.storage.local の fck_settings に不正な型が入っているケース。
    // 通常は v1 オブジェクトが期待されるが、過去の手動操作・拡張バグ・別拡張との
    // ストレージ衝突などで string / number / array 等が入ることがある。
    // DEFAULT_SETTINGS に倒すこと自体は妥当だが、サイレントにするとサポート時に
    // 原因究明できないため warn ログで型を可視化する。
    console.warn(
      `[FreshChatKeeper] Settings migration: unexpected raw type (${
        Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw
      }), falling back to DEFAULT_SETTINGS`,
    );
  }

  const partial = isValidShape ? (raw as Partial<Settings>) : {};

  const merged: Settings = { ...DEFAULT_SETTINGS, ...partial };
  const stored: StoredSettingsV2 = { ...merged, version: 2 };

  // バックアップを保存（既にバックアップが存在する場合は上書きしない）
  const backupExisting = await chrome.storage.local.get(SETTINGS_V1_BACKUP_KEY);
  const updates: Record<string, unknown> = { [STORAGE_KEY]: stored };
  if (backupExisting[SETTINGS_V1_BACKUP_KEY] === undefined) {
    updates[SETTINGS_V1_BACKUP_KEY] = raw;
  }
  await chrome.storage.local.set(updates);

  console.log(
    '[FreshChatKeeper] 設定スキーマを v2 にマイグレーションしました（旧データは fck_settings_v1_backup に保存）',
  );

  return merged;
}
