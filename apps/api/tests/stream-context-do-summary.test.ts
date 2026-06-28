/**
 * StreamContextDO の alarm 要約パイプライン（L1/L2）のテスト（P7-B4）。
 *
 * 戦略: LLMProvider をモック注入（コンストラクタ 3rd 引数）して実通信なし。
 * DurableObjectState は Map ベース storage モック。
 *
 * 検証観点:
 * - alarm が新規窓を要約し L1/L2 を storage に保存 → getRecentSummary に反映
 * - 再要約マーカー: 新規 segment が無ければ要約をスキップ（complete を呼ばない）
 * - 新規 segment 追加で次窓を要約
 * - LLM 失敗（null / 空応答 / throw）は既存 L1/L2 を保持し DO を落とさない
 */

import { describe, it, expect, vi } from 'vitest';
import {
  StreamContextDO,
  type CaptionSegment,
} from '../src/stream-context/stream-context-do.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '@fresh-chat-keeper/judgment-engine';

// ─── モック ─────────────────────────────────────────────────────

function createMockState(): { state: DurableObjectState; getAlarmValue: () => number | null } {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => store.delete(key),
    getAlarm: async (): Promise<number | null> => alarm,
    setAlarm: async (t: number | Date): Promise<void> => {
      alarm = typeof t === 'number' ? t : t.getTime();
    },
    deleteAlarm: async (): Promise<void> => {
      alarm = null;
    },
  };
  return { state: { storage } as unknown as DurableObjectState, getAlarmValue: () => alarm };
}

type ScriptItem = LLMResponse | null | 'throw';

/** 呼び出しごとに script の値を返す（L1→L2 の順）モック provider。 */
function makeMockProvider(script: ScriptItem[]): {
  provider: LLMProvider;
  calls: LLMRequest[];
} {
  const calls: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'mock',
    callsFrom: 'worker',
    supportsPromptCache: false,
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse | null> => {
      const idx = calls.length;
      calls.push(req);
      const item = idx < script.length ? script[idx] : script[script.length - 1];
      if (item === 'throw') throw new Error('network boom');
      return item;
    }),
  };
  return { provider, calls };
}

function seg(text: string, t: number): CaptionSegment {
  return { text, t };
}

function makeDO(script: ScriptItem[]) {
  const { state, getAlarmValue } = createMockState();
  const { provider, calls } = makeMockProvider(script);
  const doInstance = new StreamContextDO(state, {} as never, provider);
  return { doInstance, calls, getAlarmValue };
}

// ─── L1/L2 生成 ─────────────────────────────────────────────────

describe('StreamContextDO.alarm — 要約生成', () => {
  it('新規窓を要約し L1/L2 を getRecentSummary に反映する', async () => {
    const { doInstance } = makeDO([{ text: 'L1近傍要約' }, { text: 'L2累積要約' }]);
    await doInstance.appendCaptions([seg('配信を始めます', 10), seg('ボスに挑む', 20)]);
    await doInstance.alarm();

    const summary = await doInstance.getRecentSummary();
    expect(summary.recent).toBe('L1近傍要約'); // L1
    expect(summary.whole).toBe('L2累積要約'); // L2
    expect(summary.verbatim).toBe('配信を始めます ボスに挑む'); // L0 逐語
  });

  it('L1 応答の前後空白は trim して保存', async () => {
    const { doInstance } = makeDO([{ text: '  要約A  ' }, { text: '要約B' }]);
    await doInstance.appendCaptions([seg('x', 5)]);
    await doInstance.alarm();
    expect((await doInstance.getRecentSummary()).recent).toBe('要約A');
  });

  it('alarm は L1→L2 の 2 回 complete を呼ぶ', async () => {
    const { doInstance, calls } = makeDO([{ text: 'L1' }, { text: 'L2' }]);
    await doInstance.appendCaptions([seg('x', 1)]);
    await doInstance.alarm();
    expect(calls).toHaveLength(2);
  });
});

// ─── 再要約マーカー ─────────────────────────────────────────────

