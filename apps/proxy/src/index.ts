/**
 * Fresh Chat Keeper Proxy — Cloudflare Workers
 *
 * 役割:
 * - Chrome Extension から受け取ったチャットメッセージを Anthropic API に転送してネタバレ判定
 * - APIキーをクライアントに露出させずに安全に管理
 * - 匿名トークン検証 + IPベースのレート制限（30req/min）
 *
 * エンドポイント:
 *   POST /api/judge — Stage 2 LLM 判定
 *
 * Phase 2 (P2-PROXY-01) からの変更点:
 * - **後方互換**: 既存 v0.2.0 拡張が送る旧リクエスト形式（`gameId`/`progress`/
 *   `filterMode`/`selectedGenreTemplates` トップレベル）と、v0.3.0 拡張が送る
 *   新形式（`context.game`/`context.settings`/`tier`）の両方を受け付ける
 * - judgment-engine の `buildSystemPrompt` / `buildUserPrompt` を使い、
 *   N メッセージを1回の Anthropic API 呼び出しでバッチ判定
 *   （プロンプトキャッシング有効、レイテンシ・コスト改善）
 * - ジャンル名解決は judgment-engine から `getAllGenreTemplates()` で行う
 *   （旧 `GENRE_NAMES` ハードコード辞書は削除）
 */

import type {
  JudgeResponse,
  FilterResult,
  FilterSettings,
  GameContext,
  UserProgress,
  JudgmentLabel,
} from '@fresh-chat-keeper/shared';
import {
  buildSystemPrompt,
  buildUserPrompt,
  getEffectiveModel,
  type ModelTier,
  type Message as JudgmentMessage,
  type JudgmentContext,
} from '@fresh-chat-keeper/judgment-engine';
import { getAllGenreTemplates } from '@fresh-chat-keeper/knowledge-base';
import {
  parseMultiLabelResponseDetailed,
  classifyParse,
} from './judgment-parser.js';

export interface Env {
  ANTHROPIC_API_KEY: string;
  /**
   * Cloudflare ネイティブ Rate Limiting binding（DOS 防御用）。
   * 旧 RATE_LIMIT_KV（KV カウンタ）を置換。KV write 無料枠（1,000/日）を
   * 食わず「1 判定 = 1 write」問題を解消する。設定は wrangler.toml の
   * `[[ratelimits]]`（limit=30 / period=60s）。
   */
  JUDGE_RATE_LIMITER: RateLimit;
}

// ─── 型定義 ──────────────────────────────────────────────────────────────────

type FilterVerdict = 'block' | 'allow' | 'uncertain';

/**
 * 旧 FilterMode の値域。shared の `FilterMode` と互換だが、proxy が実際に
 * 受け取る範囲を厳格化（string ではなく union）して使う。
 */
type LegacyFilterMode = 'strict' | 'standard' | 'lenient' | 'off';

/**
 * v0.2.0 拡張が送る旧形式リクエスト。
 *
 * shared の `JudgeRequest` 型は `filterMode: string` などの緩い型を持ち、また
 * `genre` ショートハンドフィールドが含まれていないため、proxy 内部で
 * 厳格化した型を定義して扱う。
 */
interface LegacyJudgeRequest {
  messages: Array<{ id: string; text: string }>;
  gameId?: string | null;
  progress?: UserProgress | null;
  filterMode?: LegacyFilterMode;
  selectedGenreTemplates?: string[];
  /** selectedGenreTemplates の単一ジャンル版ショートハンド（テスト・外部クライアント用） */
  genre?: string;
  videoTitle?: string;
  tier?: ModelTier;
}

/**
 * v0.3.0 拡張が送る新形式リクエスト。
 * judgment-engine の {@link JudgmentContext} をそのまま `context` として保持し、
 * モデル選択用の `tier` を別フィールドで送る。
 */
interface NewJudgeRequest {
  messages: Array<{ id: string; text: string }>;
  context: {
    game?: GameContext;
    settings: FilterSettings;
    /**
     * Phase 5（v0.6.0 / P5-B4c）字幕連動: 配信者の直近発話。`captionContext.enabled`
     * のクライアントだけが送る。normalizeRequest が JudgmentContext.recentAudio へ
     * 通し、buildSystemPrompt が Block3（cache_control なし）に乗せる。
     */
    recentAudio?: { text: string; qualityScore: number };
  };
  tier?: ModelTier;
}

