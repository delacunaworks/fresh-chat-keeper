/**
 * 設定ローダー（マイグレーション統合版）。
 *
 * 既存ユーザーの fck_settings は世代ごとに version 値が異なる:
 *   - v0.2.0 以前: version フィールドなし（= v1）
 *   - v0.3.0〜v0.3.5: version: 2
 *   - v0.4.0〜（Phase 3）: version: 3
 *
 * 拡張更新後の最初の起動で本ローダーが:
 *   1. fck_settings を読み込む
 *   2. version === 3 ならそのまま使用（最新世代）
 *   3. version === 2 なら:
 *      - 旧データを `fck_settings_v2_backup` にバックアップ
 *      - version: 3 を付与して fck_settings に書き戻す
 *   4. version フィールドなし（v1）なら:
 *      - 旧データを `fck_settings_v1_backup` にバックアップ
 *      - version: 3 を付与して fck_settings に書き戻す
 *
 * 設計判断:
 * - shared の {@link import('@fresh-chat-keeper/shared').migrateSettings} は
 *   judgment-engine 用の **FilterSettings**（categories.spoiler 構造 + Phase 3
 *   マルチラベルカテゴリ + userBlocks）を返すが、chrome-ext の保存形式 (`Settings`)
 *   は `progressByGame` / `selectedGenreTemplates` / `proxyUrl` / `customNgWords`
 *   等を保持する独自構造で、両者は別物。
 * - chrome-ext 内部では既存 `Settings` 型を維持しつつ、`version` フィールドの
 *   付与とバックアップ生成だけを担当する軽量マイグレーションを実装する。
 *   judgment-engine / proxy への引き渡し時のみ `filter-orchestrator.ts` 内で
 *   FilterSettings (v3) 形式に変換する。
 * - **B3 hardening（B2 typescript-reviewer 対応）**: 以前は保存時に常に
 *   `version: 2` を固定で書いていたため、v3 を読み込んでも保存のたびに v2 に
 *   退行し、`fck_settings_v2_backup` バックアップが毎回再生成される（実質
 *   無限ループ）バグがあった。保存時は最新世代 `version: 3` を書く。
 * - バックアップキー定数は shared（`SETTINGS_V1_BACKUP_KEY` /
 *   `SETTINGS_V2_BACKUP_KEY`、CLAUDE.md `fck_<original>_v{N}_backup` 規約準拠）
 *   を単一の真実として再利用する。
 */

import {
  SETTINGS_V1_BACKUP_KEY as SHARED_V1_BACKUP_KEY,
  SETTINGS_V2_BACKUP_KEY as SHARED_V2_BACKUP_KEY,
} from '@fresh-chat-keeper/shared';
import {
  DEFAULT_SETTINGS,
  STORAGE_KEY,
  type Settings,
} from './settings.js';

/** chrome-ext 設定の最新スキーマ世代。v0.4.0 / Phase 3 以降は 3。 */
export const CURRENT_SETTINGS_VERSION = 3 as const;

/**
 * v1 → 現行世代マイグレーション時のバックアップキー。
 * shared 定数（`fck_settings_v1_backup`）を再エクスポートし二重定義を避ける。
 */
export const SETTINGS_V1_BACKUP_KEY = SHARED_V1_BACKUP_KEY;

/**
 * v2 → v3 マイグレーション時のバックアップキー（Phase 3 新規）。
 * shared 定数（`fck_settings_v2_backup`）を再エクスポート。
 */
export const SETTINGS_V2_BACKUP_KEY = SHARED_V2_BACKUP_KEY;

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
 * 拡張内部で扱う Settings に version フィールドを付与した保存表現型。
 * chrome.storage 上の保存表現でのみ使用する（読み出し後はトップレベルから
 * version を除いた {@link Settings} に統一）。
 */
export type StoredSettings = Settings & { version: typeof CURRENT_SETTINGS_VERSION };

/**
 * chrome.storage.local から設定を読み込む。
 * 旧世代（v1 / v2）からのマイグレーションが必要な場合は自動的にバックアップを
 * 作成して v3 形式で書き戻す。
 *
 * 副作用（初回マイグレーション時のみ）:
 * - v1 → `fck_settings_v1_backup` に旧データを保存
 * - v2 → `fck_settings_v2_backup` に旧データを保存
 * - `fck_settings` を v3 形式に書き戻す
 */
