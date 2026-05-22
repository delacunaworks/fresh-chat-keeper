/**
 * `runStage1` 統合テスト。
 *
 * `runStage1` の4つの outcome すべてが期待通りに発生することを検証する:
 * - filter (custom_blocklist) — カスタムNGワードヒット
 * - filter (keyword_match) — KBキーワード/フレーズヒット
 * - pass (obviously_safe) — 短い定型反応
 * - gray (needs_stage2) — 上記いずれにも該当しない
 *
 * 特に obviously_safe 経路は、既存 filter.ts には存在しない**新実装での最適化**で
 * あり、parity test では検証されない。本テストでこれを明示的に保護する。
 */

import { describe, it, expect } from 'vitest';
import { runStage1, type Stage1Result } from '../../src/stage1/index.js';
import type { Message, JudgmentContext } from '../../src/types.js';
import type { FilterSettings, GameContext } from '@fresh-chat-keeper/shared';

// ─── ヘルパー ──────────────────────────────────────────────
function buildSettings(overrides?: Partial<FilterSettings>): FilterSettings {
  return {
    version: 3,
    enabled: true,
    displayMode: 'placeholder',
    filterMode: 'archive',
    categories: { spoiler: { enabled: true, strength: 'standard' } },
    customBlockWords: [],
    userTier: 'free',
    ...overrides,
  };
}

function buildContext(args?: {
  game?: Partial<GameContext>;
  settings?: Partial<FilterSettings>;
}): JudgmentContext {
  return {
    settings: buildSettings(args?.settings),
    game: args?.game
      ? { progressType: 'none', ...args.game }
      : undefined,
  };
}

function buildMessage(text: string, id = 'm1'): Message {
  return {
    id,
    text,
    authorChannelId: 'UC_test',
    authorDisplayName: 'tester',
    timestamp: 1_700_000_000_000,
  };
}

// ─── テスト ────────────────────────────────────────────────
describe('runStage1', () => {
  describe('outcome: filter (custom_blocklist)', () => {
    it('カスタムNGワードがマッチすると custom_blocklist で filter', () => {
      const ctx = buildContext({
        settings: { customBlockWords: ['秘密ワード'] },
      });
      const result = runStage1(buildMessage('これは秘密ワードを含む'), ctx);
      expect(result).toEqual<Stage1Result>({
        outcome: 'filter',
        reason: 'custom_blocklist',
        label: 'spoiler',
      });
    });
  });

  describe('outcome: filter (keyword_match)', () => {
    it('KBキーワード + 動詞がマッチすると keyword_match で filter', () => {
      const ctx = buildContext({
        game: {
          gameId: 'ace-attorney-1',
          progressType: 'chapter',
          currentChapter: 'ch1',
        },
      });
      // 「高日」(KB登録 KW) + 「死んだ」(動詞)
      const result = runStage1(buildMessage('高日が死んだのか'), ctx);
      expect(result).toEqual<Stage1Result>({
        outcome: 'filter',
        reason: 'keyword_match',
        label: 'spoiler',
      });
    });
  });

  describe('outcome: pass (obviously_safe) — 新実装での最適化経路', () => {
    it('「草」のみは customBlockWords 空・game なしでも即 pass', () => {
      const ctx = buildContext();
      const result = runStage1(buildMessage('草'), ctx);
      expect(result).toEqual<Stage1Result>({
        outcome: 'pass',
        reason: 'obviously_safe',
      });
    });

    it('「www」も pass', () => {
      const ctx = buildContext();
      const result = runStage1(buildMessage('www'), ctx);
      expect(result.outcome).toBe('pass');
      expect(result.outcome === 'pass' ? result.reason : null).toBe('obviously_safe');
    });

    it('絵文字1文字（length<=2）も pass', () => {
      const ctx = buildContext();
      const result = runStage1(buildMessage('🎉'), ctx);
      expect(result.outcome).toBe('pass');
    });

    it('カスタムNGワードがあっても obviously_safe なら pass — ただしマッチ優先', () => {
      // custom_blocklist は obviously_safe より先に評価される。
      // よって NGワードに「草」を入れた場合は filter が優先される。
      const ctxWithNG = buildContext({ settings: { customBlockWords: ['草'] } });
      const result = runStage1(buildMessage('草'), ctxWithNG);
      expect(result.outcome).toBe('filter');
    });
  });

  describe('outcome: gray (needs_stage2)', () => {
    it('NGワードなし・KBマッチなし・obviously_safe でもない場合は gray', () => {
      const ctx = buildContext();
      const result = runStage1(buildMessage('今日の配信楽しかったです、また見にきます'), ctx);
      expect(result).toEqual<Stage1Result>({
        outcome: 'gray',
        reason: 'needs_stage2',
      });
    });

    it('gameContext なしでもネタバレ風の3文字以上は gray（KBチェックがスキップされ、obviously_safe にも該当しない）', () => {
      const ctx = buildContext();
      const result = runStage1(buildMessage('犯人だった'), ctx);
      expect(result.outcome).toBe('gray');
    });

    it('カテゴリ無効（spoiler.enabled=false）の場合、KB マッチをスキップして gray に倒す', () => {
      const ctx = buildContext({
        game: {
          gameId: 'ace-attorney-1',
          progressType: 'chapter',
          currentChapter: 'ch1',
        },
        settings: {
          categories: { spoiler: { enabled: false, strength: 'standard' } },
        },
      });
      // 通常なら keyword_match で filter される入力だが、enabled=false で gray 行き
      const result = runStage1(buildMessage('高日が死んだのか'), ctx);
      expect(result.outcome).toBe('gray');
    });
  });
});
