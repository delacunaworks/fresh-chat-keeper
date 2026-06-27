/**
 * LLMProvider 抽象（Phase 7 / P7-B2）。
 *
 * **目的**: サーバ側（proxy・将来は apps/api）の LLM 呼び出しを
 * `provider × modelId × endpoint × auth × callsFrom` で抽象化し、将来
 * Gemini / Qwen / BYO を差し替え可能にする継ぎ目を作る。今回は抽象の新設と
 * 既存 Anthropic 直叩き（proxy の `callAnthropicOnce`）の内包までで、**挙動は
 * 一切変えない**（純粋なリファクタ）。
 *
 * **レイヤーの区別（混同禁止）**:
 * - `Stage2Transport`（stage2/api-client.ts）= chrome-ext → proxy のネットワーク
 *   往復抽象。**本抽象とは別物**。LLMProvider は Stage2Transport を置換しない。
 * - `LLMProvider`（本ファイル）= proxy / apps/api → LLM（Anthropic 等）の
 *   サーバ側呼び出し抽象。
 *
 * モデル選択は引き続き model-router（`getEffectiveModel`）が担う。Provider は
 * 渡された `LLMRequest`（= ModelConfig 由来の model/maxTokens/temperature）を
 * 使うだけで、モデル ID をハードコードしない。
 *
 * 設計 ground truth: dev-docs/phase-7-asr-audio-context.md §4.1
 */

import type { SystemPromptBlock } from '../stage2/prompt-builder.js';

/**
 * LLM への chat メッセージ（Anthropic の `messages[]` 要素に対応）。
 *
 * ※ prompt-builder の {@link PromptMessage}（`{ id, text }`）とは別物。
 * あちらは判定対象コメントの最小入力、こちらは LLM API の会話ロール構造。
 */
export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * LLM 補完リクエスト。
 *
 * judgeBatch が現在 Anthropic に渡している内容を過不足なく構造化したもの:
 * - `system` は cache_control を含む {@link SystemPromptBlock} 配列をそのまま運ぶ
 *   （Anthropic 以外では無視され得るが、構造は共通の最小形として保持）。
 */
export interface LLMRequest {
  /** モデル識別子（ModelConfig.model）。Provider 側でハードコードしない。 */
  model: string;
  /** 1 リクエストの max_tokens。 */
  maxTokens: number;
  /** サンプリング温度。判定は決定的に動かすため通常 0。 */
  temperature: number;
  /** system プロンプトブロック（cache_control 含む）。 */
  system: SystemPromptBlock[];
  /** 会話メッセージ。判定経路では `[{ role: 'user', content }]` 1 件。 */
  messages: LLMMessage[];
}

/**
 * LLM 補完レスポンス（成功時）。
 *
 * 現状の利用側は本文テキストのみを使う。将来 usage / stopReason 等を足せるよう
 * オブジェクトで包む（最小の構造化型）。
 */
export interface LLMResponse {
  /** モデルが返した本文テキスト（Anthropic の content[0].text 相当）。 */
  text: string;
}

/**
 * サーバ側 LLM 呼び出しの抽象。
 *
 * **`complete` の契約（挙動不変のため厳守）**:
 * - 成功（HTTP 2xx）: `LLMResponse` を返す。
 * - HTTP 非 2xx: `null` を返す（呼び出し側が fallback する。throw しない）。
 * - ネットワーク失敗・レスポンス JSON パース失敗: **throw する**（呼び出し側の
 *   outer try/catch が拾う）。
 *
 * これは proxy の旧 `callAnthropicOnce`（`Promise<string | null>`）と等価で、
 * 「HTTP エラーは null・ネットワーク/パース例外は伝播」という分岐を維持する。
 */
export interface LLMProvider {
  /** プロバイダ名。'anthropic' | 'gemini' | 'qwen-hosted' | 'openai-compat' | 'local' 等。 */
  readonly name: string;
  /**
   * 呼び出し元レイヤー。local(ollama) は localhost を Worker から叩けないため
   * 'extension'。ホスト API は 'worker'。
   */
  readonly callsFrom: 'worker' | 'extension';
  /** Anthropic の cache_control（prompt cache）を使えるか。 */
  readonly supportsPromptCache: boolean;
  /** 1 回の補完を実行する。契約は上記参照。 */
  complete(req: LLMRequest): Promise<LLMResponse | null>;
}

/** {@link AnthropicProvider} のコンストラクタオプション。 */
export interface AnthropicProviderOptions {
  /** Anthropic API キー。ハードコードせず呼び出し側（env）から渡す。 */
  apiKey: string;
  /** fetch の差し替え（テストで実 API 通信を避けるための注入点）。既定 global fetch。 */
  fetchImpl?: typeof fetch;
  /** anthropic-version ヘッダ。既定 '2023-06-01'。 */
  anthropicVersion?: string;
  /** エンドポイント。既定 messages API。 */
  endpoint?: string;
}

/** Anthropic messages API のデフォルトエンドポイント。 */
const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/** デフォルトの anthropic-version。 */
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic messages API のレスポンス本文（必要部分のみ）。 */
interface AnthropicMessagesResponse {
  content: Array<{ type: string; text: string }>;
}

/**
 * Anthropic（Claude）向け LLMProvider 実装。
 *
 * proxy の旧 `callAnthropicOnce` のロジックをそのまま内包する。送出する HTTP
 * リクエスト（URL・ヘッダ・anthropic-version・body の JSON 形）は旧実装と
 * **バイト等価**で、挙動を変えない。
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly callsFrom = 'worker' as const;
  readonly supportsPromptCache = true;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly anthropicVersion: string;
  private readonly endpoint: string;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
    this.endpoint = options.endpoint ?? ANTHROPIC_MESSAGES_ENDPOINT;
  }

  async complete(req: LLMRequest): Promise<LLMResponse | null> {
    // 旧 callAnthropicOnce と同一の body 形（model / max_tokens / temperature /
    // system / messages）。フィールド名・順序も維持する。
    const body = JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.system,
      messages: req.messages,
    });

    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
      },
      body,
    });

    if (!response.ok) {
      // HTTP 非 2xx は null（呼び出し側で fallback）。旧実装と同じく throw しない。
      const errorText = await response.text();
      console.error(`[FreshChatKeeper] Anthropic API error ${response.status}: ${errorText}`);
      return null;
    }

    // ネットワーク失敗・JSON パース失敗は throw して呼び出し側へ伝播（旧実装と同じ）。
    const data = (await response.json()) as AnthropicMessagesResponse;
    return { text: data.content[0]?.text ?? '' };
  }
}
