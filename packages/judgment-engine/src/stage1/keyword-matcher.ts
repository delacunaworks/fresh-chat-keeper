/**
 * Stage 1 キーワードマッチ（知識ベースに基づく）。
 *
 * 既存 `apps/chrome-ext/src/content/filter.ts` のロジックを移植。
 * オリジナルとの差分:
 * - `@kb-data/...` の直接 import を排除し、`@fresh-chat-keeper/knowledge-base` の
 *   `getGame(id)` でゲームデータを取得する形に変更。挙動は完全に同一。
 * - `getBlockedLevels` / `FilterMode` / `GameProgress` の型を本ファイル内にインライン化
 *   （chrome-ext の settings.ts 依存を排除）。
 *
 * 公開関数:
 * - {@link buildKeywordSet}
 * - {@link buildDescriptionPhraseSet}
 * - {@link matchesKeyword}（Stage 1 本体判定の3パターン）
 * - {@link matchesKeywordForStage2}
 */

import type { KBGame } from '@fresh-chat-keeper/knowledge-base';
import { getGame } from '@fresh-chat-keeper/knowledge-base';
import { matchesSpoilerVerb, normalizeKana } from '@fresh-chat-keeper/shared';

/** 既存 chrome-ext settings.ts と互換の FilterMode 型 */
export type FilterMode = 'strict' | 'standard' | 'lenient' | 'off';

/** 既存 chrome-ext settings.ts と互換の GameProgress 型 */
export interface GameProgress {
  progressModel: 'chapter' | 'event';
  currentChapterId?: string;
  completedEventIds?: string[];
}

/**
 * フィルタモードに応じてブロック対象の spoiler_level を返す。
 * filter.ts の getBlockedLevels と完全同一。
 */
function getBlockedLevels(mode: FilterMode): string[] {
  switch (mode) {
    case 'strict':
      return ['direct_spoiler', 'foreshadowing_hint', 'gameplay_hint'];
    case 'standard':
      return ['direct_spoiler', 'foreshadowing_hint'];
    case 'lenient':
      return ['direct_spoiler'];
    case 'off':
      return [];
  }
}

/**
 * 知識ベースから現在のフィルタモード・進行状況に応じたキーワード集合を構築する。
 *
 * **進行状況セマンティクス（v0.3.1 PROG-01 で明示）**:
 * - `currentChapterId` は「現在視聴中のチャプター（未通過）」を意味する
 * - `currentChapter 自身`のキーワードはブロック対象（視聴中なのでネタバレを避ける）
 * - `currentChapter より前`のチャプターのキーワードは通過済みとして除外
 * - `currentChapter より後`のチャプターのキーワードもブロック対象（先のネタバレ）
 *
 * 除外条件: `currentChapterIdx > unlockedIdx`
 *   = 「アンロック章が現在視聴中の章より前」のときのみ除外
 *   = 「アンロック章が現在の章と同じ または より後」はブロック対象として残す
 */
export function buildKeywordSet(
  gameId: string,
  filterMode: FilterMode,
  progress?: GameProgress,
): Set<string> {
  const game: KBGame | undefined = getGame(gameId);
  if (!game) return new Set();

  const blockedLevels = getBlockedLevels(filterMode);
  const keywords = new Set<string>();
  const chapters = game.chapters ?? [];

  const currentChapterIdx = progress?.currentChapterId
    ? chapters.findIndex((c) => c.id === progress.currentChapterId)
    : -1;

  const shouldBlock = (entity: {
    keywords: string[];
    spoiler_level?: string;
    unlocked_after_chapter?: string;
  }): boolean => {
    if (entity.spoiler_level && !blockedLevels.includes(entity.spoiler_level)) return false;

    if (
      progress?.progressModel === 'chapter' &&
      entity.unlocked_after_chapter &&
      currentChapterIdx !== -1
    ) {
      const unlockedIdx = chapters.findIndex((c) => c.id === entity.unlocked_after_chapter);
      // 視聴中セマンティクス: アンロック章が現在の章より「前」のものだけ除外。
      // 同じ章 (==) または より後 (<) はブロック対象として残す。
      if (unlockedIdx !== -1 && currentChapterIdx > unlockedIdx) return false;
    }

    return true;
  };

  for (const entity of [...game.spoiler_entities, ...(game.global_spoilers ?? [])]) {
    if (shouldBlock(entity)) {
      for (const kw of entity.keywords) keywords.add(kw);
    }
  }

  return keywords;
}

/**
 * 知識ベースの description から「」括りの英数字含む固有フレーズを抽出する。
 * 例: 「DL-6号事件」「SL-9号事件」
 */
export function buildDescriptionPhraseSet(gameId: string): Set<string> {
  const game = getGame(gameId);
  if (!game) return new Set();

  const phrases = new Set<string>();
  const QUOTED_RE = /「([^」]+)」/g;
  const HAS_ALPHANUMERIC_RE = /[\d\w]/;

  const extractFromText = (text: string | undefined) => {
    if (!text) return;
    for (const match of text.matchAll(QUOTED_RE)) {
      const phrase = match[1];
      if (HAS_ALPHANUMERIC_RE.test(phrase)) {
        phrases.add(phrase);
      }
    }
  };

  for (const chapter of game.chapters ?? []) {
    extractFromText(chapter.description);
  }
  for (const entity of [...game.spoiler_entities, ...(game.global_spoilers ?? [])]) {
    extractFromText(entity.description);
  }

  return phrases;
}

export type MatchReason = 'spoiler_word' | 'description_phrase' | 'keyword_with_verb';

export interface MatchResult {
  reason: MatchReason;
  keyword?: string;
  verb?: string;
  phrase?: string;
}

/**
 * Stage 1 キーワード本体判定。3パターンのいずれかにマッチした場合に MatchResult を返す。
 *
 * - パターン1: `ネタバレ` という単語そのものを含む（カナ正規化後）
 * - パターン2: 知識ベース description の固有フレーズに直接マッチ
 * - パターン3: ゲームキーワード + 明確なネタバレ動詞の組み合わせ
 */
export function matchesKeyword(
  text: string,
  keywords: Set<string>,
  descriptionPhrases: Set<string>,
): MatchResult | null {
  const normalized = normalizeKana(text);

  if (normalized.includes('ネタバレ')) {
    return { reason: 'spoiler_word' };
  }

  for (const phrase of descriptionPhrases) {
    if (normalized.includes(normalizeKana(phrase))) {
      return { reason: 'description_phrase', phrase };
    }
  }

  const verb = matchesSpoilerVerb(text);
  if (verb !== null) {
    for (const kw of keywords) {
      if (normalized.includes(normalizeKana(kw))) {
        return { reason: 'keyword_with_verb', keyword: kw, verb };
      }
    }
  }

  return null;
}

/**
 * Stage 2 候補判定（KW単体マッチ）。Stage 1 が null を返した後にのみ呼ぶ前提。
 * 動詞は要求しないため、`matchesKeyword` よりヒットしやすい。
 */
export function matchesKeywordForStage2(text: string, keywords: Set<string>): string | null {
  const normalized = normalizeKana(text);
  for (const kw of keywords) {
    if (normalized.includes(normalizeKana(kw))) {
      return kw;
    }
  }
  return null;
}
