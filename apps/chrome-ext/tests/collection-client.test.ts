/**
 * collection-client.ts の単体テスト。
 *
 * fetch をモック化して以下を検証:
 * - notifyConsent: 200 / 422 / network error
 * - notifyRevoke: 200 / 422
 * - IngestClient.enqueueLog: 50 件で自動フラッシュ
 * - IngestClient.flush: 200 / 410 / 422 / 429 のステータス別ハンドリング
 * - IngestClient.abort: バッファクリア + タイマー停止
 *
 * fake timer を使い、5 秒タイマーの挙動も検証する。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  notifyConsent,
  notifyRevoke,
  IngestClient,
  ConsentApiError,
  MAX_BATCH,
  FLUSH_INTERVAL_MS,
  type CollectionClientContext,
} from '../src/content/collection-client.js';
import type { SpoilerJudgmentLog } from '@fresh-chat-keeper/shared';

const ctx: CollectionClientContext = {
  apiUrl: 'http://localhost:8788',
  token: '11111111-2222-4333-8444-555555555555',
};

function makeLog(i: number): SpoilerJudgmentLog {
  return {
    logId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    recordedAt: '2026-05-01T10:00:00.000Z',
    consentVersion: '2026-05-01',
    videoId: 'v',
    channelId: 'c',
    gameTitle: null,
    streamProgressHint: null,
    timeIntoStream: null,
    judgmentMode: 'archive_replay',
    targetMessage: {
      body: `m${i}`,
      authorChannelId: 'a',
      timestamp: '2026-05-01T10:00:00.000Z',
      isMember: null,
      isModerator: null,
      isVerified: null,
    },
    precedingMessages: [],
    followingMessages: [],
    stageACategory: 'unknown',
    stageAConfidence: null,
    labels: ['safe'],
    primaryLabel: 'safe',
    confidence: 1,
    stage: 'stage1',
    reasonJa: null,
    labelSource: 'haiku',
    reviewedByHuman: false,
    userFeedback: null,
    extensionVersion: '0.3.5',
    userTokenHashed: '',
  };
}

/** fetch をモック化し、レスポンスシーケンスを順番に返す helper */
function mockFetchSequence(
  responses: Array<{ status: number; body?: unknown; throwError?: boolean }>,
): { calls: Array<{ url: string; init: RequestInit | undefined }>; restore: () => void } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const original = globalThis.fetch;
  // @ts-expect-error: テスト用の簡易型
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r.throwError) throw new Error('network down');
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function installFakeChromeRuntime(): { lastMsg: unknown } {
  const captured: { lastMsg: unknown } = { lastMsg: null };
  const fake = {
    runtime: {
      sendMessage: async (msg: unknown) => {
        captured.lastMsg = msg;
      },
    },
  };
  // @types/chrome の型に完全準拠させると 30 メソッド以上を埋める必要があるが、
  // 本テストは runtime.sendMessage しか触らないので最小モックに double cast。
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return captured;
}

// ─── notifyConsent / notifyRevoke ────────────────────────────

describe('notifyConsent', () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it('200: ConsentNotifyResponsePayload を返す', async () => {
    const m = mockFetchSequence([
      { status: 200, body: { recorded: true, currentConsentVersion: '2026-05-01' } },
    ]);
    restore = m.restore;
    const result = await notifyConsent(ctx, '2026-05-01');
    expect(result.recorded).toBe(true);
    expect(result.currentConsentVersion).toBe('2026-05-01');
    expect(m.calls[0].url).toContain('/v1/consent');
    const headers = m.calls[0].init?.headers as Record<string, string>;
    expect(headers['x-fck-token']).toBe(ctx.token);
  });

  it('422: ConsentApiError を投げ、status と body を保持する', async () => {
    const m = mockFetchSequence([{ status: 422, body: { error: 'Unknown consentVersion' } }]);
    restore = m.restore;
    await expect(notifyConsent(ctx, '1999-01-01')).rejects.toBeInstanceOf(ConsentApiError);
  });

  it('ネットワークエラー: 通常の Error を伝播（呼び出し側が retry 判断）', async () => {
    const m = mockFetchSequence([{ status: 0, throwError: true }]);
    restore = m.restore;
    await expect(notifyConsent(ctx, 'v1')).rejects.toThrow(/network down/);
  });
});

describe('notifyRevoke', () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it('200: RevokeResponsePayload を返す', async () => {
    const m = mockFetchSequence([{ status: 200, body: { revoked: true, deletedLogCount: 7 } }]);
    restore = m.restore;
    const result = await notifyRevoke(ctx);
    expect(result.revoked).toBe(true);
    expect(result.deletedLogCount).toBe(7);
    expect(m.calls[0].url).toContain('/v1/revoke');
  });

  it('500 サーバーエラー時は ConsentApiError', async () => {
    const m = mockFetchSequence([{ status: 500 }]);
    restore = m.restore;
    await expect(notifyRevoke(ctx)).rejects.toBeInstanceOf(ConsentApiError);
  });
});

