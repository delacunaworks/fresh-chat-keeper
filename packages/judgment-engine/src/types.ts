/**
 * 判定エンジンの公開型定義。
 *
 * 設計方針:
 * - `Message` / `Judgment` / `JudgmentLabel` / `JudgmentContext` / `Stage2Transport`
 *   は判定エンジン固有の型としてここに定義する。
 * - `FilterSettings` / `GameContext` は `@fresh-chat-keeper/shared` で定義され、
 *   設定マイグレーション関数（settings-migration.ts）と同じパッケージに置かれる。
 *   judgment-engine からは type-only で import するのみ（再エクスポートしない）。
 * - プロキシAPI契約（{@link JudgeRequestPayload} / {@link JudgeResponsePayload}）は
 *   shared の {@link JudgeRequest} / {@link JudgeResponse} のエイリアスとし、
 *   契約変更時は shared 側だけ更新すれば追従できるようにする。
 */

import type {
  JudgeRequest,
  JudgeResponse,
  FilterSettings,
  GameContext,
  JudgmentLabel as SharedJudgmentLabel,
} from '@fresh-chat-keeper/shared';

/**
 * 判定ラベル。1メッセージにつき複数のラベルが付与されうる（マルチラベル）。
 *
 * Phase 3（v0.4.0）で 6 ラベルに拡張。設計詳細は
 * `dev-docs/phase-3-multilabel.md` 「判定カテゴリの定義」を参照。
 *
 * primary 決定の優先順位（深刻度の高い順）:
 *   harassment > spoiler > backseat > spam > off_topic > safe
 *
 * canonical な定義は `@fresh-chat-keeper/shared`。judgment-engine からも
 * 同名で再エクスポートしているので、既存の import 文（judgment-engine 経由）は
 * 互換性のために維持される。
 *
 * Phase 2.5 のデータ収集ログ（`CollectionLabel`）とは同じ値集合に揃えてある
 * ので、相互変換は不要。
 */
export type JudgmentLabel = SharedJudgmentLabel;

/**
 * 判定エンジンに入力するチャットメッセージの正規化表現。
 *
 * YouTube DOM 由来の {@link import('@fresh-chat-keeper/shared').ChatMessage}
 * とは別物。呼び出し側（chrome-ext / apps/api）で変換する責務を持つ。
 */
export interface Message {
  /** メッセージID（プラットフォーム固有のもので可、ユニークであればよい） */
  id: string;
  /** メッセージ本文 */
  text: string;
  /** 投稿者のチャンネルID（YouTube channelId 等） */
  authorChannelId: string;
  /** 投稿者の表示名 */
  authorDisplayName: string;
  /** 投稿時刻（Unix ms）。アーカイブの場合は動画内オフセットを Unix ms に正規化したもの */
  timestamp: number;
}

/**
 * 1回の判定リクエストにおけるコンテキスト。
 *
 * - `game`: プレイ中のゲーム情報。未指定時はジャンルテンプレートのみで判定
 * - `settings`: ユーザーのフィルタ設定（v2形式）
 * - `recentAudio` / `streamSummary`: Phase 5（v0.6.0）字幕連動。両 optional を
 *   MVP で切っておくことで、後段 rolling summary でシグネチャを変えずに済む。
 *   prompt-builder は両方を「あれば 1 行足す」出力分岐で握る（P5-B4b）。
 */
export interface JudgmentContext {
  /** ゲーム進行コンテキスト */
  game?: GameContext;
  /** ユーザー設定（v2スキーマ） */
  settings: FilterSettings;
  /**
   * Phase 5 字幕連動（caption MVP）: 直近 N 秒の生発話。ステートレス。
   * `text` は字幕連結、`qualityScore` は `evaluateCaptionQuality` 由来 0..1。
   * 字幕 OFF / 品質低 / 機能 OFF のときは undefined（呼び出し側が素通し）。
   * MVP で chrome-ext → proxy の `JudgeRequest.context` に乗せる唯一の追加経路。
   */
  recentAudio?: { text: string; qualityScore: number };
  /**
   * Phase 7（P7-B5）rolling summary。stream-level の累積/近傍文脈。
   * proxy が Service Binding 経由で StreamContextDO の getRecentSummary を引き、
   * `whole`（L2 全体累積要約）/ `recent`（L1 近傍要約）を埋める。
   * prompt-builder は Block3（cache_control 境界の外）に whole→recent→verbatim の
   * 順で「あれば 1 セクション」載せる（doc §3）。両 optional で、DO 未投入や
   * 取得失敗時は undefined（その場合は recentAudio のフォールバックに委ねる）。
   *
   * ※ Phase 5 は `{ text }` だったが P7-B5 で `{ whole?, recent? }` に拡張。
   */
  streamSummary?: { whole?: string; recent?: string };
}

/**
 * 判定結果。マルチラベル対応のため `labels[]` と `primary` を持つ。
 */
export interface Judgment {
  /** 対象メッセージのID（{@link Message.id} と一致） */
  messageId: string;
  /** 付与されたラベル一覧。空配列ではなく必ず1件以上含まれる */
  labels: JudgmentLabel[];
  /** UI表示等に使う主要ラベル。`labels` のうち最も支配的なもの */
  primary: JudgmentLabel;
  /** 信頼度（0.0〜1.0）。Stage 1 の確定的判定では 1.0 */
  confidence: number;
  /** 判定が確定したステージ */
  stage: 'stage1' | 'stage2';
  /** 日本語の理由説明（UI表示用、デバッグ用）。任意 */
  reasonJa?: string;
  /** キャッシュからの応答かどうか */
  fromCache: boolean;
}

/**
 * Stage 2（LLM判定）への通信を抽象化するTransport。
 *
 * 判定エンジンは実際の通信方法を知らない:
 * - Chrome拡張: `chrome.runtime.sendMessage` でService Workerに転送する実装を注入
 * - Cloudflare Workers: `fetch` で直接プロキシ/Anthropic APIを叩く実装を注入
 * - テスト: モック実装を注入して通信なしに判定ロジックを検証
 */
export interface Stage2Transport {
  /**
   * Stage 2 の判定リクエストをプロキシ/APIへ送信する。
   *
   * @param payload バッチ判定対象のメッセージ群と関連コンテキスト
   * @returns 各メッセージに対する判定結果
   */
  sendJudgeRequest(payload: JudgeRequestPayload): Promise<JudgeResponsePayload>;
}

/**
 * Stage 2 リクエストペイロード。
 * shared の {@link JudgeRequest} のエイリアス（プロキシAPI契約と同一）。
 */
export type JudgeRequestPayload = JudgeRequest;

/**
 * Stage 2 レスポンスペイロード。
 * shared の {@link JudgeResponse} のエイリアス（プロキシAPI契約と同一）。
 */
export type JudgeResponsePayload = JudgeResponse;
