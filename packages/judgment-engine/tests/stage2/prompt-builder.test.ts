/**
 * Stage 2 マルチラベルプロンプトビルダーのテスト（Phase 3 / v0.4.0）。
 *
 * 検証観点:
 * - Block 1 / Block 2 の独立とキャッシュ制御
 * - 6 ラベルすべての定義が Block 1 に存在
 * - LABEL_PRECEDENCE と Block 1 のプロンプト本文が drift しない
 * - 出力形式（labels / primary / confidence / reason_ja）が指示されている
 * - Block 2 にユーザーの各カテゴリ設定（ON/OFF + strength）が反映される
 * - spam だけ strength なし
 * - ゲームコンテキストが Block 2 に含まれる（既存挙動の保護）
 * - 既存 v0.3.1 PROG-01「視聴中（未通過）」文言の保護
 */

import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildUserPrompt,
} from '../../src/stage2/prompt-builder.js';
import { LABEL_PRECEDENCE } from '../../src/stage2/label-precedence.js';
import type { JudgmentContext, Message } from '../../src/types.js';
import type { FilterSettings, GameContext } from '@fresh-chat-keeper/shared';

const BASE_SETTINGS: FilterSettings = {
  version: 3,
  enabled: true,
  displayMode: 'placeholder',
  filterMode: 'archive',
  categories: {
    spoiler: { enabled: true, strength: 'standard' },
    harassment: { enabled: false, strength: 'standard' },
    spam: { enabled: false },
    offTopic: { enabled: false, strength: 'standard' },
    backseat: { enabled: false, strength: 'standard' },
  },
  userBlocks: { channelIds: [], metadata: {} },
  customBlockWords: [],
  userTier: 'free',
};

function buildContext(args?: {
  game?: Partial<GameContext>;
  settings?: Partial<FilterSettings>;
}): JudgmentContext {
  return {
    settings: { ...BASE_SETTINGS, ...args?.settings },
    game: args?.game ? { progressType: 'none', ...args.game } : undefined,
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

// ─── ブロック構造 ──────────────────────────────────────────────────
describe('buildSystemPrompt: block structure', () => {
  it('Block 1（固定指示）と Block 2（動的コンテキスト）が独立ブロックになる', () => {
    const ctx = buildContext({
      game: { gameId: 'ace-attorney-1', progressType: 'chapter', currentChapter: 'ch3' },
    });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain('ラベル定義');
    expect(blocks[1].text).toContain('ゲーム: ace-attorney-1');
  });

  it('supportsCaching: true で各ブロックに cache_control: ephemeral が付与される', () => {
    const ctx = buildContext({ game: { gameId: 'g', progressType: 'none' } });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    for (const block of blocks) {
      expect(block.cache_control).toEqual({ type: 'ephemeral' });
    }
  });

  it('supportsCaching: false では cache_control が付与されない', () => {
    const ctx = buildContext({ game: { gameId: 'g', progressType: 'none' } });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: false });
    for (const block of blocks) {
      expect(block.cache_control).toBeUndefined();
    }
  });

  it('game コンテキストなし + デフォルト設定でも、設定セクションがあるので Block 2 を出力', () => {
    const ctx = buildContext();
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    // 設定セクションは常時出力（カテゴリ ON/OFF を LLM に伝えるため）
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toContain('視聴者のフィルタ設定');
  });
});

