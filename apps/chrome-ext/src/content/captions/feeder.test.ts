/**
 * P7-FEED: CaptionFeeder の単体テスト。
 *
 * provider.getRecentContext / send / getEnabled / getVideoId を全て注入して
 * 実 DOM・実通信なしで検証する。
 *
 * 観点:
 * - gating OFF → 収集も送信もしない
 * - 収集 → { text, t } 整形・1000 文字トリム・重複（直前同一）抑制・空/null skip
 * - flush → 200 件分割・videoId 不正は送らない（buffer 温存）
 * - 失敗（!ok / 非200 / throw）は握って drop（例外を投げない）
 * - start/stop でタイマー制御・stop で buffer クリア
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CaptionFeeder,
  type CaptionFeederDeps,
  MAX_SEGMENTS_PER_BATCH,
  MAX_SEGMENT_TEXT_LENGTH,
  COLLECT_INTERVAL_MS,
  FLUSH_INTERVAL_MS,
  CAPTION_FEEDER_ENABLED,
} from './feeder.js';
import type { RecentAudioContext } from '@fresh-chat-keeper/judgment-engine';
import type { BackgroundFetchResponse } from '@fresh-chat-keeper/shared';
import type { StreamCaptionSegment } from '../collection-client.js';

function rc(text: string, t = 10): RecentAudioContext {
  return { text, qualityScore: 0.9, source: 'caption', segmentCount: 1, currentTimeSeconds: t };
}

const OK: BackgroundFetchResponse = { ok: true, status: 200, json: { accepted: 1 } };

function makeFeeder(overrides: Partial<CaptionFeederDeps> = {}) {
  const getRecentContext = vi.fn(async (): Promise<RecentAudioContext | null> => rc('やあ'));
  const send = vi.fn(
    async (_videoId: string, _segments: StreamCaptionSegment[]): Promise<BackgroundFetchResponse> =>
      OK,
  );
  const deps: CaptionFeederDeps = {
    provider: { getRecentContext },
    getEnabled: () => true,
    getWindowSeconds: () => 90,
    getThreshold: () => 0.5,
    getVideoId: () => 'dQw4w9WgXcQ',
    send,
    ...overrides,
  };
  return { feeder: new CaptionFeeder(deps), getRecentContext, send, deps };
}

describe('CaptionFeeder — gating', () => {
  it('OFF なら collect しない（getRecentContext を呼ばない）', async () => {
    const { feeder, getRecentContext } = makeFeeder({ getEnabled: () => false });
    await feeder.collectOnce();
    expect(getRecentContext).not.toHaveBeenCalled();
    expect(feeder._bufferSize()).toBe(0);
  });

  it('OFF なら flush しない（send を呼ばない）', async () => {
    const { feeder, send } = makeFeeder({ getEnabled: () => false });
    await feeder.flushOnce();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('CaptionFeeder — collect', () => {
  it('{ text, t } に整形して buffer に積む', async () => {
    const { feeder, getRecentContext } = makeFeeder();
    getRecentContext.mockResolvedValueOnce(rc('配信を始めます', 42));
    await feeder.collectOnce();
    expect(feeder._bufferSize()).toBe(1);
  });

  it('null（品質不足）は skip', async () => {
    const { feeder, getRecentContext } = makeFeeder();
    getRecentContext.mockResolvedValueOnce(null);
    await feeder.collectOnce();
    expect(feeder._bufferSize()).toBe(0);
  });

  it('空文字は skip', async () => {
    const { feeder, getRecentContext } = makeFeeder();
    getRecentContext.mockResolvedValueOnce(rc('   '));
    await feeder.collectOnce();
    expect(feeder._bufferSize()).toBe(0);
  });

  it('直前と同一テキストは重複として skip', async () => {
    const { feeder, getRecentContext } = makeFeeder();
    getRecentContext.mockResolvedValue(rc('同じ発言', 5));
    await feeder.collectOnce();
    await feeder.collectOnce();
    expect(feeder._bufferSize()).toBe(1);
  });

  it('異なるテキストは積み増す', async () => {
    const { feeder, getRecentContext } = makeFeeder();
    getRecentContext.mockResolvedValueOnce(rc('A', 1));
    getRecentContext.mockResolvedValueOnce(rc('B', 2));
    await feeder.collectOnce();
    await feeder.collectOnce();
    expect(feeder._bufferSize()).toBe(2);
  });

  it('1000 文字超はトリムして積む', async () => {
    const { feeder, getRecentContext, send } = makeFeeder();
    getRecentContext.mockResolvedValueOnce(rc('あ'.repeat(MAX_SEGMENT_TEXT_LENGTH + 500), 3));
    await feeder.collectOnce();
    await feeder.flushOnce();
    const sent = send.mock.calls[0][1];
    expect(sent[0].text.length).toBe(MAX_SEGMENT_TEXT_LENGTH);
  });

  it('provider.getRecentContext が throw しても collectOnce は解決し skip', async () => {
    const { feeder, getRecentContext } = makeFeeder();
    getRecentContext.mockRejectedValueOnce(new Error('extension reloaded'));
    await expect(feeder.collectOnce()).resolves.toBeUndefined();
    expect(feeder._bufferSize()).toBe(0);
  });

  it('buffer が MAX_SEGMENTS_PER_BATCH に達したら早期 flush', async () => {
    const { feeder, getRecentContext, send } = makeFeeder();
    // 毎回異なるテキストを返して重複抑制を回避
    let n = 0;
    getRecentContext.mockImplementation(async () => rc(`seg-${n++}`, n));
    for (let i = 0; i < MAX_SEGMENTS_PER_BATCH; i++) {
      await feeder.collectOnce();
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(feeder._bufferSize()).toBe(0);
  });
});

describe('CaptionFeeder — flush', () => {
  it('蓄積を POST し buffer をクリアする', async () => {
    const { feeder, getRecentContext, send } = makeFeeder();
    getRecentContext.mockResolvedValueOnce(rc('ほのお', 10));
    await feeder.collectOnce();
    await feeder.flushOnce();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('dQw4w9WgXcQ');
    expect(send.mock.calls[0][1]).toEqual([{ text: 'ほのお', t: 10 }]);
    expect(feeder._bufferSize()).toBe(0);
  });

  it('buffer 空なら send しない', async () => {
    const { feeder, send } = makeFeeder();
    await feeder.flushOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('videoId 不正（空）なら送らず buffer を温存', async () => {
    const { feeder, getRecentContext, send } = makeFeeder({ getVideoId: () => '' });
    getRecentContext.mockResolvedValueOnce(rc('x', 1));
    await feeder.collectOnce();
    await feeder.flushOnce();
    expect(send).not.toHaveBeenCalled();
    expect(feeder._bufferSize()).toBe(1);
  });

  it('videoId 形式不正（スペース）なら送らない', async () => {
    const { feeder, getRecentContext, send } = makeFeeder({ getVideoId: () => 'bad id' });
    getRecentContext.mockResolvedValueOnce(rc('x', 1));
    await feeder.collectOnce();
    await feeder.flushOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('200 件超は複数バッチに分割して送る', async () => {
    const { feeder, getRecentContext, send } = makeFeeder();
    let n = 0;
    getRecentContext.mockImplementation(async () => rc(`seg-${n++}`, n));
    // 早期 flush を避けるため flush をモックせず、collect を 250 回（途中で 200 到達 → 1 回 flush）
    // ここでは flush 分割を直接見るため、collectOnce の早期 flush を考慮し合計回数で検証する。
    for (let i = 0; i < 250; i++) await feeder.collectOnce();
    await feeder.flushOnce();
    // 200 到達で 1 回 + 残り 50 を最後の flush で 1 回 = 計 2 回
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('send が !ok でも例外を投げず buffer は drop（best-effort）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(
      async (): Promise<BackgroundFetchResponse> => ({
        ok: false,
        kind: 'network',
        message: 'down',
      }),
    );
    const { feeder, getRecentContext } = makeFeeder({ send });
    getRecentContext.mockResolvedValueOnce(rc('x', 1));
    await feeder.collectOnce();
    await expect(feeder.flushOnce()).resolves.toBeUndefined();
    expect(feeder._bufferSize()).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('send が非200 でも warn して drop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(
      async (): Promise<BackgroundFetchResponse> => ({ ok: true, status: 429, json: null }),
    );
    const { feeder, getRecentContext } = makeFeeder({ send });
    getRecentContext.mockResolvedValueOnce(rc('x', 1));
    await feeder.collectOnce();
    await feeder.flushOnce();
    expect(feeder._bufferSize()).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('send が throw しても flushOnce は解決し drop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(async (): Promise<BackgroundFetchResponse> => {
      throw new Error('boom');
    });
    const { feeder, getRecentContext } = makeFeeder({ send });
    getRecentContext.mockResolvedValueOnce(rc('x', 1));
    await feeder.collectOnce();
    await expect(feeder.flushOnce()).resolves.toBeUndefined();
    expect(feeder._bufferSize()).toBe(0);
    warn.mockRestore();
  });
});

describe('CaptionFeeder — 凍結（AR-3 / P7-FEED freeze）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('CAPTION_FEEDER_ENABLED は false（凍結中）', () => {
    expect(CAPTION_FEEDER_ENABLED).toBe(false);
  });

  it('凍結中は start() が no-op でタイマーを張らない（collect/flush 非実行）', async () => {
    const { feeder, getRecentContext, send } = makeFeeder();
    let n = 0;
    getRecentContext.mockImplementation(async () => rc(`s-${n++}`, n));
    feeder.start();
    expect(feeder._isRunning()).toBe(false); // 起動しない

    // 周期を大きく進めても collect / flush は走らない。
    await vi.advanceTimersByTimeAsync(COLLECT_INTERVAL_MS + FLUSH_INTERVAL_MS);
    expect(getRecentContext).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    feeder.stop();
  });

  it('stop は凍結中でも安全（buffer クリア）', async () => {
    const { feeder, getRecentContext } = makeFeeder();
    getRecentContext.mockResolvedValue(rc('x', 1));
    // collect ロジック自体は凍結と無関係に呼べる（将来ライブ RT 用）。
    await feeder.collectOnce();
    expect(feeder._bufferSize()).toBe(1);
    feeder.stop();
    expect(feeder._isRunning()).toBe(false);
    expect(feeder._bufferSize()).toBe(0);
  });
});
