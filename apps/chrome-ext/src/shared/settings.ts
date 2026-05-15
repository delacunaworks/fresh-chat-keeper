/**
 * 拡張機能の設定型定義と chrome.storage ヘルパー
 * ポップアップ / Content Script の両方から参照する
 */

import type { MisreportEntry } from '@fresh-chat-keeper/shared';

export type FilterMode = 'strict' | 'standard' | 'lenient';
export type DisplayMode = 'placeholder' | 'hidden';

/**
 * 行内トリガ（ブロック/報告アイコン ⋯）の表示モード（B5-fix）。
 * - `hover_only`（既定）: 行ホバー時のみ表示（YouTube `#menu` と同挙動。
 *   通常は何も出ず、折り返し本文への被り・常時の視界ノイズが消える）
 * - `always`: 常に薄く表示し、ホバーで濃く（B5 までの挙動）
 *
 * タッチ環境（hover 不可）はモードに関わらず常時可視寄り（CSS 側で担保）。
 */
export type TriggerVisibility = 'hover_only' | 'always';

/** Phase 3 マルチラベル新カテゴリの強度（spam は強度なし） */
export type CategoryStrength = 'loose' | 'standard' | 'strict';

/**
 * Phase 3（v0.4.0 / P3-UI-04）で追加された新カテゴリ設定。
 *
 * spoiler は従来どおり「基本」タブの {@link Settings.filterMode} +
 * {@link Settings.enabled} で制御し、ここには **含めない**（既存ユーザーの
 * 設定を移行不要にするため。混乱を避けるべく「カテゴリ」タブには
 * spoiler は基本タブで設定する旨を明記する）。
 *
 * 設計方針（phase-3-multilabel.md リスク6 / L1120）: 新カテゴリは
 * **すべてデフォルト OFF**。既存ユーザーの体験を変えない。
 */
export interface CategorySettings {
  harassment: { enabled: boolean; strength: CategoryStrength };
  spam: { enabled: boolean };
  offTopic: { enabled: boolean; strength: CategoryStrength };
  backseat: { enabled: boolean; strength: CategoryStrength };
}

export interface CustomNGWord {
  /** 安定した識別子（UUID） */
  id: string;
  /** フィルタ対象のワード */
  word: string;
  /** false のとき非アクティブ（フィルタ対象外） */
  enabled: boolean;
}

export interface GameProgress {
  progressModel: 'chapter' | 'event';
  /**
   * チャプターモデル: 現在視聴中のチャプターID（未通過）。
   * このチャプター自身のキーワードもネタバレフィルタの対象になる
   * （v0.3.1 PROG-01 の「視聴中セマンティクス」）。
   */
  currentChapterId?: string;
  /** イベントモデル: 通過済みイベントIDの配列（通過後はフィルタ対象外） */
  completedEventIds?: string[];
}

export interface Settings {
  enabled: boolean;
  /** アクティブなゲームID */
  gameId: string;
  /** ゲームごとの進行状況 */
  progressByGame: Record<string, GameProgress>;
  filterMode: FilterMode;
  displayMode: DisplayMode;
  /** Stage 2 プロキシの URL（デフォルト: http://localhost:8787） */
  proxyUrl: string;
  /**
   * 収集 API のベース URL（Phase 2.5 / v0.3.5、判定ログ送信用）。
   * `apps/api` のエンドポイント（POST /v1/consent / /v1/ingest / /v1/revoke）に
   * リクエストする際に使用。オプトイン OFF のユーザーには関係ない。
   * 本番 URL は P2.5-DEPLOY-01 で確定するまでプレースホルダー。
   */
  collectionApiUrl: string;
  /** ユーザー定義のカスタム NG ワード一覧 */
  customNgWords: CustomNGWord[];
  /** 有効化されているジャンルテンプレートのIDリスト */
  selectedGenreTemplates: string[];
  /**
   * Phase 3 マルチラベル新カテゴリ設定（P3-UI-04）。
   * 既存ユーザーの保存値には存在しないため optional。読み出し時は
   * {@link DEFAULT_SETTINGS}.categories（全 OFF）とマージされる。
   */
  categories?: CategorySettings;
  /**
   * 行内トリガ（⋯ ブロック/報告アイコン）の表示モード（B5-fix）。
   * 既存ユーザーの保存値には存在しないため optional。未設定時は
   * {@link DEFAULT_SETTINGS}.triggerVisibility（`hover_only`）にマージされる。
   */
  triggerVisibility?: TriggerVisibility;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  gameId: 'ace-attorney-1',
  progressByGame: {},
  filterMode: 'standard',
  displayMode: 'placeholder',
  proxyUrl: 'https://fresh-chat-keeper-proxy.playnicelab.workers.dev',
  // Phase 2.5 リリース時点では本番 URL 未確定。DEPLOY-01 で正しい URL に置換する。
  // ローカル開発時は popup の設定 or chrome.storage の手動上書きで `http://127.0.0.1:8788` 等を指す。
  collectionApiUrl: 'https://fresh-chat-keeper-api.playnicelab.workers.dev',
  customNgWords: [],
  selectedGenreTemplates: [],
  // 新カテゴリはすべてデフォルト OFF（既存挙動を変えない / リスク6 対策）
  categories: {
    harassment: { enabled: false, strength: 'standard' },
    spam: { enabled: false },
    offTopic: { enabled: false, strength: 'standard' },
    backseat: { enabled: false, strength: 'standard' },
  },
  // B5-fix: 既定は hover_only（YouTube #menu と同挙動。通常は何も出さない）
  triggerVisibility: 'hover_only',
};

