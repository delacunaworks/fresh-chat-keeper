/**
 * AR-1: StreamContextDO のアーカイブ transcript（一括取り込み・進行型要約・
 * 時刻指定取得）と P7-FIX-IDLE のテスト。
 *
 * 戦略: DurableObjectState を Map ベースでモックし、LLMProvider を注入して実通信なし。
 *
 * 検証観点:
 * - ingestTranscript: 10 分バケット分割・meta/progress 初期化・alarm セット
 * - 128KiB 安全: fitBucketToBytes が大きい segment 群をバイト上限に収める
 * - 進行型 alarm: N 回で全バケット完了 / LLM 失敗時に progress が進まず再試行
 * - ★≤T 不変条件: 任意の t で verbatim に t 超が混ざらない・whole が t 超バケットを含まない
 * - t なしクエリの後方互換（live rolling のまま）
 * - FIX-IDLE: 最終 append から閾値経過後の alarm が再設定されない
 */

import { describe, it, expect, vi } from 'vitest';
import {
  StreamContextDO,
  fitBucketToBytes,
  __test__,
  type CaptionSegment,
} from '../src/stream-context/stream-context-do.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '@fresh-chat-keeper/judgment-engine';

const {
  KEY_SEGMENTS,
  KEY_LAST_APPEND_WALL,
  KEY_TR_META,
  KEY_TR_PROGRESS,
  BUCKET_SECONDS,
  BUCKETS_PER_ALARM,
  MAX_BUCKET_BYTES,
  IDLE_STOP_MS,
  bucketKey,
  sumKey,
} = __test__;

// ─── モック ─────────────────────────────────────────────────────

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
    setAlarm: async (t: number | Date): Promise<void> => {
      alarm = typeof t === 'number' ? t : t.getTime();
    },
    deleteAlarm: async (): Promise<void> => {
      alarm = null;
    },
  };
  return { state: { storage } as unknown as DurableObjectState, store, getAlarmValue: () => alarm };
}

type ScriptItem = LLMResponse | null | 'throw';

function makeMockProvider(script: ScriptItem[] | (() => ScriptItem)): {
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
      const item = typeof script === 'function' ? script() : script[Math.min(idx, script.length - 1)];
      if (item === 'throw') throw new Error('boom');
      return item;
    }),
  };
  return { provider, calls };
}

function seg(t: number, text: string): CaptionSegment {
  return { t, text };
}

function makeDO(script: ScriptItem[] | (() => ScriptItem) = [{ text: 'cum' }]) {
  const mock = createMockState();
  const { provider, calls } = makeMockProvider(script);
  const doInstance = new StreamContextDO(mock.state, {} as never, provider);
  return { doInstance, calls, ...mock };
}

// ─── ingestTranscript バケット分割 ──────────────────────────────

describe('StreamContextDO.ingestTranscript', () => {
  it('10 分バケットに分割して保存する', async () => {
    const { doInstance, store } = makeDO();
    const res = await doInstance.ingestTranscript([
      seg(0, 'a'),
      seg(300, 'b'), // bucket 0
      seg(650, 'c'), // bucket 1
      seg(1250, 'd'), // bucket 2
    ]);
    expect(res.accepted).toBe(4);
    expect(res.buckets).toBe(3);
    const meta = store.get(KEY_TR_META) as { bucketCount: number; bucketSeconds: number };
    expect(meta.bucketCount).toBe(3);
    expect(meta.bucketSeconds).toBe(BUCKET_SECONDS);
    expect((store.get(bucketKey(0)) as CaptionSegment[]).length).toBe(2);
    expect((store.get(bucketKey(1)) as CaptionSegment[]).length).toBe(1);
    expect((store.get(bucketKey(2)) as CaptionSegment[]).length).toBe(1);
    expect(store.get(KEY_TR_PROGRESS)).toBe(0);
  });

  it('取り込み後に alarm を張る（要約事前計算を開始）', async () => {
    const { doInstance, getAlarmValue } = makeDO();
    await doInstance.ingestTranscript([seg(10, 'x')]);
    expect(getAlarmValue()).not.toBeNull();
  });

  it('負の t は捨てる', async () => {
    const { doInstance, store } = makeDO();
    const res = await doInstance.ingestTranscript([seg(-5, 'bad'), seg(10, 'ok')]);
    expect(res.accepted).toBe(1);
    expect((store.get(bucketKey(0)) as CaptionSegment[]).length).toBe(1);
  });
});

