/**
 * 設定スキーマ v1 → v2 → v3 マイグレーション関数。
 *
 * - v1（version フィールドなし、`filterStrength` をトップレベルに持つ）
 * - v2（version: 2、`categories.spoiler.{enabled,strength}` 構造、Phase 2 で稼働）
 * - v3（version: 3、Phase 3 マルチラベル化、`offTopic`/`backseat` に `strength` 追加、
 *   `userBlocks` 新設）
 *
 * 設計原則（dev-docs/architecture.md §7.2、phase-2-engine-split.md §設定スキーマ、
 * dev-docs/phase-3-multilabel.md「設定スキーマ v2→v3 マイグレーション」）:
 * - **Idempotent**: 既に v3 がそのまま渡された場合は値を変えずに返す
 * - **不正な入力に強い**: undefined / null / 配列 / 部分欠落でもクラッシュせず default にフォールバック
 * - **既存挙動を変えない**: v1/v2 ユーザーの enabled/strength はそのまま継承、新カテゴリは OFF で開始
 * - **新フィールドは安全側のデフォルト**: 新カテゴリは `enabled: false`、`userBlocks` は空、
 *   `userTier` は `'free'`、`customBlockWords` は `[]`
 *
 * バックアップ保存は本関数の責務外。Chrome 拡張側の settings-loader.ts で
 * {@link SETTINGS_V1_BACKUP_KEY} / {@link SETTINGS_V2_BACKUP_KEY} 経由で実施する。
 */

import type {
  FilterSettings,
  FilterSettingsV1,
  FilterSettingsV2,
  GameContext,
} from './types/settings.js';

/**
 * v1 → v2 マイグレーション時のバックアップキー（既存）。
 * chrome-ext の settings-loader.ts が使用する。
 */
export const SETTINGS_V1_BACKUP_KEY = 'fck_settings_v1_backup';

/**
 * v2 → v3 マイグレーション時のバックアップキー（Phase 3 新規）。
 *
 * CLAUDE.md「内部識別子の命名規則」のバックアップ系ストレージキー規約
 * `fck_<original>_v{N}_backup` に従う。chrome-ext の settings-loader.ts が
 * v3 化のタイミングで v2 データをここに保存する（B3 で配線予定）。
 */
export const SETTINGS_V2_BACKUP_KEY = 'fck_settings_v2_backup';

/**
 * v3 → v4 マイグレーション時のバックアップキー（Phase 3.5 / v0.5.0 新規）。
 *
 * v0.4.0 の version: 3 設定（categories / userBlocks / triggerVisibility）を
 * 保持したまま v4（userFlagging 追加）に書き換える際の退避先。判定エンジン側の
 * `FilterSettings` は引き続き v3 構造を使い、chrome-ext 内部の `Settings`
 * 型だけが v4 に進む軽量移行（phase-3-5-user-flagging.md 改訂3）。
 */
export const SETTINGS_V3_BACKUP_KEY = 'fck_settings_v3_backup';

/**
 * v4 → v5 マイグレーション時のバックアップキー（Phase 5 / v0.6.0 新規）。
 *
 * v0.5.0 の version: 4 設定（userFlagging 含む）を保持したまま v5
 * （captionContext 追加）に書き換える際の退避先。chrome-ext 内部の `Settings`
 * 型だけが v5 に進む軽量移行（phase-5-audio-context.md 訂正2）。
 */
export const SETTINGS_V4_BACKUP_KEY = 'fck_settings_v4_backup';

/**
 * v5 → v6 マイグレーション時のバックアップキー（Phase 7 / AR-3 新規）。
 *
 * v0.6.0 の version: 5 設定（captionContext 含む）を保持したまま v6
 * （captionContext 廃止 → audioContext 新設）に書き換える際の退避先。
 */
export const SETTINGS_V5_BACKUP_KEY = 'fck_settings_v5_backup';

/** v3 のデフォルト値（不正入力時のフォールバック） */
function getDefaultSettings(): FilterSettings {
  return {
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
    triggerVisibility: 'hover_only',
  };
}

/** プレーンオブジェクトかどうか（null・配列・プリミティブを除外） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** v1 で許容される displayMode 値か */
function isDisplayMode(value: unknown): value is FilterSettings['displayMode'] {
  return value === 'placeholder' || value === 'hidden';
}

/** v1 で許容される filterMode 値か */
function isFilterMode(value: unknown): value is FilterSettings['filterMode'] {
  return value === 'archive' || value === 'live';
}

/** v1 の filterStrength（loose/standard/strict）か */
function isFilterStrength(value: unknown): value is 'loose' | 'standard' | 'strict' {
  return value === 'loose' || value === 'standard' || value === 'strict';
}

/** v2 / v3 の userTier 値か */
function isUserTier(value: unknown): value is FilterSettings['userTier'] {
  return value === 'free' || value === 'premium' || value === 'streamer';
}

