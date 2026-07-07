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

/** Phase 3.5 視聴者フラグ機能の集計スコープ（B3 / v0.5.0） */
export type UserFlaggingScope = 'session' | '7d' | '30d';

/**
 * Phase 3.5 視聴者フラグの表示スタイル（B3 / v0.5.0、設計文書 §「表示スタイル」）。
 * - `icon`: 名前横にフラグアイコン（🟡🔴）。ROM 専層配慮の既定
 * - `color`: ユーザー名を着色。視覚的うるささを抑えたい場合
 * - `hover_only`: ホバー時のみ表示。最もクリーンな能動視聴者向け
 *   （※ 改訂1 で hover 駆動 UI は撤回されたため、本オプションは
 *   「コメント要素にカーソル乗せたときだけ CSS で可視化する表示制御」を意味する。
 *   JS の mouseenter/leave リスナーは持たない）
 * - `red_only`: red のみ明確表示し yellow は控えめ
 */
export type UserFlaggingDisplayStyle = 'icon' | 'color' | 'hover_only' | 'red_only';

/**
 * Phase 3.5 視聴者フラグ機能の設定（B3 / v0.5.0、設計文書 §「データ構造」）。
 *
 * - `enabled` は **オプトイン**（既定 false）。`triggerVisibility` 等の必須
 *   フィールドと違い optional 維持の余地はあるが、本機能の有効/無効は明確に
 *   保存しておくほうが popup の UI 状態管理が楽なので明示フィールド化
 * - `sensitivity` は flag-evaluator が読む `{ yellow, red }`。yellow は red の
 *   半分を既定（標準感度 red=0.4 / yellow=0.2）
 */
export interface UserFlaggingSettings {
  enabled: boolean;
  scope: UserFlaggingScope;
  displayStyle: UserFlaggingDisplayStyle;
  sensitivity: { yellow: number; red: number };
}

/** Phase 5 字幕連動の参照窓（秒、v0.6.0 / caption MVP）。 */
export type CaptionWindowSeconds = 30 | 60 | 120;

/**
 * Phase 5 字幕品質しきい値のプリセット（v0.6.0）。
 * 数値しきい値（loose 0.3 / standard 0.4 / strict 0.5 等）への変換は
 * P5-B4c/B5 の責務。本層は型と既定のみ持つ。
 */
export type CaptionQualityThreshold = 'loose' | 'standard' | 'strict';

/**
 * Phase 5 字幕連動の設定（v0.6.0 / caption MVP で追加）。
 *
 * 既定 OFF（オプトイン）。`enabled` が true のときのみ字幕を Stage 2 判定の
 * コンテキストに乗せる（P5-B4c）。`userFlagging` と同じく非 optional + DEFAULT
 * マージで自動補完される（B5 supplement で確立したパターン）。
 */
export interface CaptionContextSettings {
  enabled: boolean;
  windowSeconds: CaptionWindowSeconds;
  qualityThreshold: CaptionQualityThreshold;
}

/**
 * Phase 7（AR-3）音声文脈の設定。字幕連動（{@link CaptionContextSettings}）を
 * 置換する **実験的** 機能。既定 OFF（オプトイン）。
 *
 * ON のとき、判定リクエストに再生位置（currentTimeSeconds）を載せ、proxy が
 * サーバ側の transcript（運営が用意した文字起こし）から「再生位置までの文脈」を
 * 引いて判定に反映する。★再生位置より先の内容は参照されない。
 * 字幕 DOM 抽出（Phase 5）とは別系統で、この設定は enabled のみを持つ。
 */
export interface AudioContextSettings {
  enabled: boolean;
}

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
   *
   * B6a typescript: **非 optional**。{@link DEFAULT_SETTINGS} が常時セットし、
   * settings-loader が読み出し時に必ず DEFAULT とマージする（旧データに
   * 無くても補完される）ため、型と実体（常に存在）を一致させる。
   * 補完発動は settings-loader で debug 可視化。
   */
  triggerVisibility: TriggerVisibility;
  /**
   * Phase 3.5 視聴者フラグ機能の設定（B3 / v0.5.0、B5 で非 optional 化）。
   *
   * B5 typescript（B6a triggerVisibility と同パターン）: 非 optional。
   * {@link DEFAULT_SETTINGS}.userFlagging が常時セットされ、settings-loader が
   * 読み出し時に必ず DEFAULT とマージする（旧 v3 以前データに無くても補完される）
   * ため、型と実体（常に存在）を一致させる。呼び出し側の
   * `settings.userFlagging?.enabled` ノイズが消える。
   */
  userFlagging: UserFlaggingSettings;
  /**
   * Phase 7 音声文脈の設定（AR-3、v0.7.0）。非 optional。
   * {@link DEFAULT_SETTINGS}.audioContext が常時セットされ、settings-loader が
   * 読み出し時に必ず DEFAULT とマージする。既定 OFF（オプトイン・実験的）。
   *
   * ※ v0.6.0 の `captionContext`（字幕連動）を置換。移行は v5→v6 migration で行い、
   * 旧値は引き継がず一律 OFF で開始する（字幕とは別機能のため）。
   */
  audioContext: AudioContextSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  // 既定は「ゲームを選択しない」。以前はテスト用 placeholder の 'ace-attorney-1' が
  // 既定のまま出荷されており、新規ユーザーに無関係なゲームが選択済みに見えていた
  // （CLAUDE.md 既知問題）。'none' なら popup の「ゲームを選択しない」が初期選択になる。
  gameId: 'none',
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
  // Phase 3.5 / v0.5.0: 視聴者フラグ機能はオプトイン（既定 OFF）。
  // scope='30d' / displayStyle='icon' / sensitivity 標準値（red=0.4, yellow=0.2）。
  userFlagging: {
    enabled: false,
    scope: '30d',
    displayStyle: 'icon',
    sensitivity: { yellow: 0.2, red: 0.4 },
  },
  // Phase 7 / AR-3: 音声文脈はオプトイン（既定 OFF・実験的）。enabled が true の
  // ときのみ再生位置を判定リクエストに載せ、サーバ側 transcript の文脈を反映する。
  audioContext: {
    enabled: false,
  },
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