// ─── 128KiB 安全 ────────────────────────────────────────────────

describe('fitBucketToBytes (128KiB 安全網)', () => {
  it('上限内はそのまま返す', () => {
    const segs = [seg(0, 'short'), seg(1, 'text')];
    expect(fitBucketToBytes(segs)).toBe(segs);
  });

  it('大きい segment 群をバイト上限に収める（トリム）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 各 segment ~2KB の日本語テキストを大量に作り MAX_BUCKET_BYTES を超えさせる。
    const big = 'あ'.repeat(1000); // UTF-8 で ~3KB/segment
    const segs = Array.from({ length: 100 }, (_, i) => seg(i, big));
    const fitted = fitBucketToBytes(segs);
    const bytes = new TextEncoder().encode(JSON.stringify(fitted)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_BUCKET_BYTES);
    expect(fitted.length).toBeLessThan(segs.length);
    warn.mockRestore();
  });

  it('ingestTranscript 経由でも各バケットが上限内に収まる', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const big = 'ん'.repeat(1000);
    // 全て bucket 0（t < 600）に密集させる。
    const segs = Array.from({ length: 100 }, (_, i) => seg(i, big));
    const { doInstance, store } = makeDO();
    await doInstance.ingestTranscript(segs);
    const stored = store.get(bucketKey(0)) as CaptionSegment[];
    const bytes = new TextEncoder().encode(JSON.stringify(stored)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_BUCKET_BYTES);
    warn.mockRestore();
  });
});

// ─── 進行型 alarm ───────────────────────────────────────────────

describe('StreamContextDO.alarm — transcript 進行型要約', () => {
  it('N 回の alarm で全バケットを完了する', async () => {
    // 10 バケット（t=0,600,...,5400）各非空。
    const segs = Array.from({ length: 10 }, (_, i) => seg(i * BUCKET_SECONDS + 5, `bucket-${i}`));
    let n = 0;
    const { doInstance, store, calls } = makeDO(() => ({ text: `cum-${n++}` }));
    await doInstance.ingestTranscript(segs);

    await doInstance.alarm();
    expect(store.get(KEY_TR_PROGRESS)).toBe(BUCKETS_PER_ALARM); // 4
    await doInstance.alarm();
    expect(store.get(KEY_TR_PROGRESS)).toBe(BUCKETS_PER_ALARM * 2); // 8
    await doInstance.alarm();
    expect(store.get(KEY_TR_PROGRESS)).toBe(10); // 完了

    // 全バケットに 1 回ずつ complete（計 10 回）。
    expect(calls).toHaveLength(10);
    expect(store.get(sumKey(9))).toBe('cum-9');
  });

  it('空バケットは LLM を呼ばず前累積を carry する', async () => {
    // bucket 0 非空・bucket 1 空・bucket 2 非空。
    const { doInstance, store, calls } = makeDO([{ text: 'C0' }, { text: 'C2' }]);
    // t=5(b0), t=1205(b2) → b1 は空、bucketCount=3
    await doInstance.ingestTranscript([seg(5, 'a'), seg(1205, 'b')]);
    await doInstance.alarm();
    expect(store.get(KEY_TR_PROGRESS)).toBe(3);
    // b1 は空 → complete は b0, b2 の 2 回のみ。
    expect(calls).toHaveLength(2);
    expect(store.get(sumKey(0))).toBe('C0');
    expect(store.get(sumKey(1))).toBe('C0'); // carry
    expect(store.get(sumKey(2))).toBe('C2');
  });

  it('LLM 失敗（null）で progress が進まず、次 alarm で再試行して完了する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const segs = [seg(5, 'a'), seg(605, 'b'), seg(1205, 'c')]; // 3 バケット
    // 1 回目: b0 成功, b1 で null → break（progress=1）。2 回目: 成功続行。
    const script: ScriptItem[] = [{ text: 'C0' }, null, { text: 'C1' }, { text: 'C2' }];
    let i = 0;
    const { doInstance, store, calls } = makeDO(() => script[Math.min(i++, script.length - 1)]);
    await doInstance.ingestTranscript(segs);

    await doInstance.alarm(); // b0 ok, b1 null → progress 据置 1
    expect(store.get(KEY_TR_PROGRESS)).toBe(1);

    await doInstance.alarm(); // b1, b2 成功 → progress 3
    expect(store.get(KEY_TR_PROGRESS)).toBe(3);
    expect(store.get(sumKey(2))).toBe('C2');
    // b0(ok)+b1(null失敗)+b1(retry ok)+b2(ok) = 4 回呼ばれる
    expect(calls).toHaveLength(4);
    warn.mockRestore();
  });

  it('LLM が throw しても DO を落とさず progress 据置で再試行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { doInstance, store } = makeDO(['throw']);
    await doInstance.ingestTranscript([seg(5, 'a')]);
    await expect(doInstance.alarm()).resolves.toBeUndefined();
    expect(store.get(KEY_TR_PROGRESS)).toBe(0); // 進まない
    warn.mockRestore();
  });
});

