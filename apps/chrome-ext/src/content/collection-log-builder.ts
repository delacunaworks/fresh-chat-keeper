/**
 * Stage 1 / Stage 2 判定結果から `SpoilerJudgmentLog` を組み立てる。
 *
 * 設計 ground truth:
 * - dev-docs/phase-2-5-data-collection.md §4.1（型定義）/ §4.4（取得タイミング）
 * - packages/shared/src/types/collection.ts（ワイヤー形式）
 *
 * Phase 2.5 で値が入るフィールドだけを埋め、その他は型仕様に沿った null /
 * 空配列で埋める。`authorChannelId` は **平文のまま** 送信し、ハッシュ化は
 * apps/api 側（COLLECTION_SALT を使った SHA-1）で行う。
 *
 * stageACategory の決定:
 * - Stage 1 の `isObviouslySafe` 経路（"草" / "www" / 2 文字以下等）→ 'reaction'
 * - それ以外（Stage 2 LLM 判定 / 通常の Stage 1 マッチ）→ 'unknown'
 */

import type {
  SpoilerJudgmentLog,
  CollectionLabel,
  JudgmentMode,
  JudgmentStage,
  StageACategory,
  ContextMessage,
  LabelSource,
} from '@fresh-chat-keeper/shared';

/**
 * 判定 1 件分の素材（archive.ts から渡される）。
 * 既存の Stage2Candidate / JudgeCacheEntry の知識を持ち込みすぎないよう、
 * builder が必要とする最小フィールドだけを expose する。
 */
export interface JudgmentRawData {
  /** クライアント発行の logId（UUID v4） */
  logId: string;
  consentVersion: string;
  /** YouTube videoId（VTuber 1B 互換） */
  videoId: string;
  /** 配信者の channel ID */
  channelId: string;
  /** ゲーム ID（KB 上の。none / other は null へ） */
  gameTitle: string | null;
  /** 配信開始からの経過秒（取得不能なら null） */
  timeIntoStream: number | null;
  /** archive_replay / live。post_stream_review は Phase 3+ */
  judgmentMode: 'archive_replay' | 'live';

  /** 判定対象メッセージ */
  targetBody: string;
  /** 平文の YouTube channel ID（apps/api 側でハッシュ化される） */
  targetAuthorChannelId: string;
  /** ISO 8601 UTC、メッセージ投稿時刻 */
  targetTimestamp: string;

  /** archive モードのみ N=10、live は []（収集タイミングで builder 側に渡される） */
  precedingMessages: ContextMessage[];

  /** 段階A（'reaction' or 'unknown'） */
  stageACategory: StageACategory;
  /** ラベル（v0.3.5 では ['safe'] | ['spoiler']） */
  labels: CollectionLabel[];
  primaryLabel: CollectionLabel;
  /** Stage 1 確定時は 1.0、Stage 2 LLM 信頼度は 0〜1 */
  confidence: number;
  /** stage1 / stage2（stage1_5 は Phase 3+） */
  stage: 'stage1' | 'stage2';
  reasonJa: string | null;

  labelSource: LabelSource;

  extensionVersion: string;
}

/**
 * `JudgmentRawData` から API へ送る `SpoilerJudgmentLog` を組み立てる。
 *
 * 値が埋まらないフィールド（Phase 3+）は仕様どおり null / false / [] で埋める。
 */
export function buildJudgmentLog(raw: JudgmentRawData): SpoilerJudgmentLog {
  return {
    logId: raw.logId,
    recordedAt: new Date().toISOString(),
    consentVersion: raw.consentVersion,
    videoId: raw.videoId,
    channelId: raw.channelId,
    gameTitle: raw.gameTitle,
    streamProgressHint: null,
    timeIntoStream: raw.timeIntoStream,
    judgmentMode: raw.judgmentMode satisfies JudgmentMode,
    targetMessage: {
      body: raw.targetBody,
      authorChannelId: raw.targetAuthorChannelId,
      timestamp: raw.targetTimestamp,
      isMember: null,
      isModerator: null,
      isVerified: null,
    },
    precedingMessages: raw.precedingMessages,
    followingMessages: [],
    stageACategory: raw.stageACategory,
    stageAConfidence: null,
    labels: raw.labels,
    primaryLabel: raw.primaryLabel,
    confidence: raw.confidence,
    stage: raw.stage satisfies JudgmentStage,
    reasonJa: raw.reasonJa,
    labelSource: raw.labelSource,
    reviewedByHuman: false,
    userFeedback: null,
    extensionVersion: raw.extensionVersion,
    /**
     * クライアント側の `userTokenHashed` フィールドはサーバー側で **必ず上書き**
     * される（apps/api/src/routes/ingest.ts:hashUserToken）。
     *
     * クライアントの平文トークンを「いったんフィールドに入れる」設計は避ける:
     * もしサーバー側で何らかのバグで上書きが漏れた場合、平文トークンが D1 に
     * そのまま入ってしまう risk がある。代わりに空文字列で埋め、API 側で
     * 必ずハッシュ済みトークンに置き換わる前提とする。
     *
     * 平文トークンは fetch のヘッダ（x-fck-token）経由で送信されるため、
     * フィールドに含める必要はない。
     */
    userTokenHashed: '',
  };
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = {};