// ─── Block 1: 固定指示 ────────────────────────────────────────────
describe('buildSystemPrompt: Block 1 (static instructions)', () => {
  function getBlock1(): string {
    return buildSystemPrompt(buildContext(), { supportsCaching: true })[0].text;
  }

  it('6 ラベルすべての定義が含まれる', () => {
    const text = getBlock1();
    expect(text).toMatch(/##\s*safe/);
    expect(text).toMatch(/##\s*spoiler/);
    expect(text).toMatch(/##\s*harassment/);
    expect(text).toMatch(/##\s*spam/);
    expect(text).toMatch(/##\s*off_topic/);
    expect(text).toMatch(/##\s*backseat/);
  });

  it('LABEL_PRECEDENCE が Block 1 のプロンプト本文と drift しない', () => {
    const text = getBlock1();
    // 「harassment > spoiler > backseat > spam > off_topic > safe」のような順序記述があるはず
    const precedenceStr = LABEL_PRECEDENCE.join(' > ');
    expect(text).toContain(precedenceStr);
  });

  it('マルチラベル出力形式（labels / primary / confidence / reason_ja）が指示されている', () => {
    const text = getBlock1();
    expect(text).toContain('"labels"');
    expect(text).toContain('"primary"');
    expect(text).toContain('"confidence"');
    expect(text).toContain('"reason_ja"');
    expect(text).toContain('messageId');
  });

  it('JSON 配列のみで返すよう指示している（フェンスや前後説明を禁止）', () => {
    const text = getBlock1();
    expect(text).toContain('JSON 配列のみ');
  });

  it('spoiler の3段階強度（strict/standard/loose）が記述されている', () => {
    const text = getBlock1();
    // spoiler セクション内で strict / standard / loose の使い分けが言及されているはず
    expect(text).toContain('明示的ネタバレ');
    expect(text).toContain('攻略ヒント');
    expect(text).toContain('匂わせ');
  });

  it('harassment / off_topic / backseat の3段階強度が記述されている', () => {
    const text = getBlock1();
    // 各カテゴリで strict / standard / loose の使い分けが説明されているはず
    expect(text).toMatch(/harassment[\s\S]*?strict[\s\S]*?standard[\s\S]*?loose/);
    expect(text).toMatch(/off_topic[\s\S]*?strict[\s\S]*?standard[\s\S]*?loose/);
    expect(text).toMatch(/backseat[\s\S]*?strict[\s\S]*?standard[\s\S]*?loose/);
  });

  it('spam は強度なし（enabled / disabled の二択）と説明されている', () => {
    const text = getBlock1();
    // spam セクションには「強度設定がない」旨が記述されている
    expect(text).toMatch(/spam[\s\S]{0,200}強度/);
  });

  it('「OFF のカテゴリは judge しない」旨が記述されている', () => {
    const text = getBlock1();
    expect(text).toMatch(/OFF[\s\S]{0,80}カテゴリ/);
  });

  it('VTuber 文化への配慮が記述されている（推し発言・身内ネタを safe）', () => {
    const text = getBlock1();
    expect(text).toContain('VTuber');
  });

  it('Block 1 は context に依らず常に同じ文字列（プロンプトキャッシュ前提）', () => {
    const ctx1 = buildContext({ game: { gameId: 'a' } });
    const ctx2 = buildContext({ game: { gameId: 'b', progressType: 'chapter', currentChapter: 'ch5' } });
    const b1 = buildSystemPrompt(ctx1, { supportsCaching: true })[0].text;
    const b2 = buildSystemPrompt(ctx2, { supportsCaching: true })[0].text;
    expect(b1).toBe(b2);
  });
});

// ─── Block 2: 動的コンテキスト ───────────────────────────────────
describe('buildSystemPrompt: Block 2 (dynamic context)', () => {
  function getBlock2(ctx: JudgmentContext): string {
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    return blocks[1]?.text ?? '';
  }

  describe('設定セクション', () => {
    it('5 カテゴリすべての ON/OFF と strength が含まれる', () => {
      const ctx = buildContext({
        settings: {
          categories: {
            spoiler: { enabled: true, strength: 'strict' },
            harassment: { enabled: true, strength: 'loose' },
            spam: { enabled: true },
            offTopic: { enabled: false, strength: 'standard' },
            backseat: { enabled: false, strength: 'standard' },
          },
        },
      });
      const text = getBlock2(ctx);
      expect(text).toContain('視聴者のフィルタ設定');
      expect(text).toMatch(/spoiler:.*ON.*strict/);
      expect(text).toMatch(/harassment:.*ON.*loose/);
      expect(text).toMatch(/spam:.*ON/);
      expect(text).toMatch(/off_topic:.*OFF/);
      expect(text).toMatch(/backseat:.*OFF/);
    });

    it('spam 行には strength が出力されない', () => {
      const ctx = buildContext({
        settings: {
          categories: {
            spoiler: { enabled: true, strength: 'standard' },
            spam: { enabled: true },
          },
        },
      });
      const text = getBlock2(ctx);
      // spam 行を抽出
      const spamLine = text.split('\n').find((l) => /^-\s*spam:/.test(l)) ?? '';
      expect(spamLine).not.toContain('強度');
    });

    it('harassment が未設定でも OFF として安全に出力される', () => {
      const ctx = buildContext({
        settings: {
          categories: {
            spoiler: { enabled: true, strength: 'standard' },
            // harassment 未定義
          },
        },
      });
      const text = getBlock2(ctx);
      expect(text).toMatch(/harassment:.*OFF/);
    });
  });

  describe('ゲームコンテキスト', () => {
    it('gameId のみ → ゲーム名と進行状況', () => {
      const ctx = buildContext({
        game: { gameId: 'ace-attorney-1', progressType: 'chapter', currentChapter: 'ch3' },
      });
      const text = getBlock2(ctx);
      expect(text).toContain('ゲーム: ace-attorney-1');
      expect(text).toContain('現在チャプター「ch3」を視聴中（未通過）');
    });

    it('ジャンルテンプレートのみ → ジャンル名で記述', () => {
      const ctx = buildContext({ game: { progressType: 'none', genreTemplate: 'rpg' } });
      const text = getBlock2(ctx);
      expect(text).toContain('RPG');
      expect(text).toContain('具体的なゲームタイトルや進行状況は不明');
    });

    it('gameId + ジャンルテンプレート併用 → 両方記述', () => {
      const ctx = buildContext({
        game: {
          gameId: 'ace-attorney-1',
          progressType: 'chapter',
          currentChapter: 'ch3',
          genreTemplate: 'mystery',
        },
      });
      const text = getBlock2(ctx);
      expect(text).toContain('ゲーム: ace-attorney-1');
      expect(text).toContain('推理・ミステリー');
      expect(text).toContain('チャプター「ch3」');
    });

    it('gameTitle（動画タイトル）が指定されたらプロンプトに含まれる', () => {
      const ctx = buildContext({
        game: { gameId: 'g', progressType: 'none', gameTitle: '【初見】逆転裁判 実況プレイ #1' },
      });
      const text = getBlock2(ctx);
      expect(text).toContain('動画タイトル: 【初見】逆転裁判');
      expect(text).toContain('ネタバレあり');
    });

    it('event ベース進行状況も正しく整形', () => {
      const ctx = buildContext({
        game: { gameId: 'g', progressType: 'event', completedEvents: ['e1', 'e3'] },
      });
      const text = getBlock2(ctx);
      expect(text).toContain('通過済みイベント: e1, e3');
    });

    describe('v0.3.1 PROG-01: 視聴中セマンティクスの文言', () => {
      it('chapter モードでは「視聴中（未通過）」と表現される', () => {
        const ctx = buildContext({
          game: { gameId: 'g', progressType: 'chapter', currentChapter: 'ch3' },
        });
        const text = getBlock2(ctx);
        expect(text).toContain('現在チャプター「ch3」を視聴中（未通過）');
        expect(text).not.toContain('まで通過済み');
      });
    });
  });
});

// ─── Block 3: 字幕連動（Phase 5 / P5-B4c）────────────────────────
describe('buildSystemPrompt: Block 3 (audio context)', () => {
  it('recentAudio なし（既定）では Block3 を出力しない（後方互換: 2 ブロックのまま）', () => {
    const ctx = buildContext({ game: { gameId: 'g', progressType: 'none' } });
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(2);
    // 字幕セクションの見出しがどのブロックにも出ない
    for (const b of blocks) {
      expect(b.text).not.toContain('配信者の直近の発言');
    }
  });

  it('recentAudio あり → Block3 が追加され、発話テキストを含む', () => {
    const ctx: JudgmentContext = {
      ...buildContext({ game: { gameId: 'g', progressType: 'none' } }),
      recentAudio: { text: 'このボス強いな、次の部屋行こう', qualityScore: 0.8 },
    };
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(3);
    expect(blocks[2].text).toContain('配信者の直近の発言');
    expect(blocks[2].text).toContain('このボス強いな、次の部屋行こう');
  });

  it('Block3 には cache_control を付けない（supportsCaching: true でも）', () => {
    const ctx: JudgmentContext = {
      ...buildContext({ game: { gameId: 'g', progressType: 'none' } }),
      recentAudio: { text: '十分に長い配信者の直近発話テキスト', qualityScore: 0.7 },
    };
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    // Block1 / Block2 はキャッシュ境界、Block3 は動的なので境界外
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[2].cache_control).toBeUndefined();
  });

  it('streamSummary.whole あり → 累積文脈セクションが出る（P7-B5）', () => {
    const ctx: JudgmentContext = {
      ...buildContext({ game: { gameId: 'g', progressType: 'none' } }),
      streamSummary: { whole: 'これまでに第1章をクリアした' },
    };
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(3);
    expect(blocks[2].text).toContain('配信の累積文脈');
    expect(blocks[2].text).toContain('これまでに第1章をクリアした');
  });

  it('streamSummary.recent あり → 近況セクションが出る（P7-B5）', () => {
    const ctx: JudgmentContext = {
      ...buildContext({ game: { gameId: 'g', progressType: 'none' } }),
      streamSummary: { recent: '今は中ボスと戦っている' },
    };
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(3);
    expect(blocks[2].text).toContain('配信の近況');
    expect(blocks[2].text).toContain('今は中ボスと戦っている');
  });

  it('whole→recent→verbatim の順で 1 つの Block3 に全セクション（doc §3 の順序）', () => {
    const ctx: JudgmentContext = {
      ...buildContext({ game: { gameId: 'g', progressType: 'none' } }),
      recentAudio: { text: '直近の発言テキスト', qualityScore: 0.6 },
      streamSummary: { whole: '累積要約テキスト', recent: '近傍要約テキスト' },
    };
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(3);
    const text = blocks[2].text;
    expect(text).toContain('累積要約テキスト');
    expect(text).toContain('近傍要約テキスト');
    expect(text).toContain('直近の発言テキスト');
    // L2(whole) → L1(recent) → L0(verbatim) の順
    expect(text.indexOf('累積要約テキスト')).toBeLessThan(text.indexOf('近傍要約テキスト'));
    expect(text.indexOf('近傍要約テキスト')).toBeLessThan(text.indexOf('直近の発言テキスト'));
  });

  it('streamSummary が空オブジェクト {} で recentAudio もなければ Block3 を出力しない', () => {
    const ctx: JudgmentContext = {
      ...buildContext({ game: { gameId: 'g', progressType: 'none' } }),
      streamSummary: {},
    };
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(2);
  });

  it('recentAudio.text が空白のみなら Block3 を出力しない', () => {
    const ctx: JudgmentContext = {
      ...buildContext({ game: { gameId: 'g', progressType: 'none' } }),
      recentAudio: { text: '   ', qualityScore: 0.5 },
    };
    const blocks = buildSystemPrompt(ctx, { supportsCaching: true });
    expect(blocks).toHaveLength(2);
  });
});

// ─── buildUserPrompt ─────────────────────────────────────────────
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
    expect(result.split('\n').filter((l) => l.includes('mn')).length).toBe(1);
  });

  it('PromptMessage 型（id+text）を直接渡してもよい（バッチャーからの呼び出し）', () => {
    const result = buildUserPrompt([
      { id: 'a', text: 'hello' },
      { id: 'b', text: 'world' },
    ]);
    expect(result).toContain('a');
    expect(result).toContain('hello');
    expect(result).toContain('b');
    expect(result).toContain('world');
  });
});
