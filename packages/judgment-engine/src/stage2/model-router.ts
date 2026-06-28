/**
 * モデルルーター。
 *
 * ユーザーティアに応じた Stage 2 LLM のモデル設定を管理する。
 *
 * Phase 2 時点では全ティアが Haiku 固定（動作確認・コスト抑制のため）。
 * Phase 3 以降で premium / streamer ティアを Sonnet に切り替える際は、
 * {@link getEffectiveModel} の実装のみを変更すればよい構造になっている。
 *
 * @see dev-docs/phase-2-engine-split.md §モデルルーター
 */

/** ユーザーティア */
export type ModelTier = 'free' | 'premium' | 'streamer';

/** モデル呼び出しに必要な設定 */
export interface ModelConfig {
  /** Anthropic API のモデル識別子 */
  model: string;
  /** 1リクエストの max_tokens */
  maxTokens: number;
  /** サンプリング温度。判定タスクは決定的に動かしたいので 0 推奨 */
  temperature: number;
  /** プロンプトキャッシング（cache_control: ephemeral）対応かどうか */
  supportsCaching: boolean;
}

/**
 * ティアごとの「論理的な」モデル設定。
 *
 * これはあくまで「将来 premium/streamer に Sonnet を割り当てる予定」を表す
 * 配置図であり、Phase 2 時点での実際の選択は {@link getEffectiveModel} が決める。
 */
const MODEL_CONFIGS: Record<ModelTier, ModelConfig> = {
  free: {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 200,
    temperature: 0,
    supportsCaching: true,
  },
  premium: {
    model: 'claude-sonnet-4-6',
    maxTokens: 300,
    temperature: 0,
    supportsCaching: true,
  },
  streamer: {
    model: 'claude-sonnet-4-6',
    maxTokens: 300,
    temperature: 0,
    supportsCaching: true,
  },
};

/**
 * ティアに対応する論理的なモデル設定を返す（参照用）。
 *
 * 実際の判定で使うモデルを取得したい場合は {@link getEffectiveModel} を使うこと。
 */
export function selectModel(tier: ModelTier): ModelConfig {
  return MODEL_CONFIGS[tier];
}

/**
 * Phase 2 時点で実際に使用するモデル設定を返す。
 *
 * **Phase 2: 全ティアで `MODEL_CONFIGS.free`（Haiku）を返す**。
 * Phase 3 以降で premium/streamer ティアを Sonnet に切り替える場合は、
 * 本関数の実装のみを `return MODEL_CONFIGS[tier]` に変えればよい。
 *
 * @param tier 受け取るが、Phase 2 時点では結果に影響しない
 */
export function getEffectiveModel(tier: ModelTier): ModelConfig {
  // Phase 2: 全ティアを Haiku に固定（コスト抑制と挙動安定化のため）
  // 引数 `tier` は将来の切り替えのために型シグネチャ上保持する
  void tier;
  return MODEL_CONFIGS.free;
}

/**
 * 要約モデル設定（Phase 7 / P7-B4）。
 *
 * 判定（{@link getEffectiveModel}＝Haiku・高頻度・低レイテンシ）とは別系統。
 * 音声文脈の rolling summary（L1/L2）は per-stream で**遅くて可・品質優先**
 * （doc §4: 要約は JP 理解優先）。まず Anthropic 統一で Sonnet 4.6 を使い、
 * Gemini 3.1 Pro への差し替えは後続（P7-B-Gemini）。
 *
 * - temperature: 要約は決定的すぎない方が自然なため 0.2（判定の 0 とは別）。
 * - supportsCaching: false。要約は判定経路の cache_control 設計に影響させない。
 */
const SUMMARY_MODEL_CONFIG: ModelConfig = {
  model: 'claude-sonnet-4-6',
  maxTokens: 400,
  temperature: 0.2,
  supportsCaching: false,
};

/**
 * 要約に使うモデル設定を返す（Phase 7 / P7-B4）。
 * 判定用 {@link getEffectiveModel} とは独立に進化させる。
 */
export function getSummaryModel(): ModelConfig {
  return SUMMARY_MODEL_CONFIG;
}
