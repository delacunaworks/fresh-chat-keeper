/**
 * POST /v1/ingest の統合テスト。
 *
 * 検証範囲:
 * - 200（正常 1 件 / 50 件）
 * - 401（token なし / 形式不正）
 * - 410（consent_version 不一致）
 * - 413（51 件超過）
 * - 422（body 不正 / log validation）
 * - 429（rate limit、KV モック）
 *
 * 戦略:
 * - workerModule.fetch を直接呼び出す統合テスト
 * - D1 / KV はインメモリモックで再現
 * - Anthropic API 等の外部依存はそもそも本 API には不要
 */

import { describe, it, expect, beforeEach } from 'vitest';
import workerModule from '../src/index.js';
import type { SpoilerJudgmentLog } from '@fresh-chat-keeper/shared';

// ─── テスト用 D1 / KV モック ─────────────────────────────────

interface FakeRow {
  [key: string]: unknown;
}

/**
 * 最小限の D1 モック。本テストでは insert と consent_versions の SELECT のみ動作すれば良い。
 * judgment_logs テーブルは挿入された行を Map で保持。
 */
function createMockD1(activeConsentVersion: string | null): {
  db: D1Database;
  insertedLogs: FakeRow[];
} {
  const insertedLogs: FakeRow[] = [];

  const prepare = (sql: string): D1PreparedStatement => {
    const trimmed = sql.trim().toUpperCase();
    let boundParams: unknown[] = [];

    const stmt: D1PreparedStatement = {
      bind: (...args: unknown[]) => {
        boundParams = args;
        return stmt;
      },
      first: async <T = unknown>(): Promise<T | null> => {
        if (trimmed.startsWith('SELECT VERSION') || trimmed.includes('FROM CONSENT_VERSIONS')) {
          if (activeConsentVersion === null) return null;
          return {
            version: activeConsentVersion,
            policy_url: 'https://example.com/privacy',
            effective_from: 1700000000000,
            superseded_at: null,
          } as unknown as T;
        }
        return null;
      },
      run: async () => ({
        success: true,
        meta: { changes: 0, last_row_id: 0, duration: 0, rows_read: 0, rows_written: 0, size_after: 0 },
        results: [],
      }) as unknown as D1Response,
      all: async () => ({ results: [], success: true, meta: {} }) as unknown as D1Result,
      raw: async () => [] as unknown as never[],
      // 次の bind 呼び出しのために boundParams を保存
      _boundParams: () => boundParams,
    } as unknown as D1PreparedStatement & { _boundParams: () => unknown[] };

    return stmt;
  };

  const db: D1Database = {
    prepare,
    batch: async <T = unknown>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      // 各 stmt の bind された値を行として保存
      for (const s of stmts) {
        const params = (s as unknown as { _boundParams: () => unknown[] })._boundParams();
        // schema.ts の INSERT_JUDGMENT_LOG_SQL の列順に合わせる
        insertedLogs.push({
          log_id: params[0],
          recorded_at: params[1],
          consent_version: params[2],
          video_id: params[3],
          channel_id: params[4],
          target_body: params[9],
          target_author_channel_id: params[10],
          user_token_hashed: params[28],
          received_at: params[29],
        });
      }
      return stmts.map(() => ({ results: [], success: true, meta: {} }) as unknown as D1Result<T>);
    },
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }) as D1ExecResult,
  } as unknown as D1Database;

  return { db, insertedLogs };
}

function createMockKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv: KVNamespace = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
  return { kv, store };
}

function buildEnv(opts: {
  consentVersion?: string | null;
  rateLimitFails?: boolean;
} = {}) {
  const consentVersion = opts.consentVersion === undefined ? '2026-05-01' : opts.consentVersion;
  const { db, insertedLogs } = createMockD1(consentVersion);

  const consentKv = createMockKV();
  // KV キャッシュに事前投入してすばやく返す
  if (consentVersion !== null) {
    consentKv.store.set('current-consent-version', consentVersion);
  }

  const rateLimitKv = createMockKV();
  if (opts.rateLimitFails) {
    // RATE_LIMIT_MAX = 30 を超える値を仕込む
    const windowKey = Math.floor(Date.now() / 60000);
    rateLimitKv.store.set(`ingest-rl:127.0.0.1:${windowKey}`, '999');
  }

  return {
    env: {
      COLLECTION_DB: db,
      RATE_LIMIT_KV: rateLimitKv.kv,
      CONSENT_KV: consentKv.kv,
      COLLECTION_SALT: 'test-salt-must-be-long-enough',
      ALLOWED_ORIGINS: 'http://localhost:8788,chrome-extension://test',
    },
    insertedLogs,
  };
}

