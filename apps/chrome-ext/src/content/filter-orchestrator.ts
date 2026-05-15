/**
 * Stage 2 オーケストレーション（Chrome 拡張側）。
 *
 * 旧 `stage2.ts` の `sendStage2Batch` 相当を judgment-engine 経由に切り替えた版。
 *
 * 主な変更点:
 * - proxy リクエストを **新形式（`context` + `tier`）** で送信する
 *   （旧形式は P2-PROXY-01 で proxy 側が後方互換でサポート済み、新拡張は新形式を使う）
 * - LLM 通信は {@link createChromeTransport} 経由に抽象化（fetch のラッパー）
 * - キャッシュは `chrome-cache.ts`（既存仕様 fck_judge_cache）を維持
 *
 * archive.ts からは `sendStage2Batch(batch, settings, token, onResult, videoTitle)` で
 * 呼ばれる。signature は旧 stage2.ts と同じ（archive.ts 側の変更は import 先の
 * 切り替えのみ）。
 */

import type { Settings, GameProgress } from '../shared/settings.js';
import type { JudgeRequestPayload, JudgmentContext } from '@fresh-chat-keeper/judgment-engine';
import type { FilterSettings, GameContext } from '@fresh-chat-keeper/shared';
import { getAllGenreTemplates } from '@fresh-chat-keeper/knowledge-base';
import { createChromeTransport } from './chrome-transport.js';
import {
  parseSpoilerCategory,
  saveJudgeCacheEntry,
  type JudgeCacheEntry,
  type OnStage2Result,
  type Stage2Candidate,
} from './chrome-cache.js';
import type { JudgmentLabel } from '@fresh-chat-keeper/shared';

/**
 * バッチ（最大5件）をプロキシに送信し、結果を onResult コールバックで返す。
 *
 * - ネットワークエラー・プロキシ停止時はコールバックを呼ばずに終了する
 *   （Stage 1 を通過した候補なので、フィルタしない方が安全）
 * - LLM 判定失敗時の verdict は verdictFromCache が filterMode に応じて決定する
 *
 * @returns プロキシへの HTTP リクエストが成功した場合 true、失敗した場合 false。
 *          呼び出し元はこの戻り値に応じて利用量カウントをインクリメントする。
 */