export async function loadSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const raw = result[STORAGE_KEY];

  // 完全に未設定 → DEFAULT を返す（version 付与はしない、初期状態の保護）
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_SETTINGS };
  }

  const storedVersion = readStoredVersion(raw);

  // 最新世代（v3）: そのまま使用
  if (storedVersion === CURRENT_SETTINGS_VERSION) {
    return stripVersion(raw as StoredSettings);
  }

  // v2 → v3: fck_settings_v2_backup に退避してから書き戻し
  if (storedVersion === 2) {
    return await migrateToCurrentVersion(raw, SETTINGS_V2_BACKUP_KEY, 'v2 → v3');
  }

  // version なし（v1）or 不明な値 → v1 backup に退避してから書き戻し
  return await migrateToCurrentVersion(raw, SETTINGS_V1_BACKUP_KEY, 'v1 → v3');
}

/**
 * 保存済み raw データから version 値を読み取る。
 * - プレーンオブジェクトでない → null（呼び出し側で v1 扱い・DEFAULT フォールバック）
 * - version フィールドなし → undefined（v1 扱い）
 * - version: number → その値
 */
function readStoredVersion(raw: unknown): number | undefined | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = (raw as { version?: unknown }).version;
  return typeof v === 'number' ? v : undefined;
}

function stripVersion(raw: StoredSettings): Settings {
  const { version: _ignore, ...rest } = raw;
  void _ignore;
  return { ...DEFAULT_SETTINGS, ...rest };
}

/**
 * chrome.storage.local に設定を保存する。常に最新世代 `version: 3` を付与する。
 *
 * 直接 `chrome.storage.local.set({ [STORAGE_KEY]: ... })` を呼ぶと version
 * フィールドが剥がれて毎回マイグレーション + バックアップ再生成が走るため、
 * すべての設定保存はこの関数を経由する必要がある。
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const stored: StoredSettings = { ...settings, version: CURRENT_SETTINGS_VERSION };
  await chrome.storage.local.set({ [STORAGE_KEY]: stored });
}

/**
 * 旧世代データを指定バックアップキーに退避し、v3 形式で書き戻す共通処理。
 *
 * @param raw 保存済みの旧データ（不正型もありうる）
 * @param backupKey 退避先キー（v1 or v2 backup）
 * @param label ログ用のマイグレーションラベル
 */
async function migrateToCurrentVersion(
  raw: unknown,
  backupKey: string,
  label: string,
): Promise<Settings> {
  const isValidShape = typeof raw === 'object' && raw !== null && !Array.isArray(raw);

  if (!isValidShape) {
    // chrome.storage.local の fck_settings に不正な型が入っているケース。
    // 通常は旧 Settings オブジェクトが期待されるが、過去の手動操作・拡張バグ・
    // 別拡張とのストレージ衝突などで string / number / array 等が入ることがある。
    // DEFAULT_SETTINGS に倒すこと自体は妥当だが、サイレントにするとサポート時に
    // 原因究明できないため warn ログで型を可視化する。
    console.warn(
      `[FreshChatKeeper] Settings migration (${label}): unexpected raw type (${
        Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw
      }), falling back to DEFAULT_SETTINGS`,
    );
  }

  const partial = isValidShape ? (raw as Partial<Settings>) : {};
  const merged: Settings = { ...DEFAULT_SETTINGS, ...partial };
  // version は付け直すので merged 側に残った旧 version は stored で上書きされる
  const stored: StoredSettings = { ...merged, version: CURRENT_SETTINGS_VERSION };

  // バックアップを保存（既にバックアップが存在する場合は上書きしない）。
  // backupKey が違えば v1 と v2 のバックアップは独立して保持される。
  const backupExisting = await chrome.storage.local.get(backupKey);
  const updates: Record<string, unknown> = { [STORAGE_KEY]: stored };
  if (backupExisting[backupKey] === undefined) {
    updates[backupKey] = raw;
  }
  await chrome.storage.local.set(updates);

  console.log(
    `[FreshChatKeeper] 設定スキーマを v3 にマイグレーションしました（${label}、旧データは ${backupKey} に保存）`,
  );

  return merged;
}