// ─── 有効な SpoilerJudgmentLog の雛形 ───────────────────────

const VALID_TOKEN = '11111111-2222-4333-8444-555555555555';

function buildValidLog(overrides: Partial<SpoilerJudgmentLog> = {}): SpoilerJudgmentLog {
  return {
    logId: '00000000-0000-4000-8000-000000000001',
    recordedAt: '2026-05-01T10:00:00.000Z',
    consentVersion: '2026-05-01',
    videoId: 'dQw4w9WgXcQ',
    channelId: 'UCstreamer',
    gameTitle: 'persona5',
    streamProgressHint: null,
    timeIntoStream: 1234,
    judgmentMode: 'archive_replay',
    targetMessage: {
      body: '主人公が死ぬ',
      authorChannelId: 'UCviewer-plain',
      timestamp: '2026-05-01T09:59:50.000Z',
      isMember: null,
      isModerator: null,
      isVerified: null,
    },
    precedingMessages: [],
    followingMessages: [],
    stageACategory: 'unknown',
    stageAConfidence: null,
    labels: ['spoiler'],
    primaryLabel: 'spoiler',
    confidence: 0.92,
    stage: 'stage2',
    reasonJa: '物語の結末への直接言及',
    labelSource: 'haiku',
    reviewedByHuman: false,
    userFeedback: null,
    extensionVersion: '0.3.5',
    userTokenHashed: '',
    ...overrides,
  };
}

