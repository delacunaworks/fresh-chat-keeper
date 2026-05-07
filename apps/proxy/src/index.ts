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

export interface Env {
  ANTHROPIC_API_KEY: string;
  RATE_LIMIT_KV: KVNamespace;
}

// ─── 型定義 ──────────────────────────────────────────────────────────────────

type SpoilerCategory = 'direct_spoiler' | 'foreshadowing_hint' | 'gameplay_hint' | 'safe';
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

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60;

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
  const allowed = await checkRateLimit(ip, env.RATE_LIMIT_KV);
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
  const results = await judgeBatch(normalized, env.ANTHROPIC_API_KEY);

  const response: JudgeResponse = { results };
  return jsonOk(response);
}

// ─── リクエスト正規化（旧/新両形式対応）─────────────────────────────────────

function isNewFormat(body: Record<string, unknown>): boolean {
  return 'context' in body && typeof body['context'] === 'object' && body['context'] !== null;
}

/**
 * 新形式リクエストの `context.settings` を実行時検証する。
 *
 * 必須フィールドのみを最低限ガード:
 * - `version: number`（v2 マイグレーション後は 2）
 * - `enabled: boolean`
 * - `categories.spoiler.{enabled: boolean, strength: 'loose'|'standard'|'strict'}`
 *
 * 軽量化のため zod 等の追加依存は使わず手書きガード。検証範囲を広げたくなったら
 * shared の {@link import('@fresh-chat-keeper/shared').migrateSettings} に
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
      context: { game: newReq.context.game, settings },
      tier: newReq.tier ?? 'free',
      legacyFilterMode: strengthToLegacyMode(settings.categories.spoiler.strength),
    };
  }

  // 旧形式 → 統一表現
  const legacy = body as unknown as LegacyJudgeRequest;
  const filterMode: LegacyFilterMode = legacy.filterMode ?? 'standard';
  const game = buildGameContextFromLegacy(legacy);
  const settings: FilterSettings = {
    version: 2,
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

function legacyModeToStrength(mode: LegacyFilterMode): 'loose' | 'standard' | 'strict' {
  switch (mode) {
    case 'lenient':
      return 'loose';
    case 'strict':
      return 'strict';
    case 'standard':
    case 'off':
    default:
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
    default:
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

async function judgeBatch(
  req: NormalizedRequest,
  apiKey: string,
): Promise<FilterResult[]> {
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

  const fallbackResults = (): FilterResult[] =>
    req.messages.map((m) => ({
      messageId: m.id,
      verdict: uncertainVerdict(req.legacyFilterMode),
      stage: 2,
    }));

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelCfg.model,
        max_tokens: maxTokens,
        temperature: modelCfg.temperature,
        system: systemBlocks,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[FreshChatKeeper] Anthropic API error ${response.status}: ${errorText}`);
      return fallbackResults();
    }

    const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
    const text = data.content[0]?.text ?? '';

    // ```json ... ``` のような余分な記法にも対応するため、最初の `[` から最後の `]` までを抽出
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      console.error('[FreshChatKeeper] Failed to extract JSON array from LLM response:', text);
      return fallbackResults();
    }

    let judgments: Array<{
      messageId: string;
      spoiler_category: SpoilerCategory;
      confidence: number;
      reason: string;
    }>;
    try {
      judgments = JSON.parse(arrayMatch[0]);
    } catch (err) {
      console.error('[FreshChatKeeper] JSON parse failed:', err);
      return fallbackResults();
    }

    if (!Array.isArray(judgments)) {
      console.error('[FreshChatKeeper] LLM response is not an array');
      return fallbackResults();
    }

    const judgmentById = new Map(judgments.map((j) => [j.messageId, j]));

    return req.messages.map((m) => {
      const j = judgmentById.get(m.id);
      if (!j) {
        return {
          messageId: m.id,
          verdict: uncertainVerdict(req.legacyFilterMode),
          stage: 2,
        };
      }
      return {
        messageId: m.id,
        verdict: categoryToVerdict(j.spoiler_category, req.legacyFilterMode),
        spoilerCategory: j.spoiler_category,
        confidence: j.confidence,
        reason: j.reason,
        stage: 2,
      };
    });
  } catch (err) {
    console.error('[FreshChatKeeper] judgeBatch error:', err);
    return fallbackResults();
  }
}

// ─── ヘルパー ─────────────────────────────────────────────────────────────────

async function checkRateLimit(ip: string, kv: KVNamespace): Promise<boolean> {
  try {
    const windowKey = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
    const key = `rl:${ip}:${windowKey}`;

    const current = await kv.get(key);
    const count = current !== null ? parseInt(current, 10) : 0;

    if (count >= RATE_LIMIT_MAX) {
      return false;
    }

    await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2 });
    return true;
  } catch (err) {
    // KV 障害時は fail-open（リクエストを通す）。MVP 段階ではユーザーがフィルタを
    // 失う可逸の方が、レート制限がたまに無効化されることよりも痛い。warn ログで
    // 障害の発生を可視化し、頻発するなら別途対応を検討する。
    console.warn(
      `[FreshChatKeeper] KV rate limit error (failing open): ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

/** LLM 判定失敗時の verdict をモードに応じて決定する。lenient では安全側（allow）に倒す。 */
function uncertainVerdict(filterMode: LegacyFilterMode): FilterVerdict {
  return filterMode === 'lenient' ? 'allow' : 'uncertain';
}

function categoryToVerdict(category: SpoilerCategory, filterMode: LegacyFilterMode): FilterVerdict {
  switch (category) {
    case 'direct_spoiler':
      return 'block';
    case 'foreshadowing_hint':
      return filterMode === 'lenient' ? 'allow' : 'block';
    case 'gameplay_hint':
      return filterMode === 'strict' ? 'block' : 'allow';
    case 'safe':
      return 'allow';
    default:
      // LLM ハルシネーションで想定外の spoiler_category（例: "unknown" / typo /
      // 未知ラベル）が返るケースのフォールバック。安全側に倒し、modeに応じた
      // uncertain 判定（lenient: allow、それ以外: uncertain）を返す。
      console.warn(
        `[FreshChatKeeper] Unknown spoiler_category: ${String(category)}, falling back to uncertainVerdict`,
      );
      return uncertainVerdict(filterMode);
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
  categoryToVerdict,
  checkRateLimit,
  isValidV2Settings,
};
