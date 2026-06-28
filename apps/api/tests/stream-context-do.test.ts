/**
 * StreamContextDO の単体テスト（P7-B3）。
 *
 * 戦略: DurableObjectState/storage を Map ベースでモックし、DO クラスのメソッドを
 * 直接 unit テストする（既存 api テストの plain vitest + モック作法に合わせる。
 * @cloudflare/vitest-pool-workers は使わない）。
 *
 * 検証観点:
 * - appendCaptions: 蓄積 / concat / プルーニング（古い t・件数上限）/ alarm 設定
 * - getRecentSummary: verbatim 構築（直近窓）/ whole・recent は B4 まで undefined
 * - alarm: 雛形（蓄積ありなら次 alarm 再設定、空なら張らない）
 * - fetch: 内部 RPC（/append POST・/summary GET・404）
 */

import { describe, it, expect } from 'vitest';
import {
  StreamContextDO,
  pruneSegments,
  buildVerbatim,
  __test__,
  type CaptionSegment,
} from '../src/stream-context/stream-context-do.js';

const { RETENTION_SECONDS, L0_VERBATIM_SECONDS, MAX_SEGMENTS, ALARM_INTERVAL_MS } = __test__;

// ─── DurableObjectState モック ──────────────────────────────────

function createMockState(): {
  state: DurableObjectState;
  store: Map<string, unknown>;
  getAlarmValue: () => number | null;
} {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;

  const storage = {
    get: async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => store.delete(key),
    getAlarm: async (): Promise<number | null> => alarm,
    setAlarm: async (scheduledTime: number | Date): Promise<void> => {
      alarm = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
    },
    deleteAlarm: async (): Promise<void> => {
      alarm = null;
    },
  };

  const state = { storage } as unknown as DurableObjectState;
  return { state, store, getAlarmValue: () => alarm };
}

function makeDO() {
  const mock = createMockState();
  const env = {} as never;
  const doInstance = new StreamContextDO(mock.state, env);
  return { doInstance, ...mock };
}

function seg(text: string, t: number): CaptionSegment {
  return { text, t };
}

// ─── appendCaptions ─────────────────────────────────────────────

describe('StreamContextDO.appendCaptions', () => {
  it('segment を蓄積し getRecentSummary.verbatim に反映する', async () => {
    const { doInstance } = makeDO();
    await doInstance.appendCaptions([seg('こんにちは', 10), seg('始めるよ', 20)]);

    const summary = await doInstance.getRecentSummary();
    expect(summary.verbatim).toBe('こんにちは 始めるよ');
  });

  it('複数回呼ぶと concat される', async () => {
    const { doInstance } = makeDO();
    await doInstance.appendCaptions([seg('A', 1)]);
    await doInstance.appendCaptions([seg('B', 2)]);

    const summary = await doInstance.getRecentSummary();
    expect(summary.verbatim).toBe('A B');
  });

  it('空配列なら何もしない（alarm も張らない）', async () => {
    const { doInstance, getAlarmValue } = makeDO();
    await doInstance.appendCaptions([]);
    expect(getAlarmValue()).toBeNull();
  });

  it('初回 append で alarm を ALARM_INTERVAL_MS 後にセットする', async () => {
    const { doInstance, getAlarmValue } = makeDO();
    const before = Date.now();
    await doInstance.appendCaptions([seg('x', 1)]);
    const alarm = getAlarmValue();
    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeGreaterThanOrEqual(before + ALARM_INTERVAL_MS);
  });

  it('alarm 設定済みなら再設定しない（多重設定の回避）', async () => {
    const { doInstance, getAlarmValue } = makeDO();
    await doInstance.appendCaptions([seg('x', 1)]);
    const first = getAlarmValue();
    await doInstance.appendCaptions([seg('y', 2)]);
    expect(getAlarmValue()).toBe(first);
  });

  it('最新 t から RETENTION_SECONDS より古い segment は落とす', async () => {
    const { doInstance } = makeDO();
    await doInstance.appendCaptions([
      seg('old', 0),
      seg('new', RETENTION_SECONDS + 100),
    ]);
    const summary = await doInstance.getRecentSummary();
    // old は cutoff 外。verbatim は L0 窓だが、storage 自体からも old は消えている。
    expect(summary.verbatim ?? '').not.toContain('old');
  });
});

// ─── getRecentSummary ───────────────────────────────────────────