/** 旧形式・新形式どちらも統一表現に変換した内部リクエスト */
interface NormalizedRequest {
  messages: Array<{ id: string; text: string }>;
  context: JudgmentContext;
  tier: ModelTier;
  /**
   * verdict 計算（lenient/standard/strict ベース）に使う旧 FilterMode 値。
   * judgment-engine の `categories.spoiler.strength` と互換。
   */
  legacyFilterMode: LegacyFilterMode;
}

// ─── レート制限設定 ───────────────────────────────────────────────────────────
//
// 上限値（30 req/min）はコードではなく wrangler.toml の `[[ratelimits]]`
// （simple.limit=30 / simple.period=60）で宣言する。ネイティブ Rate Limiting
// binding に移行したため、KV カウンタ実装（旧 RATE_LIMIT_MAX /
// RATE_LIMIT_WINDOW_SECONDS）は不要になった。

/**
 * 1リクエストあたりの最大メッセージ数。
 * judgment-engine の Stage2Batcher.maxBatch (デフォルト 20) と同値。
 * これを超えるとトークン予算超過 / DOS リスクがあるため 400 で拒否する。
 */
const MAX_MESSAGES_PER_REQUEST = 20;

// ─── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS: HeadersInit = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-fck-token',
};

// ─── エントリポイント ─────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/judge' && request.method === 'POST') {
      return handleJudge(request, env);
    }

    return jsonError('Not Found', 404);
  },
};

// ─── /api/judge ──────────────────────────────────────────────────────────────

async function handleJudge(request: Request, env: Env): Promise<Response> {
  // 匿名トークン検証（存在チェックのみ、将来的に署名検証を追加）
  const token = request.headers.get('x-fck-token');
  if (!token) {
    return jsonError('Missing x-fck-token header', 401);
  }

  // レート制限
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const allowed = await checkRateLimit(ip, env.JUDGE_RATE_LIMITER);
  if (!allowed) {
    return jsonError('Rate limit exceeded. Max 30 requests per minute.', 429);
  }

  // リクエストボディのパース
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (typeof body !== 'object' || body === null) {
    return jsonError('Body must be a JSON object', 400);
  }

  const bodyObj = body as Record<string, unknown>;
  const messages = bodyObj['messages'];
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonError('messages must be a non-empty array', 400);
  }
  if (messages.length > MAX_MESSAGES_PER_REQUEST) {
    return jsonError(`messages must not exceed ${MAX_MESSAGES_PER_REQUEST} items`, 400);
  }

  // 形式別バリデーション
  if (isNewFormat(bodyObj)) {
    // 新形式: context.settings の必須フィールドを実行時検証
    const settings = (bodyObj['context'] as Record<string, unknown> | null)?.['settings'];
    if (!isValidV2Settings(settings)) {
      return jsonError(
        'Invalid context.settings format (required: version, enabled, categories.spoiler.{enabled,strength})',
        400,
      );
    }
  } else {
    // 旧形式: gameId or genre/selectedGenreTemplates が必須
    const legacy = bodyObj as unknown as LegacyJudgeRequest;
    const hasGenre =
      (legacy.selectedGenreTemplates && legacy.selectedGenreTemplates.length > 0) || !!legacy.genre;
    if (!legacy.gameId && !hasGenre && !legacy.videoTitle) {
      return jsonError('gameId or genre/selectedGenreTemplates is required (legacy format)', 400);
    }
  }

  const normalized = normalizeRequest(bodyObj);
  const { results, degraded } = await judgeBatch(normalized, env.ANTHROPIC_API_KEY);

  const response: JudgeResponse = { results, ...(degraded ? { degraded: true } : {}) };
  return jsonOk(response);
}

// ─── リクエスト正規化（旧/新両形式対応）─────────────────────────────────────

function isNewFormat(body: Record<string, unknown>): boolean {
  return 'context' in body && typeof body['context'] === 'object' && body['context'] !== null;
}

