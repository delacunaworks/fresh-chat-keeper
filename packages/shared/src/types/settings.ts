/**
 * ユーザー設定の型定義（v1 / v2 / v3）と関連型。
 *
 * 注: このファイルにより `@fresh-chat-keeper/shared` の責務は
 * 「型・ユーティリティ置き場」から「アプリ設定スキーマの中心」へと拡大している。
 * これは Phase 2 設計書（dev-docs/architecture.md §4.2 および
 * dev-docs/phase-2-engine-split.md §依存ルール）に基づく意図的な配置で、
 * `judgment-engine → shared` の単方向依存を維持し、設定マイグレーション関数
 * （P2-MIG-01: settings-migration.ts、Phase 3 で v3 へ拡張）と同じパッケージに
 * 型を置く必要があるため。
 *
 * v3 ＝ FilterSettings (canonical) は v2 と構造的に大きく違わない:
 *   - version: 3 に変更
 *   - categories に harassment/spam/offTopic/backseat のサブ構造（offTopic/backseat
 *     には strength が追加、v2 では enabled のみだった）
 *   - userBlocks（ユーザーブロック機能、Phase 3 新規）
 *
 * 互換性の原則:
 *   - **harassment/spam/offTopic/backseat/userBlocks は型上 optional のまま** にする。
 *     migrateSettings 経由で読み込まれた値は migration が必ず populate するが、型を
 *     必須化すると filter-orchestrator 等の chrome-ext 既存コードが壊れるため。
 *   - **v2 既存のコードは構造的に v3 と互換**: `categories.spoiler.{enabled,strength}`
 *     は変わらないので、v2 形式の FilterSettings リテラル（{ version: 2, ... }）も
 *     v3 のサブセットとして扱える（version フィールドだけが違う）。
 */

/**
 * ゲーム進行コンテキスト。判定エンジンへの入力に含める。
 *
 * 既存の {@link UserProgress}（v1構造）と異なり、ゲームタイトルや
 * ジャンルテンプレート等の判定エンジンが必要とする情報も含む。
 */
export interface GameContext {
  /** 知識ベース上のゲームID。ジャンルテンプレートのみで判定する場合は省略 */
  gameId?: string;
  /** ゲームタイトル（動画タイトルからの自動推測結果を含む） */
  gameTitle?: string;
  /** 進行管理モデル */
  progressType: 'chapter' | 'event' | 'none';
  /** チャプターベース時の現在チャプターID */
  currentChapter?: string;
  /** イベントベース時の通過済みイベントIDリスト */
  completedEvents?: string[];
  /** 適用するジャンルテンプレートID */
  genreTemplate?: string;
}

/**
 * Phase 1（v0.2.0以前）でリリース済みの設定スキーマ。
 *
 * `version` フィールドが存在しないオブジェクトは v1 とみなす。
 * P2-MIG-01 の {@link migrateSettings} で v3 へ変換される（v1→v2→v3 の2段階）。
 *
 * @todo 互換期間を経て削除予定
 */
export interface FilterSettingsV1 {
  /** v1 では未定義（versionフィールドなし） */
  version?: undefined;
  enabled: boolean;
  displayMode: 'placeholder' | 'hidden';
  filterMode: 'archive' | 'live';
  filterStrength: 'loose' | 'standard' | 'strict';
  gameContext?: GameContext;
  customBlockWords?: string[];
}

/**
 * Phase 2（v0.3.0〜v0.3.5）の設定スキーマ。
 *
 * Phase 3（v0.4.0）で {@link FilterSettings}（= v3）が canonical になったが、
 * 既存ユーザーの chrome.storage には v2 形式のデータが残っているため、本型は
 * マイグレーション入力として保持される。
 *
 * v2 と v3 の主な差分:
 *   - v2: `version: 2`、`offTopic?: { enabled }`、`backseat?: { enabled }`、`userBlocks` なし
 *   - v3: `version: 3`、`offTopic?: { enabled, strength }`、`backseat?: { enabled, strength }`、`userBlocks` あり
 */