/** メイン設定のストレージキー。書き込みはポップアップのみ行う。 */
export const STORAGE_KEY = 'fck_settings';

/**
 * 匿名トークンのストレージキー。
 * 初回起動時に UUID を生成して保存し、以降は同じ値を使い回す。
 */
export const ANON_TOKEN_KEY = 'fck_anon_token';

/**
 * フィルタカウントの専用ストレージキー。
 * Content Script のみ書き込む。STORAGE_KEY との競合を防ぐために分離している。
 */
export const FILTER_COUNT_KEY = 'fck_filter_count';

/** Stage 2 月間利用量のストレージキー */
export const STAGE2_USAGE_KEY = 'fck_stage2_usage';

/**
 * 誤判定報告のストレージキー。最大 MISREPORT_MAX_COUNT 件を保存し、古いものから上書きする。
 * 将来のサーバー送信機能追加を想定してローカルに蓄積しておく。
 */
export const MISREPORT_KEY = 'fck_misreports';
const MISREPORT_MAX_COUNT = 100;

/** 誤判定報告を chrome.storage に保存する。100件を超えた場合は最古のものを削除する。 */
export async function saveMisreport(entry: MisreportEntry): Promise<void> {
  const result = await chrome.storage.local.get(MISREPORT_KEY);
  const entries = (result[MISREPORT_KEY] as MisreportEntry[] | undefined) ?? [];
  entries.push(entry);
  if (entries.length > MISREPORT_MAX_COUNT) {
    entries.splice(0, entries.length - MISREPORT_MAX_COUNT);
  }
  await chrome.storage.local.set({ [MISREPORT_KEY]: entries });
}

/**
 * Stage 2 の月間メッセージ件数上限。超えた場合は Stage 1 のみで動作する。
 * メッセージ件数で判定する（HTTP リクエスト回数ではない）。
 */
export const STAGE2_MONTHLY_LIMIT = 1000;

export interface Stage2Usage {
  /** 集計月（"YYYY-MM" 形式）。月をまたいだらリセット判定に使用する。 */
  month: string;
  /**
   * 今月 Stage 2 に送信したメッセージの総件数。
   * ポップアップ表示と月間上限チェックに使用する。
   */
  messageCount: number;
  /**
   * 今月プロキシに送信した HTTP リクエスト回数（バッチ単位）。
   * 内部記録のみ。ポップアップには表示しない。
   */
  apiCallCount: number;
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** chrome.storage から今月の Stage 2 利用量を取得する。月が変わっていればリセット済みの値を返す。 */
export async function getStage2Usage(): Promise<Stage2Usage> {
  const result = await chrome.storage.local.get(STAGE2_USAGE_KEY);
  const stored = result[STAGE2_USAGE_KEY] as Stage2Usage | undefined;
  const currentMonth = getCurrentMonth();
  if (!stored || stored.month !== currentMonth) {
    return { month: currentMonth, messageCount: 0, apiCallCount: 0 };
  }
  return {
    month: stored.month,
    messageCount: stored.messageCount ?? 0,
    apiCallCount: stored.apiCallCount ?? 0,
  };
}

/**
 * Stage 2 バッチ送信成功時に利用量を更新する。
 * @param messages バッチに含まれていたメッセージ件数
 */
export async function incrementStage2Usage(messages: number): Promise<Stage2Usage> {
  const usage = await getStage2Usage();
  const updated: Stage2Usage = {
    month: usage.month,
    messageCount: usage.messageCount + messages,
    apiCallCount: usage.apiCallCount + 1,
  };
  await chrome.storage.local.set({ [STAGE2_USAGE_KEY]: updated });
  return updated;
}

/**
 * フィルタモードに応じてブロック対象の spoiler_level 一覧を返す
 *
 * strict  : direct_spoiler + foreshadowing_hint + gameplay_hint
 * standard: direct_spoiler + foreshadowing_hint
 * lenient : direct_spoiler のみ
 */
export function getBlockedLevels(mode: FilterMode): string[] {
  switch (mode) {
    case 'strict':
      return ['direct_spoiler', 'foreshadowing_hint', 'gameplay_hint'];
    case 'standard':
      return ['direct_spoiler', 'foreshadowing_hint'];
    case 'lenient':
      return ['direct_spoiler'];
  }
}

/**
 * 匿名トークンを取得する。まだ存在しない場合は UUID を生成して保存する。
 * リクエストヘッダー x-fck-token に使用する。
 */
export async function getOrCreateAnonToken(): Promise<string> {
  const result = await chrome.storage.local.get(ANON_TOKEN_KEY);
  const existing = result[ANON_TOKEN_KEY] as string | undefined;
  if (existing) return existing;

  const token = crypto.randomUUID();
  await chrome.storage.local.set({ [ANON_TOKEN_KEY]: token });
  console.log('[FreshChatKeeper] 匿名トークンを生成しました:', token.slice(0, 8) + '...');
  return token;
}