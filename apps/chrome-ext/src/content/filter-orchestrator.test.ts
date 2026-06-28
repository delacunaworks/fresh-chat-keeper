/**
 * Phase 5 P5-B4c: sendStage2Batch のペイロード構築テスト（recentAudio gating）。
 *
 * chrome-transport を mock して proxy へ送られる JudgeRequestPayload を捕捉し、
 * 字幕文脈（recentAudio）が **渡されたときだけ** context に乗ることを検証する。
 *
 * **後方互換の核心**: recentAudio 未指定（captionContext.enabled=false の大多数）では
 * payload.context に recentAudio が現れない = v0.5.0 と完全同一のペイロード。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JudgeRequestPayload } from '@fresh-chat-keeper/judgment-engine';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings.js';
import type { Stage2Candidate } from './chrome-cache.js';

// chrome-transport を mock し、送信ペイロードを捕捉する。
const captured: { payload?: JudgeRequestPayload } = {};
vi.mock('./chrome-transport.js', () => ({
  createChromeTransport: () => ({
    async sendJudgeRequest(payload: JudgeRequestPayload) {
      captured.payload = payload;
      return { results: [] }; // 空結果 = onResult 未呼び出し、戻り true
    },
  }),
}));

import { sendStage2Batch } from './filter-orchestrator.js';

function buildSettings(): Settings {
  // DEFAULT_SETTINGS をベースに本テストで効くフィールドだけ上書き（型の完全性を保つ）。
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    gameId: 'other',
    proxyUrl: 'https://example.test',
    selectedGenreTemplates: ['rpg'],
  };
}

function buildBatch(): Stage2Candidate[] {
  return [
    { text: '次のボスは炎属性', el: new WeakRef({} as Element), cacheKey: 'k0', matchedKeyword: 'ボス' },
  ];
}

describe('sendStage2Batch: recentAudio gating（P5-B4c）', () => {
  beforeEach(() => {
    captured.payload = undefined;
  });

  it('recentAudio 未指定 → context に recentAudio が乗らない（v0.5.0 後方互換）', async () => {
    await sendStage2Batch(buildBatch(), buildSettings(), 'tok', vi.fn(), '動画タイトル');
    expect(captured.payload).toBeDefined();
    expect(captured.payload!.context).toBeDefined();
    expect('recentAudio' in captured.payload!.context!).toBe(false);
  });

  it('recentAudio 指定 → context.recentAudio にそのまま乗る', async () => {
    const recentAudio = { text: 'このボス強い、次の部屋行こう', qualityScore: 0.8 };
    await sendStage2Batch(buildBatch(), buildSettings(), 'tok', vi.fn(), '動画タイトル', recentAudio);
    expect(captured.payload!.context!.recentAudio).toEqual(recentAudio);
  });
});

describe('sendStage2Batch: videoId 送信（P7-B5）', () => {
  beforeEach(() => {
    captured.payload = undefined;
  });

  it('videoId 未指定 → context に videoId が乗らない（後方互換）', async () => {
    await sendStage2Batch(buildBatch(), buildSettings(), 'tok', vi.fn(), '動画タイトル');
    expect('videoId' in captured.payload!.context!).toBe(false);
  });

  it('videoId 指定 → context.videoId にそのまま乗る', async () => {
    await sendStage2Batch(
      buildBatch(),
      buildSettings(),
      'tok',
      vi.fn(),
      '動画タイトル',
      undefined,
      'dQw4w9WgXcQ',
    );
    expect(captured.payload!.context!.videoId).toBe('dQw4w9WgXcQ');
  });

  it('videoId 空文字相当（undefined）は乗らない', async () => {
    await sendStage2Batch(
      buildBatch(),
      buildSettings(),
      'tok',
      vi.fn(),
      '動画タイトル',
      undefined,
      undefined,
    );
    expect('videoId' in captured.payload!.context!).toBe(false);
  });
});