// ─── ★≤T 不変条件（最重要）────────────────────────────────────

describe('getRecentSummary(t) — ★T より未来を絶対に返さない', () => {
  /** transcript を storage に直接シードする（要約は全バケット計算済みとする）。 */
  function seedTranscript(store: Map<string, unknown>, bucketCount: number): void {
    store.set(KEY_TR_META, { bucketSeconds: BUCKET_SECONDS, bucketCount, ingestedAt: 1 });
    store.set(KEY_TR_PROGRESS, bucketCount); // 全バケット要約済み
    for (let b = 0; b < bucketCount; b++) {
      // 各バケットに複数 segment（t を text に埋め込む）。
      const segs: CaptionSegment[] = [];
      for (let k = 0; k < 5; k++) {
        const t = b * BUCKET_SECONDS + k * 100; // 0,100,200,300,400 within bucket
        if (t < (b + 1) * BUCKET_SECONDS) segs.push(seg(t, `T=${t}`));
      }
      store.set(bucketKey(b), segs);
      // 累積要約はカバーする最大バケット index を埋め込む。
      store.set(sumKey(b), `CUM@bucket${b}`);
    }
  }

  it('verbatim に t 超の segment を絶対に含めない（多数の t で検証）', async () => {
    const { doInstance, store } = makeDO();
    seedTranscript(store, 10); // 0..6000 秒
    for (let t = 0; t <= 6000; t += 137) {
      const summary = await doInstance.getRecentSummary(t);
      if (summary.verbatim) {
        const matches = [...summary.verbatim.matchAll(/T=(\d+)/g)].map((m) => Number(m[1]));
        for (const st of matches) {
          expect(st).toBeLessThanOrEqual(t); // ★未来を含まない
          expect(st).toBeGreaterThanOrEqual(t - __test__.L0_VERBATIM_SECONDS); // 窓内
        }
      }
    }
  });

  it('whole は「バケット全体が T 以前」の累積のみ（多数の t で検証）', async () => {
    const { doInstance, store } = makeDO();
    seedTranscript(store, 10);
    for (let t = 0; t <= 6000; t += 91) {
      const summary = await doInstance.getRecentSummary(t);
      if (summary.whole) {
        const b = Number(/CUM@bucket(\d+)/.exec(summary.whole)![1]);
        // バケット b が全体 T 以前 = (b+1)*BUCKET <= T でなければならない。
        expect((b + 1) * BUCKET_SECONDS).toBeLessThanOrEqual(t);
      }
    }
  });

  it('T=0 では whole を返さない（バケット0は [0,600) で全体 ≤0 でない）', async () => {
    const { doInstance, store } = makeDO();
    seedTranscript(store, 5);
    const summary = await doInstance.getRecentSummary(0);
    expect(summary.whole).toBeUndefined();
  });

  it('progress 未完なら計算済みバケットまでしか whole を返さない', async () => {
    const { doInstance, store } = makeDO();
    seedTranscript(store, 10);
    store.set(KEY_TR_PROGRESS, 2); // bucket 0,1 のみ要約済み
    // T が大きく（全バケット ≤T）ても、計算済みは bucket1 まで。
    const summary = await doInstance.getRecentSummary(6000);
    expect(summary.whole).toBe('CUM@bucket1');
  });

  it('t あり + transcript なし → 空を返す', async () => {
    const { doInstance } = makeDO();
    expect(await doInstance.getRecentSummary(1000)).toEqual({});
  });
});