/** v3 の triggerVisibility 値か（B5-fix 新規） */
function isTriggerVisibility(
  value: unknown,
): value is NonNullable<FilterSettings['triggerVisibility']> {
  return value === 'hover_only' || value === 'always';
}

/** GameContext として妥当か（progressType だけ最低限チェック） */
function isGameContext(value: unknown): value is GameContext {
  if (!isPlainObject(value)) return false;
  const pt = value.progressType;
  return pt === 'chapter' || pt === 'event' || pt === 'none';
}

/** string[] として妥当か（要素が全て string） */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** userBlocks.metadata の単一エントリとして妥当か */
function isUserBlockMetadataEntry(
  value: unknown,
): value is { displayNameAtBlock: string; blockedAt: number; reason?: string } {
  if (!isPlainObject(value)) return false;
  if (typeof value.displayNameAtBlock !== 'string') return false;
  if (typeof value.blockedAt !== 'number' || Number.isNaN(value.blockedAt)) return false;
  if (value.reason !== undefined && typeof value.reason !== 'string') return false;
  return true;
}

/**
 * v3 オブジェクトの categories セクションを「正しい形」に整える。
 * 部分欠落は default で補い、不正な値は default で上書き。
 */
function ensureCategoriesV3(categoriesRaw: unknown): FilterSettings['categories'] {
  const c = isPlainObject(categoriesRaw) ? categoriesRaw : {};
  const spoilerRaw = isPlainObject(c.spoiler) ? c.spoiler : {};

  const categories: FilterSettings['categories'] = {
    spoiler: {
      enabled: typeof spoilerRaw.enabled === 'boolean' ? spoilerRaw.enabled : true,
      strength: isFilterStrength(spoilerRaw.strength) ? spoilerRaw.strength : 'standard',
    },
    harassment: { enabled: false, strength: 'standard' },
    spam: { enabled: false },
    offTopic: { enabled: false, strength: 'standard' },
    backseat: { enabled: false, strength: 'standard' },
  };

  if (isPlainObject(c.harassment)) {
    const h = c.harassment;
    categories.harassment = {
      enabled: typeof h.enabled === 'boolean' ? h.enabled : false,
      strength: isFilterStrength(h.strength) ? h.strength : 'standard',
    };
  }
  if (isPlainObject(c.spam)) {
    categories.spam = {
      enabled: typeof c.spam.enabled === 'boolean' ? c.spam.enabled : false,
    };
  }
  if (isPlainObject(c.offTopic)) {
    const o = c.offTopic;
    categories.offTopic = {
      enabled: typeof o.enabled === 'boolean' ? o.enabled : false,
      // v2 では strength なし。欠落していたら 'standard' で補完（v2→v3 の差分埋め）
      strength: isFilterStrength(o.strength) ? o.strength : 'standard',
    };
  }
  if (isPlainObject(c.backseat)) {
    const b = c.backseat;
    categories.backseat = {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : false,
      strength: isFilterStrength(b.strength) ? b.strength : 'standard',
    };
  }

  return categories;
}

/** userBlocks セクションを正規化する（部分欠落は安全側のデフォルトで埋める） */
function ensureUserBlocksV3(raw: unknown): FilterSettings['userBlocks'] {
  if (!isPlainObject(raw)) return { channelIds: [], metadata: {} };
  const channelIds = isStringArray(raw.channelIds) ? raw.channelIds : [];
  const metadataRaw = isPlainObject(raw.metadata) ? raw.metadata : {};

  const metadata: NonNullable<FilterSettings['userBlocks']>['metadata'] = {};
  let droppedCount = 0;
  for (const [channelId, entry] of Object.entries(metadataRaw)) {
    if (isUserBlockMetadataEntry(entry)) {
      metadata[channelId] = entry;
    } else {
      droppedCount++;
    }
  }
  // B4a hardening 🟢: 無言ドロップは調査困難。件数を 1 行 warn で可視化。
  if (droppedCount > 0) {
    console.warn(
      `[FreshChatKeeper] migrateSettings: dropped ${droppedCount} malformed userBlocks.metadata entr${
        droppedCount === 1 ? 'y' : 'ies'
      }`,
    );
  }
  return { channelIds, metadata };
}

/**
 * v3 オブジェクトを「正しい形」に整える。
 *
 * `version: 3` が確定したオブジェクトに対して、部分欠落・不正値を default に
 * フォールバックさせる。不明なフィールドは保持しない。
 */
function ensureV3Shape(raw: Record<string, unknown>): FilterSettings {
  const defaults = getDefaultSettings();

  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled;
  const displayMode = isDisplayMode(raw.displayMode) ? raw.displayMode : defaults.displayMode;
  const filterMode = isFilterMode(raw.filterMode) ? raw.filterMode : defaults.filterMode;
  const customBlockWords = isStringArray(raw.customBlockWords)
    ? raw.customBlockWords
    : defaults.customBlockWords;
  const userTier = isUserTier(raw.userTier) ? raw.userTier : defaults.userTier;
  const gameContext = isGameContext(raw.gameContext) ? raw.gameContext : undefined;
  // B5-fix: 未設定 / 不正値は既定 'hover_only'（既存 v3 も後方互換）
  const triggerVisibility = isTriggerVisibility(raw.triggerVisibility)
    ? raw.triggerVisibility
    : defaults.triggerVisibility;

  return {
    version: 3,
    enabled,
    displayMode,
    filterMode,
    categories: ensureCategoriesV3(raw.categories),
    userBlocks: ensureUserBlocksV3(raw.userBlocks),
    customBlockWords,
    userTier,
    triggerVisibility,
    ...(gameContext ? { gameContext } : {}),
  };
}

