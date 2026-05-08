/**
 * ingest.ts の validateLog / isInUnitRange の単体テスト + safeJsonParse のテスト。
 *
 * 統合動作（422 を返すこと）は ingest.test.ts の既存ケースで担保。本ファイルは
 * 個別ガードの境界値（confidence の 0/1、body 長さ、UUID 形式、JSON 破損）を
 * 単体で固定し、Phase 3 でフィールドが追加されたときの回帰を検出する。
 */

import { describe, it, expect, vi } from 'vitest';
import { __test__ as ingestTestExports } from '../src/routes/ingest.js';
import { __test__ as schemaTestExports } from '../src/db/schema.js';

const { validateLog, isInUnitRange, MAX_BODY_LENGTH, MAX_CONTEXT_MESSAGES } = ingestTestExports;
const { safeJsonParse } = schemaTestExports;

function buildValidLog(): Record<string, unknown> {
  return {
    logId: '00000000-0000-4000-8000-000000000001',
    recordedAt: '2026-05-01T10:00:00.000Z',
    consentVersion: '2026-05-01',
    videoId: 'v',
    channelId: 'c',
    gameTitle: null,
    streamProgressHint: null,
    timeIntoStream: null,
    judgmentMode: 'live',
    targetMessage: {
      body: 'x',
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

describe('isInUnitRange', () => {
  it('0 と 1 は通過する（境界包含）', () => {
    expect(isInUnitRange(0)).toBe(true);
    expect(isInUnitRange(1)).toBe(true);
  });

  it('0〜1 の中間値は通過する', () => {
    expect(isInUnitRange(0.5)).toBe(true);
    expect(isInUnitRange(0.001)).toBe(true);
    expect(isInUnitRange(0.999)).toBe(true);
  });

  it('範囲外（負数 / 1超）は弾く', () => {
    expect(isInUnitRange(-0.01)).toBe(false);
    expect(isInUnitRange(1.01)).toBe(false);
    expect(isInUnitRange(-1)).toBe(false);
    expect(isInUnitRange(2)).toBe(false);
  });

  it('NaN / Infinity は弾く', () => {
    expect(isInUnitRange(NaN)).toBe(false);
    expect(isInUnitRange(Infinity)).toBe(false);
    expect(isInUnitRange(-Infinity)).toBe(false);
  });
});

describe('validateLog: confidence 範囲', () => {
  it('confidence 0 / 1 / 0.5 は通過', () => {
    for (const v of [0, 1, 0.5]) {
      const log = { ...buildValidLog(), confidence: v };
      expect(validateLog(log)).toBeNull();
    }
  });

  it('confidence -0.1 / 1.1 は 422 メッセージ', () => {
    for (const v of [-0.1, 1.1]) {
      const log = { ...buildValidLog(), confidence: v };
      expect(validateLog(log)).toMatch(/confidence/);
    }
  });

  it('confidence NaN は弾く', () => {
    const log = { ...buildValidLog(), confidence: NaN };
    expect(validateLog(log)).toMatch(/confidence/);
  });
});

describe('validateLog: stageAConfidence', () => {
  it('null / 0 / 1 / 中間値は通過', () => {
    for (const v of [null, 0, 1, 0.42]) {
      const log = { ...buildValidLog(), stageAConfidence: v };
      expect(validateLog(log)).toBeNull();
    }
  });

  it('範囲外 / NaN は弾く', () => {
    for (const v of [-0.5, 1.5, NaN, Infinity]) {
      const log = { ...buildValidLog(), stageAConfidence: v };
      expect(validateLog(log)).toMatch(/stageAConfidence/);
    }
  });
});

describe('validateLog: target_body サイズ上限', () => {
  it('500 文字ちょうどは通過', () => {
    const log = buildValidLog() as Record<string, unknown>;
    (log.targetMessage as Record<string, unknown>).body = 'a'.repeat(MAX_BODY_LENGTH);
    expect(validateLog(log)).toBeNull();
  });

  it('501 文字は弾く', () => {
    const log = buildValidLog() as Record<string, unknown>;
    (log.targetMessage as Record<string, unknown>).body = 'a'.repeat(MAX_BODY_LENGTH + 1);
    expect(validateLog(log)).toMatch(/exceeds.*500/);
  });
});

describe('validateLog: precedingMessages / followingMessages', () => {
  it('10 件ちょうどは通過', () => {
    const log = buildValidLog() as Record<string, unknown>;
    log.precedingMessages = Array.from({ length: MAX_CONTEXT_MESSAGES }, () => ({
      body: 'x',
      timestamp: '2026-05-01T00:00:00.000Z',
    }));
    expect(validateLog(log)).toBeNull();
  });

  it('11 件は弾く', () => {
    const log = buildValidLog() as Record<string, unknown>;
    log.precedingMessages = Array.from({ length: MAX_CONTEXT_MESSAGES + 1 }, () => ({
      body: 'x',
      timestamp: '2026-05-01T00:00:00.000Z',
    }));
    expect(validateLog(log)).toMatch(/precedingMessages.*not exceed/);
  });

  it('要素の body が長すぎる場合は弾く', () => {
    const log = buildValidLog() as Record<string, unknown>;
    log.precedingMessages = [
      { body: 'a'.repeat(MAX_BODY_LENGTH + 1), timestamp: '2026-05-01T00:00:00.000Z' },
    ];
    expect(validateLog(log)).toMatch(/precedingMessages\[0\]\.body/);
  });

  it('followingMessages の上限も同様に動作', () => {
    const log = buildValidLog() as Record<string, unknown>;
    log.followingMessages = Array.from({ length: MAX_CONTEXT_MESSAGES + 1 }, () => ({
      body: 'x',
      timestamp: '2026-05-01T00:00:00.000Z',
    }));
    expect(validateLog(log)).toMatch(/followingMessages.*not exceed/);
  });
});

describe('validateLog: logId UUID 形式', () => {
  it('UUID v4 形式は通過', () => {
    const log = { ...buildValidLog(), logId: '11111111-2222-4333-8444-555555555555' };
    expect(validateLog(log)).toBeNull();
  });

  it('UUID v1 形式（version=1）も通過する（任意の v1〜v5 を許容）', () => {
    const log = { ...buildValidLog(), logId: '11111111-2222-1333-8444-555555555555' };
    expect(validateLog(log)).toBeNull();
  });

  it('UUID 形式でない logId は弾く', () => {
    for (const bad of ['not-a-uuid', '12345', '11111111-2222-3333-4444-5555', '']) {
      const log = { ...buildValidLog(), logId: bad };
      expect(validateLog(log)).toMatch(/logId/);
    }
  });
});

describe('safeJsonParse', () => {
  it('正常な JSON 文字列はパースされる', () => {
    expect(safeJsonParse<number[]>('[1,2,3]', [], 'test')).toEqual([1, 2, 3]);
  });

  it('null 入力は fallback を返す（warn ログなし）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(safeJsonParse<string[]>(null, ['default'], 'test')).toEqual(['default']);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('壊れた JSON は warn ログ + fallback を返す', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(safeJsonParse<unknown[]>('not-json', [], 'broken_field')).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      const msg = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(msg).toContain('broken_field');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