// ─── t なしクエリの後方互換 ─────────────────────────────────────

describe('getRecentSummary() — t なしは live rolling のまま（後方互換）', () => {
  it('transcript があっても t なしでは transcript を返さない', async () => {
    const { doInstance, store } = makeDO();
    // transcript をシード。
    store.set(KEY_TR_META, { bucketSeconds: BUCKET_SECONDS, bucketCount: 1, ingestedAt: 1 });
    store.set(bucketKey(0), [seg(10, 'transcript-text')]);
    store.set(sumKey(0), 'transcript-cum');
    store.set(KEY_TR_PROGRESS, 1);
    // live segments はゼロ。
    const summary = await doInstance.getRecentSummary(); // t なし
    expect(summary).toEqual({}); // live rolling は空（transcript は混ざらない）
  });

  it('live segments があれば従来どおり verbatim を返す（t なし）', async () => {
    const { doInstance } = makeDO();
    await doInstance.appendCaptions([seg(10, 'live-verbatim')]);
    const summary = await doInstance.getRecentSummary();
    expect(summary.verbatim).toBe('live-verbatim');
  });
});

// ─── FIX-IDLE ───────────────────────────────────────────────────

describe('P7-FIX-IDLE — 配信終了後の alarm 永久ループ修正', () => {
  it('appendCaptions が最終 append の実時間を記録する', async () => {
    const { doInstance, store } = makeDO();
    const before = Date.now();
    await doInstance.appendCaptions([seg(1, 'x')]);
    const wall = store.get(KEY_LAST_APPEND_WALL) as number;
    expect(wall).toBeGreaterThanOrEqual(before);
  });

  it('最終 append から IDLE_STOP_MS 超なら alarm を再設定しない', async () => {
    const { doInstance, store, getAlarmValue, calls } = makeDO();
    // segments はあるが最終 append が大昔（idle）。
    store.set(KEY_SEGMENTS, [seg(1, 'x')]);
    store.set(KEY_LAST_APPEND_WALL, 1); // 1970 → 遥か過去
    await doInstance.alarm();
    expect(getAlarmValue()).toBeNull(); // 再設定されない
    expect(calls).toHaveLength(0); // idle 判定で要約もしない
  });

  it('最終 append が最近なら alarm を再設定する（通常）', async () => {
    const { doInstance, store, getAlarmValue } = makeDO();
    store.set(KEY_SEGMENTS, [seg(1, 'x')]);
    store.set(KEY_LAST_APPEND_WALL, Date.now());
    await doInstance.alarm();
    expect(getAlarmValue()).not.toBeNull();
  });

  it('IDLE_STOP_MS は 2 時間', () => {
    expect(IDLE_STOP_MS).toBe(2 * 60 * 60 * 1000);
  });
});