/**
 * v2 → v3 への変換。
 *
 * 構造的に v2 はほぼ v3 のサブセット（version と offTopic/backseat の strength 有無、
 * userBlocks の有無のみが差分）。`ensureV3Shape` が v2 形状の入力を v3 形状に
 * 整える役割をそのまま流用できるので、本関数は薄いラッパー。
 */
function migrateV2ToV3(v2: FilterSettingsV2): FilterSettings {
  // v2 オブジェクトを Record<string, unknown> として渡し、ensureV3Shape で
  // version 上書き + 欠落フィールド補完 + 新カテゴリの strength 補完を行う
  return ensureV3Shape(v2 as unknown as Record<string, unknown>);
}

/**
 * v1 → v3 への変換。
 *
 * - `filterStrength` トップレベル → `categories.spoiler.{enabled: true, strength}`
 * - `userTier` は `'free'` をデフォルト
 * - `customBlockWords` 未定義は `[]`
 * - `gameContext` はそのまま継承（構造変化なし）
 * - `enabled === false` でも `categories.spoiler.enabled` は `true` を保つ
 *   （旧 enabled は「拡張全体の有効/無効」を意味し、新 enabled は「拡張全体」と
 *   「カテゴリ別」の2階建て。v1 ユーザーが『spoiler フィルタを完全に切る』意図で
 *   保存したわけではないので、カテゴリ側は規定通り ON のまま継承する）
 * - Phase 3 で追加された新カテゴリ（harassment/spam/offTopic/backseat）は OFF で初期化
 * - `userBlocks` は空で初期化
 */
function migrateV1ToV3(v1: FilterSettingsV1): FilterSettings {
  const strength: 'loose' | 'standard' | 'strict' = isFilterStrength(v1.filterStrength)
    ? v1.filterStrength
    : 'standard';

  const result: FilterSettings = {
    version: 3,
    enabled: typeof v1.enabled === 'boolean' ? v1.enabled : true,
    displayMode: isDisplayMode(v1.displayMode) ? v1.displayMode : 'placeholder',
    filterMode: isFilterMode(v1.filterMode) ? v1.filterMode : 'archive',
    categories: {
      spoiler: { enabled: true, strength },
      harassment: { enabled: false, strength: 'standard' },
      spam: { enabled: false },
      offTopic: { enabled: false, strength: 'standard' },
      backseat: { enabled: false, strength: 'standard' },
    },
    userBlocks: { channelIds: [], metadata: {} },
    customBlockWords: isStringArray(v1.customBlockWords) ? v1.customBlockWords : [],
    userTier: 'free',
    triggerVisibility: 'hover_only',
  };

  if (isGameContext(v1.gameContext)) {
    result.gameContext = v1.gameContext;
  }

  return result;
}

/**
 * 任意の入力を v3 の {@link FilterSettings} に正規化する。
 *
 * 入力パターン:
 * - `null` / `undefined` / 非オブジェクト → デフォルト v3
 * - `{ version: 3, ... }` → ensureV3Shape を通して整形（idempotent）
 * - `{ version: 2, ... }` → v2 として v3 に変換（新カテゴリは OFF / 既存値を保持）
 * - `{ version: undefined, filterStrength, ... }` → v1 とみなして v3 に変換
 * - 部分的に欠けたオブジェクト → 該当フィールドのみ default で補う
 *
 * 本関数は副作用を持たない。バックアップ保存は呼び出し側の責務
 * （`SETTINGS_V1_BACKUP_KEY` / `SETTINGS_V2_BACKUP_KEY` 参照）。
 */
export function migrateSettings(raw: unknown): FilterSettings {
  if (!isPlainObject(raw)) {
    return getDefaultSettings();
  }

  if (raw.version === 3) {
    return ensureV3Shape(raw);
  }

  if (raw.version === 2) {
    // v2 として narrowing。各フィールドの型は ensureV3Shape 内で再検証される。
    return migrateV2ToV3(raw as unknown as FilterSettingsV2);
  }

  // v1（version なし or 不明な値）として変換。
  // 入力は Record<string, unknown> でフィールドが欠けている可能性があるが、
  // migrateV1ToV3 内で各フィールドを isXxx ガードして安全に処理するため、
  // unknown 経由で FilterSettingsV1 に narrowing する。
  return migrateV1ToV3(raw as unknown as FilterSettingsV1);
}