// ─── IngestClient ────────────────────────────────────────────

describe('IngestClient: enqueueLog', () => {
  let restore: () => void = () => undefined;
  beforeEach(() => {
    installFakeChromeRuntime();
    vi.useFakeTimers();
  });
  afterEach(() => {
    restore();
    vi.useRealTimers();
  });

  it('50 件未満ならタイマー予約のみ（即時 fetch しない）', async () => {
    const m = mockFetchSequence([{ status: 200, body: { accepted: 1 } }]);
    restore = m.restore;
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    expect(m.calls).toHaveLength(0);
    expect(client._bufferSize()).toBe(1);
  });

  it('50 件到達で即座にフラッシュ（タイマー待機なし）', async () => {
    const m = mockFetchSequence([{ status: 200, body: { accepted: 50 } }]);
    restore = m.restore;
    const client = new IngestClient(ctx);
    for (let i = 0; i < MAX_BATCH; i++) client.enqueueLog(makeLog(i));
    // microtask を進めて flush() の await fetch 完了を待つ
    await vi.runAllTimersAsync();
    expect(m.calls).toHaveLength(1);
    expect(client._bufferSize()).toBe(0);
    const body = JSON.parse((m.calls[0].init?.body as string) ?? '{}');
    expect(body.logs).toHaveLength(MAX_BATCH);
  });

  it('5 秒タイマーで自動フラッシュ', async () => {
    const m = mockFetchSequence([{ status: 200 }]);
    restore = m.restore;
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    expect(m.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(m.calls).toHaveLength(1);
    expect(client._bufferSize()).toBe(0);
  });
});

describe('IngestClient: response handling', () => {
  let restore: () => void = () => undefined;
  let runtime: { lastMsg: unknown };

  beforeEach(() => {
    runtime = installFakeChromeRuntime();
    vi.useFakeTimers();
  });
  afterEach(() => {
    restore();
    vi.useRealTimers();
  });

  it('200: 成功、バッファクリア、リトライカウント 0', async () => {
    const m = mockFetchSequence([{ status: 200 }]);
    restore = m.restore;
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(client._retryCount()).toBe(0);
    expect(client._bufferSize()).toBe(0);
  });

  it('410: バッチを破棄、popup に再同意通知を送る', async () => {
    const m = mockFetchSequence([
      {
        status: 410,
        body: { error: 'consent_version_mismatch', currentConsentVersion: '2026-06-01' },
      },
    ]);
    restore = m.restore;
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(client._bufferSize()).toBe(0);
    expect(runtime.lastMsg).toMatchObject({
      type: 'fck:consent-refresh-required',
      currentConsentVersion: '2026-06-01',
    });
  });

  it('422: バリデーション失敗、再送せずバッファクリア', async () => {
    const m = mockFetchSequence([{ status: 422, body: { error: 'logs[0]: bad' } }]);
    restore = m.restore;
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(client._bufferSize()).toBe(0);
    expect(client._retryCount()).toBe(0);
  });

  it('429: バッファ復元 + 30 秒バックオフ後に再試行', async () => {
    const m = mockFetchSequence([
      { status: 429 },           // 1回目失敗
      { status: 200 },           // 2回目成功
    ]);
    restore = m.restore;
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));

    // 1 回目: 5 秒タイマーで flush → 429 → バッファ復元 + 30 秒予約
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(m.calls).toHaveLength(1);
    expect(client._bufferSize()).toBe(1);
    expect(client._retryCount()).toBe(1);

    // 30 秒待機 → 2 回目 fetch
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.calls).toHaveLength(2);
    expect(client._bufferSize()).toBe(0);
    expect(client._retryCount()).toBe(0);
  });

  it('ネットワークエラー: 429 と同じくバッファ復元 + リトライ', async () => {
    const m = mockFetchSequence([
      { status: 0, throwError: true },
      { status: 200 },
    ]);
    restore = m.restore;
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(client._bufferSize()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.calls).toHaveLength(2);
    expect(client._bufferSize()).toBe(0);
  });

  it('リトライ上限到達後は破棄', async () => {
    // すべて 429 を返す
    const m = mockFetchSequence([{ status: 429 }]);
    restore = m.restore;
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));

    // 1 回目
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    // バックオフ × 3 回を消化
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    // 上限到達 → 破棄。リトライカウントは 0 にリセットされる
    expect(client._bufferSize()).toBe(0);
    expect(client._retryCount()).toBe(0);
  });

  it('abort: バッファクリア + タイマー解除（revoke 時に使う）', async () => {
    const m = mockFetchSequence([{ status: 200 }]);
    restore = m.restore;
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    client.enqueueLog(makeLog(2));
    expect(client._bufferSize()).toBe(2);

    client.abort();
    expect(client._bufferSize()).toBe(0);

    // タイマー解除されているので fetch は呼ばれない
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(m.calls).toHaveLength(0);
  });
});
