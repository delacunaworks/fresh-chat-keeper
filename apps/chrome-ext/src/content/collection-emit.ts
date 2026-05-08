/**
 * archive.ts と collection-client.ts の薄い橋渡し。
 *
 * 役割:
 * - opt-in 状態のキャッシュ（chrome.storage の毎回参照を避ける）
 * - opt-in 状態変化の監視（同意 / 取り消しが起きたら IngestClient を起動 / 停止）
 * - SpoilerJudgmentLog の構築（archive.ts が呼ぶ minimal API）
 * - 拡張バージョン取得（chrome.runtime.getManifest().version）
 *
 * archive.ts は判定ロジックに集中させ、本ファイルはサーバー側仕様（hash 化、
 * JSON フォーマット、buffer 管理）の知識を集約する。
 */

import type {
  CollectionLabel,
  ContextMessage,
  LabelSource,
  StageACategory,
} from '@fresh-chat-keeper/shared';
import {
  COLLECTION_CONSENT_KEY,
  getCollectionConsent,
  type CollectionConsentState,
} from '../shared/collection-state.js';
import { IngestClient } from './collection-client.js';
import { buildJudgmentLog } from './collection-log-builder.js';

/** 1 件の判定を ingest にフィードするための最小 input */
export interface EmitJudgmentInput {
  videoId: string;
  channelId: string;
  /** ゲーム ID（KB 上）。未指定 / 'none' / 'other' は null */
  gameTitle: string | null;
  /** 配信開始からの経過秒（取得不能なら null） */
  timeIntoStream: number | null;
  judgmentMode: 'archive_replay' | 'live';

  targetBody: string;
  /** 平文の投稿者 channel ID（apps/api 側で SHA-1 ハッシュ化） */
  targetAuthorChannelId: string;
  /** 投稿時刻（ISO 8601 UTC）。不明なら現在時刻でフォールバック */
  targetTimestamp: string;

  precedingMessages: ContextMessage[];

  stageACategory: StageACategory;
  labels: CollectionLabel[];
  primaryLabel: CollectionLabel;
  confidence: number;
  stage: 'stage1' | 'stage2';
  reasonJa: string | null;

  labelSource: LabelSource;
}

// ─── モジュールスコープ状態 ─────────────────────────────────

/** opt-in 中なら IngestClient のインスタンス、未 opt-in なら null */
let client: IngestClient | null = null;

/** opt-in 中ならその state、未 opt-in なら null */
let consentState: CollectionConsentState | null = null;

/** apiUrl / token の取得元（archive.ts の起動時に渡される） */
let cachedApiUrl: string | null = null;
let cachedToken: string | null = null;

let storageListenerInstalled = false;

// ─── 公開 API ─────────────────────────────────────────────────

/**
 * archive.ts 起動時に 1 度だけ呼ぶ初期化。
 *
 * - 現在の opt-in 状態を読み込み、IngestClient を必要なら起動
 * - chrome.storage.onChanged を購読し、opt-in 状態変化に追従
 *
 * @param apiUrl settings.collectionApiUrl
 * @param token 既存匿名トークン（fck_anon_token）
 */
export async function initCollectionEmitter(
  apiUrl: string,
  token: string,
): Promise<void> {
  cachedApiUrl = apiUrl;
  cachedToken = token;

  consentState = await getCollectionConsent();
  refreshClient();

  if (storageListenerInstalled) return;
  storageListenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes[COLLECTION_CONSENT_KEY]) return;
    const next = changes[COLLECTION_CONSENT_KEY].newValue as CollectionConsentState | undefined;
    consentState = isValidState(next) ? next : null;
    refreshClient();
  });
}

/**
 * 1 件の判定ログを ingest 経由で送信する。
 *
 * opt-in OFF なら何もしない（早期 return、何もコストかからない）。
 * opt-in ON なら SpoilerJudgmentLog を構築してバッファに積む。
 */
export function emitJudgmentLog(input: EmitJudgmentInput): void {
  if (consentState === null || client === null) return;

  const log = buildJudgmentLog({
    logId: crypto.randomUUID(),
    consentVersion: consentState.consentVersion,
    videoId: input.videoId,
    channelId: input.channelId,
    gameTitle: input.gameTitle,
    timeIntoStream: input.timeIntoStream,
    judgmentMode: input.judgmentMode,
    targetBody: input.targetBody,
    targetAuthorChannelId: input.targetAuthorChannelId,
    targetTimestamp: input.targetTimestamp,
    precedingMessages: input.precedingMessages,
    stageACategory: input.stageACategory,
    labels: input.labels,
    primaryLabel: input.primaryLabel,
    confidence: input.confidence,
    stage: input.stage,
    reasonJa: input.reasonJa,
    labelSource: input.labelSource,
    extensionVersion: chrome.runtime.getManifest().version,
  });

  client.enqueueLog(log);
}

/**
 * archive.ts から「拡張シャットダウン」or「動画ページ離脱」時に呼ぶ。
 * バッファを即座にフラッシュし、進行中タイマーをクリアする。
 */
export async function shutdownCollectionEmitter(): Promise<void> {
  if (client === null) return;
  await client.flush();
}

// ─── 内部ヘルパー ──────────────────────────────────────────────

function refreshClient(): void {
  // 必要条件が揃ったら client を作る、揃わなくなったら abort して破棄
  if (consentState !== null && cachedApiUrl !== null && cachedToken !== null) {
    if (client === null) {
      client = new IngestClient({ apiUrl: cachedApiUrl, token: cachedToken });
    }
  } else {
    if (client !== null) {
      client.abort();
      client = null;
    }
  }
}

function isValidState(raw: unknown): raw is CollectionConsentState {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    r.optedIn === true &&
    typeof r.consentVersion === 'string' &&
    typeof r.recordedAt === 'number'
  );
}

// ─── テスト用エクスポート ─────────────────────────────────────

/** @internal テスト用 */
export const __test__ = {
  reset: () => {
    if (client !== null) client.abort();
    client = null;
    consentState = null;
    cachedApiUrl = null;
    cachedToken = null;
    storageListenerInstalled = false;
  },
  hasClient: () => client !== null,
  getClient: () => client,
};
