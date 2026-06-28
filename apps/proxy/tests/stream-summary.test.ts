/**
 * P7-B5: enrichWithStreamSummary（proxy → apps/api Service Binding）のテスト。
 *
 * Service Binding（env.API）をモックし、DO 由来 summary の反映と
 * フォールバック・失敗時継続を検証する。実通信なし。
 *
 * 検証 3 系統:
 * (a) DO 要約あり → streamSummary{whole,recent} + recentAudio(verbatim) に反映
 * (b) DO 空 → request 同梱 recentAudio を温存（フォールバック）
 * (c) DO 取得失敗（throw / 非2xx）→ warn して判定継続（既存 context 維持）
 */

import { describe, it, expect, vi } from 'vitest';
import { __test__ } from '../src/index.js';
import type { JudgmentContext } from '@fresh-chat-keeper/judgment-engine';

const { enrichWithStreamSummary } = __test__;

// NormalizedRequest 形（テストに必要な最小）。
function makeNormalized(opts: {
  videoId?: string;
  recentAudio?: { text: string; qualityScore: number };
}): { context: JudgmentContext; videoId?: string; messages: unknown[]; tier: string } {
  const context: JudgmentContext = {
    settings: {
      version: 3,
      enabled: true,
      displayMode: 'placeholder',
      filterMode: 'archive',
      categories: { spoiler: { enabled: true, strength: 'standard' } },
      customBlockWords: [],
      userTier: 'free',
    } as JudgmentContext['settings'],
    ...(opts.recentAudio ? { recentAudio: opts.recentAudio } : {}),
  };
  return {
    messages: [],
    tier: 'free',
    context,
    ...(opts.videoId ? { videoId: opts.videoId } : {}),
  };
}

/** env.API（Fetcher）モック: 指定 JSON / status / throw を返す。 */
function mockEnv(behavior: { json?: unknown; status?: number; throws?: boolean } | null) {
  if (behavior === null) return { ANTHROPIC_API_KEY: 'k', JUDGE_RATE_LIMITER: {} } as never;
  const fetchFn = vi.fn(async () => {
    if (behavior.throws) throw new Error('binding down');
    return new Response(JSON.stringify(behavior.json ?? {}), {
      status: behavior.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return {
    ANTHROPIC_API_KEY: 'k',
    JUDGE_RATE_LIMITER: {},
    API: { fetch: fetchFn },
  } as never;
}

describe('enrichWithStreamSummary (P7-B5)', () => {
  it('(a) DO 要約あり → whole/recent/verbatim を context に反映', async () => {
    const normalized = makeNormalized({ videoId: 'vid1' });
    const env = mockEnv({ json: { whole: 'L2全体', recent: 'L1近傍', verbatim: 'L0逐語' } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await enrichWithStreamSummary(normalized as any, env);

    expect(normalized.context.streamSummary).toEqual({ whole: 'L2全体', recent: 'L1近傍' });
    expect(normalized.context.recentAudio).toEqual({ text: 'L0逐語', qualityScore: 1 });
  });

  it('(a2) DO verbatim は request 同梱 recentAudio を上書き（DO 優先）', async () => {
    const normalized = makeNormalized({
      videoId: 'vid1',
      recentAudio: { text: 'request字幕', qualityScore: 0.4 },
    });
    const env = mockEnv({ json: { verbatim: 'DO文字起こし' } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await enrichWithStreamSummary(normalized as any, env);

    expect(normalized.context.recentAudio).toEqual({ text: 'DO文字起こし', qualityScore: 1 });
  });

  it('(b) DO 空 → request 同梱 recentAudio を温存（フォールバック）', async () => {
    const normalized = makeNormalized({
      videoId: 'vid1',
      recentAudio: { text: 'request字幕', qualityScore: 0.4 },
    });
    const env = mockEnv({ json: {} }); // DO 空サマリ

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await enrichWithStreamSummary(normalized as any, env);

    expect(normalized.context.streamSummary).toBeUndefined();
    expect(normalized.context.recentAudio).toEqual({ text: 'request字幕', qualityScore: 0.4 });
  });

  it('(c) DO 取得失敗（throw）→ warn して既存 context を維持', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const normalized = makeNormalized({
      videoId: 'vid1',
      recentAudio: { text: 'request字幕', qualityScore: 0.4 },
    });
    const env = mockEnv({ throws: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(enrichWithStreamSummary(normalized as any, env)).resolves.toBeUndefined();
    expect(normalized.context.recentAudio).toEqual({ text: 'request字幕', qualityScore: 0.4 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('(c2) DO 非2xx → warn して既存維持', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const normalized = makeNormalized({ videoId: 'vid1' });
    const env = mockEnv({ status: 502 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await enrichWithStreamSummary(normalized as any, env);
    expect(normalized.context.streamSummary).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('videoId なし → Service Binding を呼ばない', async () => {
    const normalized = makeNormalized({}); // videoId なし
    const env = mockEnv({ json: { whole: 'x' } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await enrichWithStreamSummary(normalized as any, env);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((env as any).API.fetch).not.toHaveBeenCalled();
    expect(normalized.context.streamSummary).toBeUndefined();
  });

  it('env.API binding なし → 何もしない（フォールバック）', async () => {
    const normalized = makeNormalized({
      videoId: 'vid1',
      recentAudio: { text: 'request字幕', qualityScore: 0.4 },
    });
    const env = mockEnv(null); // API binding なし

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await enrichWithStreamSummary(normalized as any, env);
    expect(normalized.context.recentAudio).toEqual({ text: 'request字幕', qualityScore: 0.4 });
  });
});
