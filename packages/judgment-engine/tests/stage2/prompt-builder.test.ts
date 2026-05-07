import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildUserPrompt,
} from '../../src/stage2/prompt-builder.js';
import type { JudgmentContext, Message } from '../../src/types.js';
import type { FilterSettings, GameContext } from '@fresh-chat-keeper/shared';

const SETTINGS: FilterSettings = {
  version: 2,
  enabled: true,
  displayMode: 'placeholder',
  filterMode: 'archive',
  categories: { spoiler: { enabled: true, strength: 'standard' } },
  customBlockWords: [],
  userTier: 'free',
};

function buildContext(game?: Partial<GameContext>): JudgmentContext {
  return {
    settings: SETTINGS,
    game: game
      ? { progressType: 'none', ...game }
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

describe('buildSystemPrompt', () => {
  it('Block 1（固定指示）と Block 2（コンテキスト）が独立ブロックになる', () => {
    const ctx = buildContext({ gameId: 'ace-attorney-1', progressType: 'chapter', currentChapter: 'ch3' });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain('判定基準');
    expect(blocks[1].text).toContain('ゲーム: ace-attorney-1');
  });

  it('supportsCaching: true の場合、各ブロックに cache_control: ephemeral が付与される', () => {
    const ctx = buildContext({ gameId: 'g', progressType: 'none' });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    for (const block of blocks) {
      expect(block.cache_control).toEqual({ type: 'ephemeral' });
    }
  });

  it('supportsCaching: false の場合、cache_control は付与されない', () => {
    const ctx = buildContext({ gameId: 'g', progressType: 'none' });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: false });
    for (const block of blocks) {
      expect(block.cache_control).toBeUndefined();
    }
  });

  it('Block 1（固定指示）にラベル4種すべてが含まれる', () => {
    const ctx = buildContext();
    const [block1] = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(block1.text).toContain('direct_spoiler');
    expect(block1.text).toContain('foreshadowing_hint');
    expect(block1.text).toContain('gameplay_hint');
    expect(block1.text).toContain('safe');
  });

  it('Block 1 に出力形式（JSON配列・messageId・confidence・reason）が含まれる', () => {
    const ctx = buildContext();
    const [block1] = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(block1.text).toContain('JSON配列');
    expect(block1.text).toContain('messageId');
    expect(block1.text).toContain('confidence');
    expect(block1.text).toContain('reason');
  });

  it('game コンテキストが無い場合は Block 2 を出力しない（Block 1 のみ）', () => {
    const ctx = buildContext();
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('判定基準');
  });

  it('ジャンルテンプレートのみ（gameId なし） → ジャンル名で記述', () => {
    const ctx = buildContext({ progressType: 'none', genreTemplate: 'rpg' });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toContain('RPG');
    expect(blocks[1].text).toContain('具体的なゲームタイトルや進行状況は不明');
  });

  it('gameId のみ（ジャンルなし） → ゲーム名と進行状況を記述', () => {
    const ctx = buildContext({
      gameId: 'ace-attorney-1',
      progressType: 'chapter',
      currentChapter: 'ch3',
    });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toContain('ゲーム: ace-attorney-1');
    // v0.3.1 PROG-01: 「視聴中（未通過）」の文言に変更
    expect(blocks[1].text).toContain('現在チャプター「ch3」を視聴中（未通過）');
  });

  it('gameId + ジャンルテンプレート併用 → 両方記述', () => {
    const ctx = buildContext({
      gameId: 'ace-attorney-1',
      progressType: 'chapter',
      currentChapter: 'ch3',
      genreTemplate: 'mystery',
    });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks[1].text).toContain('ゲーム: ace-attorney-1');
    expect(blocks[1].text).toContain('推理・ミステリー');
    expect(blocks[1].text).toContain('チャプター「ch3」');
  });

  it('gameTitle（動画タイトル）が指定されたらプロンプトに含まれる', () => {
    const ctx = buildContext({
      gameId: 'g',
      progressType: 'none',
      gameTitle: '【初見】逆転裁判 実況プレイ #1',
    });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks[1].text).toContain('動画タイトル: 【初見】逆転裁判');
    expect(blocks[1].text).toContain('ネタバレあり'); // 注意書きが含まれる
  });

  it('event ベース進行状況も正しく整形', () => {
    const ctx = buildContext({
      gameId: 'g',
      progressType: 'event',
      completedEvents: ['e1', 'e3'],
    });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks[1].text).toContain('通過済みイベント: e1, e3');
  });

  describe('v0.3.1 PROG-01: 視聴中セマンティクスの文言', () => {
    it('chapter モードでは「視聴中（未通過）」と表現される（旧「まで通過済み」ではない）', () => {
      const ctx = buildContext({
        gameId: 'g',
        progressType: 'chapter',
        currentChapter: 'ch3',
      });
      const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
      const text = blocks[1].text;
      expect(text).toContain('現在チャプター「ch3」を視聴中（未通過）');
      // 旧文言が混入していないこと
      expect(text).not.toContain('まで通過済み');
    });

    it('event モードの文言は変更されない（completedEventIds は通過済みの意味で正しい）', () => {
      const ctx = buildContext({
        gameId: 'g',
        progressType: 'event',
        completedEvents: ['e1', 'e2'],
      });
      const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
      // event モードはユーザーが「通過したイベント」を明示的にチェックする UI のため
      // 「通過済み」表現が正しい
      expect(blocks[1].text).toContain('通過済みイベント:');
    });
  });
});

describe('buildUserPrompt', () => {
  it('単一メッセージを正しく整形', () => {
    const result = buildUserPrompt([buildMessage('ラスボスは○○', 'm1')]);
    expect(result).toContain('m1');
    expect(result).toContain('ラスボスは○○');
  });

  it('複数メッセージをすべて含む', () => {
    const result = buildUserPrompt([
      buildMessage('草', 'm1'),
      buildMessage('裏切り者だよ', 'm2'),
      buildMessage('応援してます！', 'm3'),
    ]);
    expect(result).toContain('m1');
    expect(result).toContain('m2');
    expect(result).toContain('m3');
    expect(result).toContain('裏切り者');
  });

  it('空配列なら空文字を返す', () => {
    expect(buildUserPrompt([])).toBe('');
  });

  it('改行を含むテキストはサニタイズされる', () => {
    const result = buildUserPrompt([buildMessage('line1\nline2', 'mn')]);
    // JSON.stringify 経由で escape される or 改行を空白置換
    expect(result.split('\n').filter((l) => l.includes('mn')).length).toBe(1);
  });
});