function buildIngestRequest(body: unknown, opts: { token?: string | null } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '127.0.0.1',
  };
  if (opts.token !== null) {
    headers['x-fck-token'] = opts.token ?? VALID_TOKEN;
  }
  return new Request('http://localhost/v1/ingest', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// ─── テスト ────────────────────────────────────────────────

describe('POST /v1/ingest', () => {
  let env: ReturnType<typeof buildEnv>;

  beforeEach(() => {
    env = buildEnv();
  });

  it('200: 正常な 1 件のログを受け入れる', async () => {
    const log = buildValidLog();
    const req = buildIngestRequest({ consentVersion: '2026-05-01', logs: [log] });
    const res = await workerModule.fetch(req, env.env as never);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: number; rejected: number; currentConsentVersion: string };
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);
    expect(body.currentConsentVersion).toBe('2026-05-01');
    expect(env.insertedLogs).toHaveLength(1);
    // ハッシュ化されていること（平文 'UCviewer-plain' ではない）
    expect(env.insertedLogs[0].target_author_channel_id).not.toBe('UCviewer-plain');
    expect(typeof env.insertedLogs[0].target_author_channel_id).toBe('string');
    expect((env.insertedLogs[0].target_author_channel_id as string)).toMatch(/^[0-9a-f]{40}$/);
    // userTokenHashed もハッシュ化されていること
    expect(env.insertedLogs[0].user_token_hashed).toMatch(/^[0-9a-f]{40}$/);
    expect(env.insertedLogs[0].user_token_hashed).not.toBe(VALID_TOKEN);
  });

  it('200: 50 件ちょうどのバッチを受け入れる', async () => {
    const logs = Array.from({ length: 50 }, (_, i) =>
      buildValidLog({ logId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    );
    const req = buildIngestRequest({ consentVersion: '2026-05-01', logs });
    const res = await workerModule.fetch(req, env.env as never);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: number };
    expect(body.accepted).toBe(50);
    expect(env.insertedLogs).toHaveLength(50);
  });

  it('413: 51 件以上のバッチを拒否する', async () => {
    const logs = Array.from({ length: 51 }, (_, i) =>
      buildValidLog({ logId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    );
    const req = buildIngestRequest({ consentVersion: '2026-05-01', logs });
    const res = await workerModule.fetch(req, env.env as never);

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('50');
    expect(env.insertedLogs).toHaveLength(0);
  });

  it('422: logs が空配列', async () => {
    const req = buildIngestRequest({ consentVersion: '2026-05-01', logs: [] });
    const res = await workerModule.fetch(req, env.env as never);

    expect(res.status).toBe(422);
    expect(env.insertedLogs).toHaveLength(0);
  });

  it('422: log のフィールドが不正（labels に不正値）', async () => {
    const log = { ...buildValidLog(), labels: ['unknown_label'] };
    const req = buildIngestRequest({ consentVersion: '2026-05-01', logs: [log] });
    const res = await workerModule.fetch(req, env.env as never);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('labels');
  });

  it('422: log の judgmentMode が不正', async () => {
    const log = buildValidLog();
    // @ts-expect-error: わざと不正な値を投入
    log.judgmentMode = 'invalid_mode';
    const req = buildIngestRequest({ consentVersion: '2026-05-01', logs: [log] });
    const res = await workerModule.fetch(req, env.env as never);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('judgmentMode');
  });

  it('410: consentVersion がサーバー現行版と不一致', async () => {
    const log = buildValidLog();
    const req = buildIngestRequest({ consentVersion: '2026-04-01', logs: [log] });
    const res = await workerModule.fetch(req, env.env as never);

    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; currentConsentVersion: string };
    expect(body.error).toBe('consent_version_mismatch');
    expect(body.currentConsentVersion).toBe('2026-05-01');
    expect(env.insertedLogs).toHaveLength(0);
  });

  it('401: x-fck-token ヘッダなし', async () => {
    const log = buildValidLog();
    const req = buildIngestRequest({ consentVersion: '2026-05-01', logs: [log] }, { token: null });
    const res = await workerModule.fetch(req, env.env as never);

    expect(res.status).toBe(401);
    expect(env.insertedLogs).toHaveLength(0);
  });

  it('401: x-fck-token が UUID 形式でない', async () => {
    const log = buildValidLog();
    const req = buildIngestRequest(
      { consentVersion: '2026-05-01', logs: [log] },
      { token: 'not-a-uuid' },
    );
    const res = await workerModule.fetch(req, env.env as never);

    expect(res.status).toBe(401);
    expect(env.insertedLogs).toHaveLength(0);
  });

  it('429: rate limit 超過', async () => {
    const limitedEnv = buildEnv({ rateLimitFails: true });
    const log = buildValidLog();
    const req = buildIngestRequest({ consentVersion: '2026-05-01', logs: [log] });
    const res = await workerModule.fetch(req, limitedEnv.env as never);

    expect(res.status).toBe(429);
    expect(limitedEnv.insertedLogs).toHaveLength(0);
  });

  it('400: body が JSON でない', async () => {
    const req = new Request('http://localhost/v1/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '127.0.0.1',
        'x-fck-token': VALID_TOKEN,
      },
      body: 'not-json',
    });
    const res = await workerModule.fetch(req, env.env as never);

    expect(res.status).toBe(400);
  });

  it('503: consent_versions テーブルに有効な行がない（DEPLOY-01 未実行）', async () => {
    const noConsentEnv = buildEnv({ consentVersion: null });
    const log = buildValidLog();
    const req = buildIngestRequest({ consentVersion: '2026-05-01', logs: [log] });
    const res = await workerModule.fetch(req, noConsentEnv.env as never);

    expect(res.status).toBe(503);
  });

  it('レスポンスの currentConsentVersion がサーバー版を反映する', async () => {
    const log = buildValidLog();
    const req = buildIngestRequest({ consentVersion: '2026-05-01', logs: [log] });
    const res = await workerModule.fetch(req, env.env as never);
    const body = (await res.json()) as { currentConsentVersion: string };
    expect(body.currentConsentVersion).toBe('2026-05-01');
  });
});
