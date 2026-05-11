/**
 * collection-client.ts の単体テスト。
 *
 * **BACKGROUND-01 (2026-05) 以降**: fetch 直接呼び出しではなく、
 * `chrome.runtime.sendMessage` 経由で background に依頼するため、
 * モック対象は chrome.runtime.sendMessage（BackgroundFetchResponse を返す）。
 *
 * 検証内容:
 * - notifyConsent: 200 / 422 / network error
 * - notifyRevoke: 200 / 500
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
import type {
  SpoilerJudgmentLog,
  BackgroundFetchRequest,
  BackgroundFetchResponse,
} from '@fresh-chat-keeper/shared';

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

/**
 * chrome.runtime.sendMessage をモック化する helper。
 *
 * - `bg-fetch` メッセージ: `bgFetchResponses` の順番に従ってレスポンスを返す
 *   （末尾に到達したら最後のものを繰り返す）。`shouldThrow` フラグで例外も再現可。
 * - その他のメッセージ（例: `fck:consent-refresh-required`）: `lastMsg` に
 *   キャプチャして `undefined` を返す（no-op listener 想定）。
 */
interface FakeRuntimeState {
  /** bg-fetch でない最後のメッセージ（consent-refresh 等）をキャプチャ */
  lastNonBgFetchMsg: unknown;
  /** bgFetch 呼び出しのリクエスト履歴（順序保持） */
  bgFetchCalls: BackgroundFetchRequest[];
  /** bgFetch のレスポンスシーケンス（呼び出し順に消費） */
  bgFetchResponses: BackgroundFetchResponse[];
  /** sendMessage 自体を throw させたい場合、true をセット */
  sendMessageShouldThrow: boolean;
}

function installFakeChromeRuntime(): FakeRuntimeState {
  const state: FakeRuntimeState = {
    lastNonBgFetchMsg: null,
    bgFetchCalls: [],
    bgFetchResponses: [],
    sendMessageShouldThrow: false,
  };
  let i = 0;
  const fake = {
    runtime: {
      sendMessage: async (msg: unknown): Promise<unknown> => {
        if (state.sendMessageShouldThrow) {
          throw new Error('sendMessage threw');
        }
        if (
          typeof msg === 'object' &&
          msg !== null &&
          (msg as Partial<BackgroundFetchRequest>).type === 'fck:bg-fetch'
        ) {
          state.bgFetchCalls.push(msg as BackgroundFetchRequest);
          if (state.bgFetchResponses.length === 0) {
            return undefined; // 未設定 → no-response 扱い
          }
          const r = state.bgFetchResponses[Math.min(i, state.bgFetchResponses.length - 1)];
          i += 1;
          return r;
        }
        state.lastNonBgFetchMsg = msg;
        return undefined;
      },
    },
  };
  // @types/chrome 全モック化は煩雑なので最小実装で double cast
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return state;
}

// ─── notifyConsent / notifyRevoke ────────────────────────────

describe('notifyConsent', () => {
  beforeEach(() => installFakeChromeRuntime());

  it('200: ConsentNotifyResponsePayload を返す', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      {
        ok: true,
        status: 200,
        json: { recorded: true, currentConsentVersion: '2026-05-01' },
      },
    ];
    const result = await notifyConsent(ctx, '2026-05-01');
    expect(result.recorded).toBe(true);
    expect(result.currentConsentVersion).toBe('2026-05-01');
    expect(state.bgFetchCalls[0].endpoint).toBe('consent');
    expect(state.bgFetchCalls[0].token).toBe(ctx.token);
    expect(state.bgFetchCalls[0].apiUrl).toBe(ctx.apiUrl);
  });

  it('422: ConsentApiError を投げ、status と body を保持する', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: true, status: 422, json: { error: 'Unknown consentVersion' } },
    ];
    await expect(notifyConsent(ctx, '1999-01-01')).rejects.toBeInstanceOf(ConsentApiError);
  });

  it('ネットワークエラー (ok:false, network): Error を伝播', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: false, kind: 'network', message: 'Failed to fetch' },
    ];
    await expect(notifyConsent(ctx, 'v1')).rejects.toThrow(/bg-fetch failed/);
  });

  it('invalid-origin: Error を伝播（apiUrl が改ざんされたケース）', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: false, kind: 'invalid-origin', message: 'apiUrl origin not in allowlist' },
    ];
    await expect(notifyConsent(ctx, 'v1')).rejects.toThrow(/invalid-origin/);
  });
});

describe('notifyRevoke', () => {
  it('200: RevokeResponsePayload を返す', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: true, status: 200, json: { revoked: true, deletedLogCount: 7 } },
    ];
    const result = await notifyRevoke(ctx);
    expect(result.revoked).toBe(true);
    expect(result.deletedLogCount).toBe(7);
    expect(state.bgFetchCalls[0].endpoint).toBe('revoke');
  });

  it('500 サーバーエラー時は ConsentApiError', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [{ ok: true, status: 500, json: null }];
    await expect(notifyRevoke(ctx)).rejects.toBeInstanceOf(ConsentApiError);
  });
});