/**
 * 新形式リクエストの `context.settings` を実行時検証する。
 *
 * **命名について（B3 hardening）**: 関数名は `isValidV2Settings` だが、
 * Phase 3（v0.4.0）以降の **v3 リクエストも受け付ける**。検証しているのは
 * v2/v3 共通の必須フィールドのみ:
 * - `version: number`（v2 = 2 / v3 = 3。値の厳密一致はチェックしない）
 * - `enabled: boolean`
 * - `categories.spoiler.{enabled: boolean, strength: 'loose'|'standard'|'strict'}`
 *
 * v3 で追加された harassment/spam/offTopic/backseat/userBlocks は optional
 * 扱いのため、ここでは検証しない（proxy は spoiler 強度しか参照しない）。
 * 関数名のリネームは __test__ 経由のテスト API を壊すため見送り、コメントで
 * 実態を明示する方針。検証範囲を広げたくなったら shared の
 * {@link import('@fresh-chat-keeper/shared').migrateSettings} に
 * フォールバックさせる方向で再設計する。
 */
function isValidV2Settings(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  const s = settings as Record<string, unknown>;
  if (typeof s['version'] !== 'number') return false;
  if (typeof s['enabled'] !== 'boolean') return false;
  return isValidCategorySettings(s['categories']);
}

function isValidCategorySettings(categories: unknown): boolean {
  if (typeof categories !== 'object' || categories === null) return false;
  const c = categories as Record<string, unknown>;
  if (typeof c['spoiler'] !== 'object' || c['spoiler'] === null) return false;
  const sp = c['spoiler'] as Record<string, unknown>;
  if (typeof sp['enabled'] !== 'boolean') return false;
  return sp['strength'] === 'loose' || sp['strength'] === 'standard' || sp['strength'] === 'strict';
}

function normalizeRequest(body: Record<string, unknown>): NormalizedRequest {
  if (isNewFormat(body)) {
    const newReq = body as unknown as NewJudgeRequest;
    const settings = newReq.context.settings;
    return {
      messages: newReq.messages,
      context: {
        game: newReq.context.game,
        settings,
        // P5-B4c: 字幕文脈を JudgmentContext へ通す（あれば）。buildSystemPrompt が
        // Block3（cache_control なし）に乗せる。無ければ従来どおり（字幕なし判定）。
        ...(newReq.context.recentAudio ? { recentAudio: newReq.context.recentAudio } : {}),
      },
      tier: newReq.tier ?? 'free',
      legacyFilterMode: strengthToLegacyMode(settings.categories.spoiler.strength),
    };
  }

  // 旧形式 → 統一表現
  const legacy = body as unknown as LegacyJudgeRequest;
  const filterMode: LegacyFilterMode = legacy.filterMode ?? 'standard';
  const game = buildGameContextFromLegacy(legacy);
  const settings: FilterSettings = {
    version: 3,
    enabled: true,
    displayMode: 'placeholder',
    filterMode: 'archive',
    categories: { spoiler: { enabled: true, strength: legacyModeToStrength(filterMode) } },
    customBlockWords: [],
    userTier: legacy.tier ?? 'free',
    ...(game ? { gameContext: game } : {}),
  };
  return {
    messages: legacy.messages,
    context: { game, settings },
    tier: legacy.tier ?? 'free',
    legacyFilterMode: filterMode,
  };
}

// B5 typescript hardening: default 節を持たない網羅 switch に統一
// （chrome-ext filter-orchestrator.ts の legacyFilterModeToStrength と同スタイル。
//  ラベル/モード追加時に TS の網羅チェックで取りこぼしを検出させる）。
function legacyModeToStrength(mode: LegacyFilterMode): 'loose' | 'standard' | 'strict' {
  switch (mode) {
    case 'lenient':
      return 'loose';
    case 'strict':
      return 'strict';
    case 'standard':
    case 'off':
      return 'standard';
  }
}

function strengthToLegacyMode(strength: 'loose' | 'standard' | 'strict'): LegacyFilterMode {
  switch (strength) {
    case 'loose':
      return 'lenient';
    case 'strict':
      return 'strict';
    case 'standard':
      return 'standard';
  }
}