describe('StreamContextDO.alarm — 再要約マーカー', () => {
  it('新規 segment が無ければ要約をスキップ（complete を呼ばない）', async () => {
    const { doInstance, calls } = makeDO([{ text: 'L1' }, { text: 'L2' }]);
    await doInstance.appendCaptions([seg('x', 1)]);
    await doInstance.alarm(); // 1 回目: 2 calls
    await doInstance.alarm(); // 2 回目: 新規窓なし → 追加 call なし
    expect(calls).toHaveLength(2);
  });

  it('新規 segment 追加で次窓を要約し L1 を更新する', async () => {
    const { doInstance, calls } = makeDO([
      { text: 'L1-a' },
      { text: 'L2-a' },
      { text: 'L1-b' },
      { text: 'L2-b' },
    ]);
    await doInstance.appendCaptions([seg('一回目', 10)]);
    await doInstance.alarm();
    expect((await doInstance.getRecentSummary()).recent).toBe('L1-a');

    await doInstance.appendCaptions([seg('二回目', 20)]);
    await doInstance.alarm();
    expect(calls).toHaveLength(4);
    expect((await doInstance.getRecentSummary()).recent).toBe('L1-b');
    expect((await doInstance.getRecentSummary()).whole).toBe('L2-b');
  });
});

// ─── 失敗時フォールバック ───────────────────────────────────────

describe('StreamContextDO.alarm — LLM 失敗時は既存を保持し DO を落とさない', () => {
  it('L1 が null（HTTP 非2xx）なら既存 L1/L2 を保持・マーカー据置（次窓で再試行）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 1 回目成功で L1-a/L2-a を作る → 2 回目は L1=null
    const { doInstance, calls } = makeDO([
      { text: 'L1-a' },
      { text: 'L2-a' },
      null, // 2 回目 L1 → null
      { text: 'never-used' },
    ]);
    await doInstance.appendCaptions([seg('一回目', 10)]);
    await doInstance.alarm();
    await doInstance.appendCaptions([seg('二回目', 20)]);
    await doInstance.alarm();

    const summary = await doInstance.getRecentSummary();
    expect(summary.recent).toBe('L1-a'); // 保持
    expect(summary.whole).toBe('L2-a'); // 保持
    // L1 が null だったので L2 の complete は呼ばれない（3 calls 目で打ち切り）
    expect(calls).toHaveLength(3);
    warn.mockRestore();
  });

  it('L1 が空応答でも既存を保持（unavailable 扱い）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { doInstance } = makeDO([{ text: 'L1-a' }, { text: 'L2-a' }, { text: '   ' }]);
    await doInstance.appendCaptions([seg('一回目', 10)]);
    await doInstance.alarm();
    await doInstance.appendCaptions([seg('二回目', 20)]);
    await doInstance.alarm();
    expect((await doInstance.getRecentSummary()).recent).toBe('L1-a');
    warn.mockRestore();
  });

  it('complete が throw（network/parse）しても alarm は解決し既存を保持', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { doInstance } = makeDO([{ text: 'L1-a' }, { text: 'L2-a' }, 'throw']);
    await doInstance.appendCaptions([seg('一回目', 10)]);
    await doInstance.alarm();
    await doInstance.appendCaptions([seg('二回目', 20)]);
    await expect(doInstance.alarm()).resolves.toBeUndefined();
    expect((await doInstance.getRecentSummary()).recent).toBe('L1-a');
    warn.mockRestore();
  });

  it('初回から throw でも DO は落ちず L1/L2 は空のまま', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { doInstance } = makeDO(['throw']);
    await doInstance.appendCaptions([seg('x', 1)]);
    await expect(doInstance.alarm()).resolves.toBeUndefined();
    const summary = await doInstance.getRecentSummary();
    expect(summary.recent).toBeUndefined();
    expect(summary.whole).toBeUndefined();
    expect(summary.verbatim).toBe('x'); // verbatim は要約失敗でも出る
    warn.mockRestore();
  });

  it('要約後も次 alarm を再設定する（B3 の周期維持）', async () => {
    const { doInstance, getAlarmValue } = makeDO([{ text: 'L1' }, { text: 'L2' }]);
    await doInstance.appendCaptions([seg('x', 1)]);
    const before = Date.now();
    await doInstance.alarm();
    const alarmAt = getAlarmValue();
    expect(alarmAt).not.toBeNull();
    expect(alarmAt as number).toBeGreaterThanOrEqual(before);
  });
});