// ─── IngestClient ────────────────────────────────────────────

describe('IngestClient: enqueueLog', () => {
  beforeEach(() => {
    installFakeChromeRuntime();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('50 件未満ならタイマー予約のみ（即時 fetch しない）', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: true, status: 200, json: { accepted: 1 } },
    ];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    expect(state.bgFetchCalls).toHaveLength(0);
    expect(client._bufferSize()).toBe(1);
  });

  it('50 件到達で即座にフラッシュ（タイマー待機なし）', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: true, status: 200, json: { accepted: 50 } },
    ];
    const client = new IngestClient(ctx);
    for (let i = 0; i < MAX_BATCH; i++) client.enqueueLog(makeLog(i));
    await vi.runAllTimersAsync();
    expect(state.bgFetchCalls).toHaveLength(1);
    expect(client._bufferSize()).toBe(0);
    const body = state.bgFetchCalls[0].body as { logs: unknown[] };
    expect(body.logs).toHaveLength(MAX_BATCH);
  });

  it('5 秒タイマーで自動フラッシュ', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: true, status: 200, json: null },
    ];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    expect(state.bgFetchCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(state.bgFetchCalls).toHaveLength(1);
    expect(client._bufferSize()).toBe(0);
  });
});

describe('IngestClient: response handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('200: 成功、バッファクリア、リトライカウント 0', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [{ ok: true, status: 200, json: null }];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(client._retryCount()).toBe(0);
    expect(client._bufferSize()).toBe(0);
  });

  it('410: バッチを破棄、popup に再同意通知を送る', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      {
        ok: true,
        status: 410,
        json: { error: 'consent_version_mismatch', currentConsentVersion: '2026-06-01' },
      },
    ];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(client._bufferSize()).toBe(0);
    expect(state.lastNonBgFetchMsg).toMatchObject({
      type: 'fck:consent-refresh-required',
      currentConsentVersion: '2026-06-01',
    });
  });

  it('422: バリデーション失敗、再送せずバッファクリア', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: true, status: 422, json: { error: 'logs[0]: bad' } },
    ];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(client._bufferSize()).toBe(0);
    expect(client._retryCount()).toBe(0);
  });

  it('429: バッファ復元 + 30 秒バックオフ後に再試行', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: true, status: 429, json: null },
      { ok: true, status: 200, json: null },
    ];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(state.bgFetchCalls).toHaveLength(1);
    expect(client._bufferSize()).toBe(1);
    expect(client._retryCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.bgFetchCalls).toHaveLength(2);
    expect(client._bufferSize()).toBe(0);
    expect(client._retryCount()).toBe(0);
  });

  it('ネットワークエラー (ok:false, network): 429 と同じくリトライ', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: false, kind: 'network', message: 'network down' },
      { ok: true, status: 200, json: null },
    ];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(client._bufferSize()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.bgFetchCalls).toHaveLength(2);
    expect(client._bufferSize()).toBe(0);
  });

  it('invalid-origin (ok:false): リトライしない、バッファクリア', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: false, kind: 'invalid-origin', message: 'origin not in allowlist' },
    ];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(client._bufferSize()).toBe(0);
    expect(client._retryCount()).toBe(0);
  });

  it('リトライ上限到達後は破棄', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [{ ok: true, status: 429, json: null }];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(client._bufferSize()).toBe(0);
    expect(client._retryCount()).toBe(0);
  });

  it('バックオフ中は enqueue が 5 秒タイマーを立てず、二重送信を防ぐ', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [
      { ok: true, status: 429, json: null },
      { ok: true, status: 200, json: null },
    ];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(state.bgFetchCalls).toHaveLength(1);

    for (let i = 2; i <= 6; i++) client.enqueueLog(makeLog(i));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(state.bgFetchCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.bgFetchCalls).toHaveLength(2);
    expect(client._bufferSize()).toBe(0);
    const body = state.bgFetchCalls[1].body as { logs: unknown[] };
    expect(body.logs).toHaveLength(6);
  });

  it('abort: バッファクリア + タイマー解除（revoke 時に使う）', async () => {
    const state = installFakeChromeRuntime();
    state.bgFetchResponses = [{ ok: true, status: 200, json: null }];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    client.enqueueLog(makeLog(2));
    expect(client._bufferSize()).toBe(2);

    client.abort();
    expect(client._bufferSize()).toBe(0);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(state.bgFetchCalls).toHaveLength(0);
  });

  it('background が undefined を返す: network 扱いでリトライ', async () => {
    const state = installFakeChromeRuntime();
    // bgFetchResponses 空 → fake が undefined を返す
    state.bgFetchResponses = [];
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    // バッファ復元（リトライ予定）
    expect(client._bufferSize()).toBe(1);
    expect(client._retryCount()).toBe(1);
  });

  it('sendMessage 自体が throw: network 扱いでリトライ', async () => {
    const state = installFakeChromeRuntime();
    state.sendMessageShouldThrow = true;
    const client = new IngestClient(ctx);
    client.enqueueLog(makeLog(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(client._bufferSize()).toBe(1);
    expect(client._retryCount()).toBe(1);
  });
});