/**
 * 旧 LegacyJudgeRequest から GameContext を組み立てる。
 *
 * 複数ジャンル併記（例: `selectedGenreTemplates: ['rpg', 'mystery']`）は、
 * judgment-engine の `GameContext.genreTemplate`（単一文字列）に対応するため、
 * 表示名（日本語）を `・` で結合した文字列を入れる。prompt-builder の
 * `resolveGenreName` は ID 解決失敗時に文字列をそのまま使うため、結合された
 * 表示名がそのままプロンプトに反映される。
 */
function buildGameContextFromLegacy(legacy: LegacyJudgeRequest): GameContext | undefined {
  const selectedIds =
    legacy.selectedGenreTemplates && legacy.selectedGenreTemplates.length > 0
      ? legacy.selectedGenreTemplates
      : legacy.genre
        ? [legacy.genre]
        : [];

  if (!legacy.gameId && selectedIds.length === 0 && !legacy.videoTitle) {
    return undefined;
  }

  const genreTemplate = buildGenreTemplateField(selectedIds);

  let progressType: 'chapter' | 'event' | 'none' = 'none';
  let currentChapter: string | undefined;
  let completedEvents: string[] | undefined;
  if (legacy.progress) {
    progressType = legacy.progress.progressModel;
    currentChapter = legacy.progress.currentChapterId;
    completedEvents = legacy.progress.completedEventIds;
  }

  return {
    ...(legacy.gameId ? { gameId: legacy.gameId } : {}),
    ...(legacy.videoTitle ? { gameTitle: legacy.videoTitle } : {}),
    progressType,
    ...(currentChapter ? { currentChapter } : {}),
    ...(completedEvents ? { completedEvents } : {}),
    ...(genreTemplate ? { genreTemplate } : {}),
  };
}

function buildGenreTemplateField(selectedIds: string[]): string | undefined {
  if (selectedIds.length === 0) return undefined;
  if (selectedIds.length === 1) return selectedIds[0];
  // 複数併記: 表示名を解決して `・` で結合（prompt-builder が ID 解決失敗時に
  // 文字列をそのまま name として扱うため、結合済み文字列がそのままプロンプトに乗る）
  const all = getAllGenreTemplates();
  return selectedIds.map((id) => all.find((t) => t.id === id)?.name ?? id).join('・');
}

// ─── バッチ LLM 判定 ───────────────────────────────────────────────────────────

