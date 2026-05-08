/**
 * retention.ts の単体テスト。
 *
 * 検証範囲:
 * - 90 日境界（89 / 90 / 91 日）の judgment_logs 削除条件
 * - 30 日境界の revoked consent_records 削除条件
 * - SQL の WHERE 句に渡される cutoff 時刻が現在時刻 - N日と一致する
 * - batch で 2 文を 1 トランザクションにまとめている
 *
 * D1 はモック。実際の D1 削除挙動は CHECK 制約や retention の I/O は
 * ingestion E2E で確認する想定。
 */

import { describe, it, expect } from 'vitest';
import {
  runRetention,
  LOG_RETENTION_DAYS,
  REVOKED_CONSENT_RETENTION_DAYS,
} from '../src/db/retention.js';

interface RecordedStmt {
  sql: string;
  params: unknown[];
}

function createMockD1(opts: {
  deletedLogs?: number;
  deletedConsent?: number;
} = {}): { db: D1Database; calls: RecordedStmt[] } {
  const calls: RecordedStmt[] = [];

  const prepare = (sql: string): D1PreparedStatement => {
    let boundParams: unknown[] = [];
    const stmt = {
      bind: (...args: unknown[]) => {
        boundParams = args;
        return stmt;
      },
      first: async () => null,
      run: async () => ({ success: true, meta: { changes: 0 }, results: [] }) as unknown as D1Response,
      all: async () => ({ results: [], success: true, meta: {} }) as unknown as D1Result,
      raw: async () => [] as unknown as never[],
      _sql: () => sql,
      _boundParams: () => boundParams,
    } as unknown as D1PreparedStatement;
    return stmt;
  };

  return {
    db: {
      prepare,
      batch: async (stmts: D1PreparedStatement[]) => {
        return stmts.map((s, i) => {
          const meta = s as unknown as { _sql: () => string; _boundParams: () => unknown[] };
          calls.push({ sql: meta._sql(), params: meta._boundParams() });
          const isLogs = i === 0;
          const changes = isLogs ? (opts.deletedLogs ?? 0) : (opts.deletedConsent ?? 0);
          return { success: true, meta: { changes }, results: [] } as unknown as D1Result;
        });
      },
      dump: async () => new ArrayBuffer(0),
      exec: async () => ({ count: 0, duration: 0 }) as D1ExecResult,
    } as unknown as D1Database,
    calls,
  };
}

const DAY_MS = 86_400_000;

describe('runRetention', () => {
  it('cutoff: judgment_logs は now - 90日 を境に WHERE received_at < cutoff', async () => {
    const { db, calls } = createMockD1({ deletedLogs: 5, deletedConsent: 0 });
    const now = Date.parse('2026-05-07T03:00:00.000Z');
    await runRetention(db, now);

    const logsCall = calls.find((c) => c.sql.toUpperCase().includes('FROM JUDGMENT_LOGS'));
    expect(logsCall).toBeDefined();
    expect(logsCall!.params[0]).toBe(now - LOG_RETENTION_DAYS * DAY_MS);
  });

  it('cutoff: consent_records は now - 30日、かつ revoked_at IS NOT NULL', async () => {
    const { db, calls } = createMockD1();
    const now = Date.parse('2026-05-07T03:00:00.000Z');
    await runRetention(db, now);

    const consentCall = calls.find((c) => c.sql.toUpperCase().includes('FROM CONSENT_RECORDS'));
    expect(consentCall).toBeDefined();
    expect(consentCall!.sql.toUpperCase()).toContain('REVOKED_AT IS NOT NULL');
    expect(consentCall!.params[0]).toBe(now - REVOKED_CONSENT_RETENTION_DAYS * DAY_MS);
  });

  it('境界値: 89 日前のログは削除されない（cutoff より新しいため）', async () => {
    // SQL の WHERE 句が `received_at < cutoff` であることを保護するための
    // テスト。境界の解釈（89/90/91）を実際の DELETE で確認するのは E2E
    // 側に任せ、ここでは「< が =< になっていないか」だけ固定する。
    const { db, calls } = createMockD1();
    await runRetention(db, Date.now());
    const logsCall = calls.find((c) => c.sql.toUpperCase().includes('FROM JUDGMENT_LOGS'));
    expect(logsCall!.sql).toMatch(/received_at\s*<\s*\?/);
    expect(logsCall!.sql).not.toMatch(/received_at\s*<=\s*\?/);
  });

  it('境界値: 30 日丁度の revoked consent も削除されない（< のみ）', async () => {
    const { db, calls } = createMockD1();
    await runRetention(db, Date.now());
    const consentCall = calls.find((c) => c.sql.toUpperCase().includes('FROM CONSENT_RECORDS'));
    expect(consentCall!.sql).toMatch(/revoked_at\s*<\s*\?/);
    expect(consentCall!.sql).not.toMatch(/revoked_at\s*<=\s*\?/);
  });

  it('戻り値の deletedLogs / deletedRevokedConsent が batch 結果と一致', async () => {
    const { db } = createMockD1({ deletedLogs: 12, deletedConsent: 3 });
    const result = await runRetention(db, Date.now());
    expect(result.deletedLogs).toBe(12);
    expect(result.deletedRevokedConsent).toBe(3);
  });

  it('batch は 2 文（DELETE judgment_logs / DELETE consent_records）を 1 トランザクションで実行', async () => {
    const { db, calls } = createMockD1();
    await runRetention(db, Date.now());
    expect(calls).toHaveLength(2);
    expect(calls[0].sql.toUpperCase()).toContain('DELETE FROM JUDGMENT_LOGS');
    expect(calls[1].sql.toUpperCase()).toContain('DELETE FROM CONSENT_RECORDS');
  });
});