export interface FilterSettingsV2 {
  /** スキーマバージョン。常に 2 */
  version: 2;
  enabled: boolean;
  displayMode: 'placeholder' | 'hidden';
  filterMode: 'archive' | 'live';
  categories: {
    spoiler: {
      enabled: boolean;
      strength: 'loose' | 'standard' | 'strict';
    };
    harassment?: {
      enabled: boolean;
      strength: 'loose' | 'standard' | 'strict';
    };
    spam?: { enabled: boolean };
    offTopic?: { enabled: boolean };
    backseat?: { enabled: boolean };
  };
  customBlockWords: string[];
  userTier: 'free' | 'premium' | 'streamer';
  gameContext?: GameContext;
}

/**
 * Phase 3（v0.4.0〜）の設定スキーマ（canonical）。
 *
 * マルチラベル判定とユーザーブロック機能の導入に伴う構造拡張:
 *   - `version: 3`
 *   - `categories.harassment` / `spam` / `offTopic` / `backseat` を正式サポート
 *     （offTopic / backseat には強度設定 `strength` が新規追加）
 *   - `userBlocks` でブロック済みチャンネル一覧を保持
 *
 * **型上は新カテゴリ / userBlocks を optional のまま** にしている。実用上、
 * {@link migrateSettings} を通した値はすべて populate されているが、既存の
 * chrome-ext / proxy の v2-shape リテラル構築コード（filter-orchestrator 等）を
 * 壊さないため optional を維持。Phase 3 後半（v0.4.0 リリース後）に
 * required 化を検討する。
 */
export interface FilterSettingsV3 {
  /** スキーマバージョン。常に 3 */
  version: 3;
  enabled: boolean;
  displayMode: 'placeholder' | 'hidden';
  filterMode: 'archive' | 'live';
  /** フィルタカテゴリ別の設定（マルチラベル判定対応） */
  categories: {
    spoiler: {
      enabled: boolean;
      strength: 'loose' | 'standard' | 'strict';
    };
    harassment?: {
      enabled: boolean;
      strength: 'loose' | 'standard' | 'strict';
    };
    spam?: { enabled: boolean };
    offTopic?: {
      enabled: boolean;
      strength: 'loose' | 'standard' | 'strict';
    };
    backseat?: {
      enabled: boolean;
      strength: 'loose' | 'standard' | 'strict';
    };
  };
  /**
   * ユーザーブロック機能（Phase 3 新規）。
   * `channelIds` にブロック中の YouTube チャンネルIDを保持し、
   * `metadata[channelId]` に表示名・ブロック時刻を保持する。
   */
  userBlocks?: {
    channelIds: string[];
    metadata: Record<
      string,
      {
        displayNameAtBlock: string;
        blockedAt: number;
        reason?: string;
      }
    >;
  };
  /** ユーザー定義のカスタムNGワード */
  customBlockWords: string[];
  /** ユーザーティア。判定エンジンのモデル選択・利用上限に影響 */
  userTier: 'free' | 'premium' | 'streamer';
  /** プレイ中のゲーム情報。設定されていない場合は判定時に未指定として扱う */
  gameContext?: GameContext;
  /**
   * 行内トリガ（ブロック/報告アイコン）の表示モード（Phase 3 B5-fix 新規）。
   * - `hover_only`（既定）: 行ホバー時のみ表示
   * - `always`: 常に薄く表示
   *
   * 型上は optional（既存 v3 データに無くても後方互換。migrateSettings は
   * 未設定なら `'hover_only'` を populate する）。
   */
  triggerVisibility?: 'hover_only' | 'always';
}

/**
 * canonical な設定型。
 *
 * Phase 2 では V2、Phase 3（v0.4.0）以降は V3 を指す。
 * 既存コードで `FilterSettings` を import している箇所は自動的に v3 を見るが、
 * 構造上 v2 リテラル（`{ version: 2, ... }` で新カテゴリを含まないもの）は
 * v3 と互換ではないので、リテラル構築側は順次 `version: 3` + デフォルト値に
 * 移行していくこと（移行作業自体は B3 以降の chrome-ext/proxy 統合で実施）。
 */
export type FilterSettings = FilterSettingsV3;