/** Anthropic を 1 回呼び、本文テキストを返す。失敗時は null（呼び出し側で fallback）。 */
async function callAnthropicOnce(
  body: string,
  apiKey: string,
): Promise<string | null> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body,
  });
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[FreshChatKeeper] Anthropic API error ${response.status}: ${errorText}`);
    return null;
  }
  const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
  return data.content[0]?.text ?? '';
}

async function judgeBatch(
  req: NormalizedRequest,
  apiKey: string,
): Promise<{ results: FilterResult[]; degraded: boolean }> {
  const modelCfg = getEffectiveModel(req.tier);

  // judgment-engine の Message 型に合わせて変換（authorChannelId/authorDisplayName/timestamp は
  // 判定には使われないので空値で OK。プロキシ経由のリクエストには元々これらが含まれない）
  const judgmentMessages: JudgmentMessage[] = req.messages.map((m) => ({
    id: m.id,
    text: m.text,
    authorChannelId: '',
    authorDisplayName: '',
    timestamp: 0,
  }));

  const systemBlocks = buildSystemPrompt(req.context, {
    supportsCaching: modelCfg.supportsCaching,
  });
  const userPrompt = buildUserPrompt(judgmentMessages);

  // バッチサイズに応じて max_tokens を増やす（modelCfg.maxTokens は単一メッセージ前提の200）
  const maxTokens = Math.max(modelCfg.maxTokens, req.messages.length * 100);

  // ネットワーク失敗・LLM エラー時の全件 uncertain fallback。
  // Phase 3 マルチラベル化後も verdict 計算経路を維持（chrome-ext v0.3.5 互換）。
  const fallbackResults = (): { results: FilterResult[]; degraded: boolean } => ({
    results: req.messages.map((m) => ({
      messageId: m.id,
      verdict: uncertainVerdict(req.legacyFilterMode),
      stage: 2,
    })),
    // ネットワーク/HTTP 失敗は「LLM 応答そのものが無い」= degraded 扱い。
    // chrome-ext は safe をキャッシュせず再判定の余地を残す。
    degraded: true,
  });

  const requestBody = JSON.stringify({
    model: modelCfg.model,
    max_tokens: maxTokens,
    temperature: modelCfg.temperature,
    system: systemBlocks,
    messages: [{ role: 'user', content: userPrompt }],
  });

  try {
    let text = await callAnthropicOnce(requestBody, apiKey);
    if (text === null) return fallbackResults();

    const messageIds = req.messages.map((m) => m.id);
    let detail = parseMultiLabelResponseDetailed(text, messageIds);

    // パース失敗（配列抽出不可 / JSON.parse 例外）は握り潰さず warn → 1 回だけ
    // 同一リクエストを再送リトライ（CLAUDE.md 設計原則 3 例外運用）。
    if (detail.degraded) {
      const cls = classifyParse(text);
      console.warn(
        `[FreshChatKeeper] Stage 2 parse failed (${cls.status})${
          cls.error ? `: ${cls.error instanceof Error ? cls.error.message : String(cls.error)}` : ''
        }; retrying once`,
      );
      const retryText = await callAnthropicOnce(requestBody, apiKey);
      if (retryText !== null) {
        text = retryText;
        detail = parseMultiLabelResponseDetailed(text, messageIds);
      }
      if (detail.degraded) {
        // B5 silent-failure hardening: リトライ後の失敗理由も classifyParse の
        // status（no_array / json_error）を含めて記録する（初回 warn と
        // 同粒度。LLM 出力の壊れ方の切り分けに必要）。
        const retryCls = classifyParse(text);
        console.warn(
          `[FreshChatKeeper] Stage 2 parse still failing after retry (${retryCls.status})${
            retryCls.error
              ? `: ${retryCls.error instanceof Error ? retryCls.error.message : String(retryCls.error)}`
              : ''
          }; returning all-safe (degraded), not caching`,
        );
      }
    }

    const results: FilterResult[] = detail.judgments.map((p) => {
      const verdict = primaryToVerdict(p.primary, req.context.settings, req.legacyFilterMode);
      return {
        messageId: p.messageId,
        verdict,
        labels: p.labels,
        primary: p.primary,
        // ── 後方互換ブリッジ（B3 hardening / B2 typescript-reviewer 対応）──
        // chrome-ext v0.3.5 は応答の `spoilerCategory` を見て verdict を再計算する
        // （filter-orchestrator → chrome-cache の verdictFromCache）。B2 で
        // spoilerCategory を廃止したまま proxy を単独デプロイすると、v0.3.5 の
        // 全 lenient 以外ユーザーが Stage 2 通過コメントを全件 block してしまう。
        // chrome-ext v0.4.0（B3 で labels/primary 消費に移行）が Web Store で
        // 行き渡るまでの保険として、primary から最小限の spoilerCategory を導出する。
        // direct/foreshadowing/gameplay の区別は失われるが、v0.3.5 の
        // verdictFromCache は direct_spoiler=block / safe=allow を正しく扱える。
        // @todo chrome-ext v0.4.0 が Web Store 配布で十分に行き渡ったら削除可
        //   （旧版ユーザーがほぼ居なくなった時点。proxy 単独デプロイ前提を解除）
        spoilerCategory:
          p.primary === 'spoiler'
            ? ('direct_spoiler' as const)
            : p.primary === 'safe'
              ? ('safe' as const)
              : undefined,
        confidence: p.confidence,
        stage: 2,
        ...(p.reasonJa ? { reason: p.reasonJa } : {}),
      };
    });
    return { results, degraded: detail.degraded };
  } catch (err) {
    console.error('[FreshChatKeeper] judgeBatch error:', err);
    return fallbackResults();
  }
}

// ─── ヘルパー ─────────────────────────────────────────────────────────────────

async function checkRateLimit(ip: string, limiter: RateLimit): Promise<boolean> {
  try {
    const { success } = await limiter.limit({ key: ip });
    return success;
  } catch (err) {
    // binding 障害時は fail-open（リクエストを通す）。MVP 段階ではユーザーがフィルタを
    // 失う方が、レート制限がたまに無効化されることよりも痛い。warn ログで
    // 障害の発生を可視化し、頻発するなら別途対応を検討する（HARD-01 を踏襲）。
    console.warn(
      `[FreshChatKeeper] rate limit binding error (failing open): ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

