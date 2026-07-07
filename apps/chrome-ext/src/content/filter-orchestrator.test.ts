/**
 * sendStage2Batch のペイロード構築テスト。
 *
 * chrome-transport を mock して proxy へ送られる JudgeRequestPayload を捕捉し、
 * videoId / currentTimeSeconds（AR-3）が **渡されたときだけ** context に乗ることを検証する。
 *
 * **後方互換の核心**: currentTimeSeconds 未指定（audioContext.enabled=false の大多数）
 * では payload.context に currentTimeSeconds が現れない = v0.6.0 と完全同一のペイロード。
 * AR-3 で DOM 字幕 recentAudio の同梱は廃止したので、payload に recentAudio は乗らない。
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
      'dQw4w9WgXcQ',
    );
    expect(captured.payload!.context!.videoId).toBe('dQw4w9WgXcQ');
  });
});

describe('sendStage2Batch: currentTimeSeconds 送信（AR-3）', () => {
  beforeEach(() => {
    captured.payload = undefined;
  });

  it('currentTimeSeconds 未指定 → context に乗らない（v0.6.0 後方互換）', async () => {
    await sendStage2Batch(buildBatch(), buildSettings(), 'tok', vi.fn(), '動画タイトル', 'vid1');
    expect('currentTimeSeconds' in captured.payload!.context!).toBe(false);
    // AR-3 で DOM 字幕 recentAudio の同梱は廃止 → 常に乗らない。
    expect('recentAudio' in captured.payload!.context!).toBe(false);
  });

  it('currentTimeSeconds 指定 → context.currentTimeSeconds にそのまま乗る', async () => {
    await sendStage2Batch(buildBatch(), buildSettings(), 'tok', vi.fn(), '動画タイトル', 'vid1', 3600);
    expect(captured.payload!.context!.currentTimeSeconds).toBe(3600);
  });

  it('currentTimeSeconds=0（配信冒頭）も乗る', async () => {
    await sendStage2Batch(buildBatch(), buildSettings(), 'tok', vi.fn(), '動画タイトル', 'vid1', 0);
    expect(captured.payload!.context!.currentTimeSeconds).toBe(0);
  });
});