describe('StreamContextDO.getRecentSummary', () => {
  it('蓄積ゼロなら空サマリ（verbatim も undefined）', async () => {
    const { doInstance } = makeDO();
    const summary = await doInstance.getRecentSummary();
    expect(summary.verbatim).toBeUndefined();
    expect(summary.whole).toBeUndefined();
    expect(summary.recent).toBeUndefined();
  });

  it('whole / recent は B4 まで常に undefined', async () => {
    const { doInstance } = makeDO();
    await doInstance.appendCaptions([seg('text', 5)]);
    const summary = await doInstance.getRecentSummary();
    expect(summary.whole).toBeUndefined();
    expect(summary.recent).toBeUndefined();
    expect(summary.verbatim).toBe('text');
  });

  it('verbatim は最新 t から L0_VERBATIM_SECONDS 以内のみ', async () => {
    const { doInstance } = makeDO();
    // old は窓外だが RETENTION 内なので storage には残る。verbatim には出ない。
    await doInstance.appendCaptions([
      seg('too-old', 0),
      seg('recent', L0_VERBATIM_SECONDS + 1),
    ]);
    const summary = await doInstance.getRecentSummary();
    expect(summary.verbatim).toBe('recent');
  });
});

// ─── alarm（雛形）─────────────────────────────────────────────

describe('StreamContextDO.alarm', () => {
  it('蓄積ありなら次回 alarm を再設定する', async () => {
    const { doInstance, getAlarmValue } = makeDO();
    await doInstance.appendCaptions([seg('x', 1)]);
    // appendCaptions が張った alarm を一旦消し、alarm() が張り直すことを見る。
    const before = Date.now();
    await doInstance.alarm();
    const after = getAlarmValue();
    expect(after).not.toBeNull();
    expect(after as number).toBeGreaterThanOrEqual(before + ALARM_INTERVAL_MS);
  });

  it('蓄積が空なら次回 alarm を張らない（idle 化）', async () => {
    const { doInstance, getAlarmValue } = makeDO();
    await doInstance.alarm();
    expect(getAlarmValue()).toBeNull();
  });
});

// ─── fetch（内部 RPC）───────────────────────────────────────────

describe('StreamContextDO.fetch', () => {
  it('POST /append で蓄積し accepted を返す', async () => {
    const { doInstance } = makeDO();
    const res = await doInstance.fetch(
      new Request('https://do/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: [seg('hi', 1), seg('there', 2)] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 2 });
  });

  it('POST /append の segments が配列でないと 400', async () => {
    const { doInstance } = makeDO();
    const res = await doInstance.fetch(
      new Request('https://do/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: 'nope' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('GET /summary でサマリ JSON を返す', async () => {
    const { doInstance } = makeDO();
    await doInstance.appendCaptions([seg('yo', 3)]);
    const res = await doInstance.fetch(new Request('https://do/summary', { method: 'GET' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verbatim: 'yo' });
  });

  it('未知のパスは 404', async () => {
    const { doInstance } = makeDO();
    const res = await doInstance.fetch(new Request('https://do/unknown', { method: 'GET' }));
    expect(res.status).toBe(404);
  });
});

// ─── 純粋ヘルパー ───────────────────────────────────────────────

describe('pruneSegments', () => {
  it('空配列はそのまま', () => {
    expect(pruneSegments([])).toEqual([]);
  });

  it('件数上限 MAX_SEGMENTS で新しい側を残す', () => {
    const many: CaptionSegment[] = Array.from({ length: MAX_SEGMENTS + 50 }, (_, i) =>
      seg(`s${i}`, i),
    );
    const pruned = pruneSegments(many);
    expect(pruned.length).toBe(MAX_SEGMENTS);
    expect(pruned[pruned.length - 1].text).toBe(`s${MAX_SEGMENTS + 49}`);
  });
});

describe('buildVerbatim', () => {
  it('空配列は空文字', () => {
    expect(buildVerbatim([])).toBe('');
  });

  it('空白のみ segment は除外して連結', () => {
    expect(buildVerbatim([seg('  ', 1), seg('hello', 2)])).toBe('hello');
  });
});

describe('isCaptionSegment', () => {
  it('正しい形のみ true', () => {
    expect(__test__.isCaptionSegment({ text: 'a', t: 1 })).toBe(true);
    expect(__test__.isCaptionSegment({ text: 'a', t: NaN })).toBe(false);
    expect(__test__.isCaptionSegment({ text: 1, t: 1 })).toBe(false);
    expect(__test__.isCaptionSegment(null)).toBe(false);
  });
});