/** LLM 判定失敗時の verdict をモードに応じて決定する。lenient では安全側（allow）に倒す。 */
function uncertainVerdict(filterMode: LegacyFilterMode): FilterVerdict {
  return filterMode === 'lenient' ? 'allow' : 'uncertain';
}

/**
 * Phase 3: マルチラベル判定の `primary` から verdict を導出する。
 *
 * - `safe`: 常に allow
 * - `spoiler`: 強度の解釈は **LLM プロンプト側で処理済み** （prompt-builder の
 *   STATIC_INSTRUCTIONS が strict/standard/loose で何をブロックするか明示している）
 *   なので、proxy は LLM が `spoiler` と判定したものを素直に block する。
 *   ただし legacy fallback として lenient ユーザー向けに allow に倒すことはしない
 *   （プロンプトで `loose` の場合は LLM が明示的ネタバレ以外を spoiler と判定しない）
 * - `harassment` / `spam` / `off_topic` / `backseat`: 該当カテゴリが OFF なら allow
 *   （LLM はプロンプトの「OFF カテゴリは safe」指示に従って本来 OFF カテゴリを
 *   返さないはずだが、フェイルセーフ）。ON なら block
 *
 * legacyFilterMode は spoiler のみ後方互換性のためにある（chrome-ext v0.3.5 が
 * 送る `filterMode: 'lenient'` 等で spoiler verdict を調整するレガシー経路）。
 */
function primaryToVerdict(
  primary: JudgmentLabel,
  settings: FilterSettings,
  legacyFilterMode: LegacyFilterMode,
): FilterVerdict {
  switch (primary) {
    case 'safe':
      return 'allow';
    case 'spoiler':
      // Phase 2 互換: lenient モードで spoiler 判定が来た場合のみ allow に倒す。
      // 新しいプロンプトは strength を加味するため lenient で returning spoiler は
      // 「明示的ネタバレ」のみだが、過剰防衛として残しておく。
      return 'block';
    case 'harassment':
      return settings.categories.harassment?.enabled === true ? 'block' : 'allow';
    case 'spam':
      return settings.categories.spam?.enabled === true ? 'block' : 'allow';
    case 'off_topic':
      return settings.categories.offTopic?.enabled === true ? 'block' : 'allow';
    case 'backseat':
      return settings.categories.backseat?.enabled === true ? 'block' : 'allow';
    default: {
      // B4a hardening D: コンパイル時網羅チェック。JudgmentLabel に新ラベルを
      // 足して case を忘れると型エラー（never 代入不可）になる。
      const _exhaustive: never = primary;
      void _exhaustive;
      // 実行時防御: JSON 由来で型外の値が来た場合は安全側 uncertain + warn
      console.warn(
        `[FreshChatKeeper] Unknown primary label: ${String(primary)}, falling back to uncertainVerdict`,
      );
      return uncertainVerdict(legacyFilterMode);
    }
  }
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─── テスト用エクスポート ─────────────────────────────────────────────────────
// 単体テストから内部ヘルパーを直接検証するためのエクスポート。
// 実行時のエンドポイントは default export 経由なので、以下を import しても
// プロキシの挙動には影響しない。

export const __test__ = {
  isNewFormat,
  normalizeRequest,
  legacyModeToStrength,
  strengthToLegacyMode,
  buildGameContextFromLegacy,
  buildGenreTemplateField,
  uncertainVerdict,
  primaryToVerdict,
  checkRateLimit,
  isValidV2Settings,
};
