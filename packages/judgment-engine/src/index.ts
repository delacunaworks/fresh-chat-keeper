/**
 * @fresh-chat-keeper/judgment-engine
 *
 * 2段階フィルタ（Stage 1 キーワード + Stage 2 LLM判定）の判定エンジン。
 * Chrome拡張・Cloudflare Workers・Node.js から共通利用するため、
 * DOM API や chrome.* 等の環境固有APIには依存しない。
 *
 * Phase 2 時点の公開API:
 *   - 型定義（types.ts）
 *   - Stage 1: `runStage1` および下層マッチ関数（stage1/）
 *   - Stage 2: モデルルーター・キャッシュ・Transport抽象（stage2/）
 *
 * 後続フェーズで追加予定:
 *   - 統合エントリ `judgeMessage` / `judgeMessageBatch`
 *   - プロンプトビルダー / バッチャー（P2-STAGE2-02 / -04）
 */

export type {
  JudgmentLabel,
  Message,
  Judgment,
  JudgmentContext,
  Stage2Transport,
  JudgeRequestPayload,
  JudgeResponsePayload,
} from './types.js';

export type { Stage1Result } from './stage1/index.js';
export { runStage1, isObviouslySafe } from './stage1/index.js';

// Stage 1.5（Phase 3 / v0.4.0 で実装）
export type {
  Stage1_5Result,
  UserHistoryEntry,
  UserMessageHistory,
  ChatHistoryEntry,
  ChatWideHistory,
  SpamDetectionResult,
} from './stage1_5/index.js';
export {
  runStage1_5,
  HistoryStore,
  USER_HISTORY_MAX,
  USER_HISTORY_TTL_MS,
  CHAT_HISTORY_MAX,
  CHAT_HISTORY_TTL_MS,
  detectSpam,
  SPAM_DETECTION_THRESHOLDS,
} from './stage1_5/index.js';

// Stage 2 building blocks（Phase 2 で実装、judgeMessage 等の統合は後続）
export type { ModelTier, ModelConfig } from './stage2/model-router.js';
export { selectModel, getEffectiveModel } from './stage2/model-router.js';

export type {
  CacheStorage,
  CacheEntry,
  CacheOptions,
} from './stage2/cache.js';
export { JudgmentCache, createMemoryStorage } from './stage2/cache.js';

export type { MockTransportHandler } from './stage2/api-client.js';
export { createMockTransport, createFailingTransport } from './stage2/api-client.js';

export type { SystemPromptBlock, BuildSystemPromptOptions } from './stage2/prompt-builder.js';
export { buildSystemPrompt, buildUserPrompt } from './stage2/prompt-builder.js';

export type { Stage2BatcherOptions } from './stage2/batcher.js';
export { Stage2Batcher } from './stage2/batcher.js';