export async function sendStage2Batch(
  batch: Stage2Candidate[],
  settings: Settings,
  token: string,
  onResult: OnStage2Result,
  videoTitle?: string,
): Promise<boolean> {
  if (batch.length === 0) return true;

  const transport = createChromeTransport(settings.proxyUrl, token);
  const payload = buildJudgeRequestPayload(batch, settings, videoTitle);

  let response;
  try {
    response = await transport.sendJudgeRequest(payload);
  } catch (err) {
    console.error(
      `[FreshChatKeeper] Stage 2エラー: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  // B4a: proxy が degraded（Stage 2 パース失敗でリトライしてもなお全件 safe）
  // を返した場合、その safe を永続キャッシュしない。次回バッチ/リロードで
  // 再判定する余地を残す（phase-3-multilabel.md §追補 2）。その場の verdict は
  // onResult 経由で適用される（safe = 通す）。
  const degraded = response.degraded === true;

  for (const result of response.results) {
    const idx = parseInt(result.messageId, 10);
    const candidate = batch[idx];
    if (!candidate) continue;

    // Phase 3: proxy は labels/primary を返す（FilterResult 拡張）。
    // 旧 proxy 互換のため spoilerCategory も後方互換ブリッジで届くので、
    // primary が無いレスポンス（理論上は無いが念のため）は spoilerCategory に
    // フォールバックする。両方無ければ判定失敗扱い（spoilerCategory: null）。
    const primary = sanitizeLabel(result.primary);
    const labels = sanitizeLabels(result.labels);
    const entry: JudgeCacheEntry = {
      ...(primary ? { primary } : {}),
      ...(labels.length > 0 ? { labels } : {}),
      spoilerCategory: parseSpoilerCategory(result.spoilerCategory),
      ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
    };

    // verdict 計算は archive.ts 側で applyStage2Verdict が verdictFromCache を呼ぶ。
    // degraded のときは保存をスキップ（再判定余地を残す）。onResult はその場の
    // verdict 適用のため degraded でも必ず呼ぶ。
    if (!degraded) {
      await saveJudgeCacheEntry(candidate.cacheKey, entry);
    }
    onResult(candidate, entry);
  }

  return true;
}

// ─── マルチラベル sanitize ─────────────────────────────────────────────────

const VALID_LABEL_SET = new Set<JudgmentLabel>([
  'safe',
  'spoiler',
  'harassment',
  'spam',
  'off_topic',
  'backseat',
]);

/** proxy レスポンスの primary を JudgmentLabel に narrowing（不正値は undefined）。 */
function sanitizeLabel(raw: unknown): JudgmentLabel | undefined {
  return typeof raw === 'string' && VALID_LABEL_SET.has(raw as JudgmentLabel)
    ? (raw as JudgmentLabel)
    : undefined;
}

/** proxy レスポンスの labels[] を JudgmentLabel[] に narrowing（不正要素は除外）。 */
function sanitizeLabels(raw: unknown): JudgmentLabel[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((l): l is JudgmentLabel => sanitizeLabel(l) !== undefined);
}

// ─── ペイロード構築（新形式: context + tier）─────────────────────────────────

function buildJudgeRequestPayload(
  batch: Stage2Candidate[],
  settings: Settings,
  videoTitle: string | undefined,
): JudgeRequestPayload {
  const context = buildJudgmentContext(settings, videoTitle);
  return {
    messages: batch.map((c, i) => ({ id: String(i), text: c.text })),
    context: {
      game: context.game,
      settings: context.settings,
    },
    tier: 'free',
  } as JudgeRequestPayload;
}

/**
 * 既存 chrome-ext の {@link Settings} を judgment-engine の
 * {@link JudgmentContext}（ゲーム + v2 設定）に変換する。
 *
 * 既存 chrome-ext の保存形式は v0.2.0 から変更しない方針のため、
 * proxy / judgment-engine に渡す段階でのみ v2 形式に変換する。
 */
function buildJudgmentContext(settings: Settings, videoTitle: string | undefined): JudgmentContext {
  const isKBGame = settings.gameId !== 'none' && settings.gameId !== 'other';
  const game = buildGameContext(settings, isKBGame, videoTitle);

  // Phase 3 / v3: canonical FilterSettings は v3 形式（マルチラベル + userBlocks）。
  // chrome-ext 内部の {@link Settings} には新カテゴリの ON/OFF を保持する UI が
  // まだ存在しない（B3 で追加予定）ので、ここでは spoiler のみアクティブな v3 を
  // 構築する。新カテゴリ optional は未指定のまま渡しても judgment-engine 側で
  // 安全に扱える（runStage1_5 は categories.spam?.enabled === true でのみ発火）。
  const filterSettings: FilterSettings = {
    version: 3,
    enabled: settings.enabled,
    displayMode: settings.displayMode,
    filterMode: 'archive', // v2 の filterMode は archive/live。既存 chrome-ext には対応情報なし → archive 既定
    categories: {
      spoiler: {
        enabled: true,
        strength: legacyFilterModeToStrength(settings.filterMode),
      },
    },
    customBlockWords: settings.customNgWords
      .filter((w) => w.enabled)
      .map((w) => w.word),
    userTier: 'free',
    ...(game ? { gameContext: game } : {}),
  };

  return { settings: filterSettings, ...(game ? { game } : {}) };
}

function buildGameContext(
  settings: Settings,
  isKBGame: boolean,
  videoTitle: string | undefined,
): GameContext | undefined {
  const selected = settings.selectedGenreTemplates ?? [];
  if (!isKBGame && selected.length === 0 && !videoTitle) return undefined;

  const progress: GameProgress | undefined = isKBGame
    ? settings.progressByGame[settings.gameId]
    : undefined;

  let progressType: 'chapter' | 'event' | 'none' = 'none';
  let currentChapter: string | undefined;
  let completedEvents: string[] | undefined;
  if (progress?.progressModel === 'chapter' && progress.currentChapterId) {
    progressType = 'chapter';
    currentChapter = progress.currentChapterId;
  } else if (progress?.progressModel === 'event' && progress.completedEventIds) {
    progressType = 'event';
    completedEvents = progress.completedEventIds;
  }

  // 複数ジャンル併記対応: judgment-engine の GameContext.genreTemplate は単一文字列だが、
  // chrome-ext の UI（popup/App.tsx の GenreTemplateSection）は複数選択可能。
  // 既存挙動（v0.2.0 で proxy 側が複数併記を扱う）と同等の判定精度を維持するため、
  // ここで日本語表示名を `・` で結合した文字列を詰める。proxy 側の prompt-builder の
  // resolveGenreName が ID 解決失敗時に文字列をそのまま name として扱う仕様を活用
  // （proxy の buildGenreTemplateField と同じロジック）。
  const genreTemplate = buildGenreTemplateField(selected);

  return {
    ...(isKBGame ? { gameId: settings.gameId } : {}),
    ...(videoTitle ? { gameTitle: videoTitle } : {}),
    progressType,
    ...(currentChapter ? { currentChapter } : {}),
    ...(completedEvents ? { completedEvents } : {}),
    ...(genreTemplate ? { genreTemplate } : {}),
  };
}

function buildGenreTemplateField(selectedIds: string[]): string | undefined {
  if (selectedIds.length === 0) return undefined;
  if (selectedIds.length === 1) return selectedIds[0];
  // 複数選択時: 表示名を解決して `・` で結合
  const all = getAllGenreTemplates();
  return selectedIds.map((id) => all.find((t) => t.id === id)?.name ?? id).join('・');
}

function legacyFilterModeToStrength(
  mode: 'strict' | 'standard' | 'lenient' | 'off',
): 'loose' | 'standard' | 'strict' {
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
