/**
 * P3-TEST-01: マルチラベルプロンプト品質テスト。
 *
 * 設計 ground truth: `dev-docs/phase-3-multilabel.md`「テスト戦略 / LLM判定の
 * 品質テスト」「完了判定基準（品質面: 品質テスト85%以上）」。
 *
 * 2 層構成:
 *  1. 構造健全性（**常時 CI 実行**）— フィクスチャが 100 件以上・全 6 ラベルを
 *     被覆・各カテゴリに十分なサンプル数・スキーマ妥当。判定精度の前提条件を
 *     決定論的に保証する。
 *  2. 実 LLM 精度（**既定スキップ / ゲート実行**）— `FCK_LLM_QUALITY=1` かつ
 *     `ANTHROPIC_API_KEY` 設定時のみ Anthropic を実呼び出しし、buildSystemPrompt
 *     / buildUserPrompt → 応答パース → `primary` 一致率を計測。全体 85% 以上 +
 *     カテゴリ別精度を出力。CI を重く/不安定にしないためゲート式
 *     （実 API はローカル手動 or 専用ジョブ）。
 *
 * カテゴリフィルタ/データ分類の **判定精度の本担保はこのテスト**
 * （実機で該当コメントに遭遇する運任せ確認は廃止。設計正本「検証分担の確定」）。
 */

import { describe, it, expect } from 'vitest';
import type { JudgmentLabel, FilterSettings } from '@fresh-chat-keeper/shared';
import type { JudgmentContext } from '../../src/types.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
} from '../../src/stage2/prompt-builder.js';
import { LABEL_PRECEDENCE } from '../../src/stage2/label-precedence.js';
import { QUALITY_FIXTURES } from './prompt-quality.fixtures.js';

const ALL_LABELS = LABEL_PRECEDENCE as readonly JudgmentLabel[];

// ─── 1. 構造健全性（常時実行）──────────────────────────────────
describe('P3-TEST-01 フィクスチャ構造健全性', () => {
  it('フィクスチャは 100 件以上', () => {
    expect(QUALITY_FIXTURES.length).toBeGreaterThanOrEqual(100);
  });

  it('全フィクスチャの comment は非空文字・expectedPrimary は有効ラベル', () => {
    for (const f of QUALITY_FIXTURES) {
      expect(typeof f.comment).toBe('string');
      expect(f.comment.trim().length).toBeGreaterThan(0);
      expect(ALL_LABELS).toContain(f.expectedPrimary);
    }
  });

  it('6 ラベルすべてが期待 primary として出現する', () => {
    const present = new Set(QUALITY_FIXTURES.map((f) => f.expectedPrimary));
    for (const label of ALL_LABELS) {
      expect(present.has(label)).toBe(true);
    }
  });

  it('非 safe カテゴリは各 8 件以上（カテゴリ別精度が意味を持つ最小数）', () => {
    const counts: Record<string, number> = {};
    for (const f of QUALITY_FIXTURES) {
      counts[f.expectedPrimary] = (counts[f.expectedPrimary] ?? 0) + 1;
    }
    for (const label of ALL_LABELS) {
      if (label === 'safe') {
        expect(counts.safe ?? 0).toBeGreaterThanOrEqual(20);
      } else {
        expect(counts[label] ?? 0).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('VTuber 文化 / コール&レスポンス / マルチラベルのサブセットを含む', () => {
    const hasTag = (t: string) =>
      QUALITY_FIXTURES.some((f) => f.tags?.includes(t as never));
    expect(hasTag('vtuber')).toBe(true);
    expect(hasTag('call_and_response')).toBe(true);
    expect(hasTag('multilabel')).toBe(true);
  });

  it('プロンプトビルダーが全フィクスチャを 1 リクエストの user prompt に詰められる', () => {
    const sys = buildSystemPrompt(buildQualityContext(), {
      supportsCaching: false,
    });
    expect(sys.length).toBeGreaterThan(0);
    const user = buildUserPrompt(
      QUALITY_FIXTURES.map((f, i) => ({ id: String(i), text: f.comment })),
    );
    expect(user).toContain(QUALITY_FIXTURES[0].comment);
    expect(user.length).toBeGreaterThan(0);
  });
});

/**
 * 全カテゴリ ON・**全カテゴリ strict** の v3 設定で品質計測コンテキストを作る。
 *
 * P3-TEST-01 は「LLM がコメントを正しいカテゴリに**分類できるか**」の品質
 * 指標。`strength` は本来ユーザー向けの verdict ゲート（standard だと
 * off_topic は『他配信者言及のみ』、spoiler は『攻略ヒントは safe』等）で
 * あり、分類能力の指標としては strict（カテゴリ定義どおりの最大リコール）
 * で測るのが正しい。standard で測ると一般的な雑談 off_topic がプロンプト
 * 定義どおり safe 化し、フィクスチャ（真の off_topic）と構造的に一致
 * しなくなる（フィクスチャを実出力に寄せる行為とは異なる、ハーネス側の
 * 測定条件の是正）。
 */
function buildQualityContext(): JudgmentContext {
  const settings: FilterSettings = {
    version: 3,
    enabled: true,
    displayMode: 'placeholder',
    filterMode: 'archive',
    categories: {
      spoiler: { enabled: true, strength: 'strict' },
      harassment: { enabled: true, strength: 'strict' },
      spam: { enabled: true },
      offTopic: { enabled: true, strength: 'strict' },
      backseat: { enabled: true, strength: 'strict' },
    },
    customBlockWords: [],
    userTier: 'free',
    triggerVisibility: 'hover_only',
  };
  return { settings };
}

// ─── 2. 実 LLM 精度（ゲート実行）────────────────────────────────
const RUN_LLM =
  process.env.FCK_LLM_QUALITY === '1' && !!process.env.ANTHROPIC_API_KEY;
const QUALITY_MODEL = 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 25;
const ACCURACY_THRESHOLD = 0.85;
/**
 * B6c: 非決定 LLM の run ガチャを排除するため複数 run の**最低値**で判定する。
 * 既定 5。コスト調整用に FCK_LLM_QUALITY_RUNS で上書き可能（1 以上）。
 */
const QUALITY_RUNS = Math.max(
  1,
  Number.parseInt(process.env.FCK_LLM_QUALITY_RUNS ?? '5', 10) || 5,
);

/** 応答テキストから JSON 配列を抽出して messageId→primary を作る。 */
function parsePrimaries(rawText: string): Map<string, string> {
  const m = rawText.match(/\[[\s\S]*\]/);
  const out = new Map<string, string>();
  if (!m) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const e of parsed) {
    if (e && typeof e === 'object') {
      const id = (e as Record<string, unknown>).messageId;
      const primary = (e as Record<string, unknown>).primary;
      if (typeof id === 'string' && typeof primary === 'string') {
        out.set(id, primary);
      }
    }
  }
  return out;
}

async function callAnthropic(
  systemBlocks: { text: string }[],
  userPrompt: string,
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: QUALITY_MODEL,
      max_tokens: 4096,
      system: systemBlocks.map((b) => ({ type: 'text', text: b.text })),
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { content?: Array<{ text?: string }> };
  return json.content?.[0]?.text ?? '';
}

/** 1 run（全フィクスチャをバッチ送信）の overall・カテゴリ別精度を返す。 */
async function measureOnce(): Promise<{
  overall: number;
  perCat: Record<string, { ok: number; total: number }>;
}> {
  const sys = buildSystemPrompt(buildQualityContext(), {
    supportsCaching: false,
  });
  const predicted = new Map<string, string>();
  for (let i = 0; i < QUALITY_FIXTURES.length; i += BATCH_SIZE) {
    const batch = QUALITY_FIXTURES.slice(i, i + BATCH_SIZE).map((f, j) => ({
      id: String(i + j),
      text: f.comment,
    }));
    const text = await callAnthropic(sys, buildUserPrompt(batch));
    for (const [id, primary] of parsePrimaries(text)) {
      predicted.set(id, primary);
    }
  }
  const perCat: Record<string, { ok: number; total: number }> = {};
  let ok = 0;
  QUALITY_FIXTURES.forEach((f, i) => {
    const exp = f.expectedPrimary;
    perCat[exp] ??= { ok: 0, total: 0 };
    perCat[exp].total++;
    if (predicted.get(String(i)) === exp) {
      ok++;
      perCat[exp].ok++;
    }
  });
  return { overall: ok / QUALITY_FIXTURES.length, perCat };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe.runIf(RUN_LLM)('P3-TEST-01 実 LLM マルチラベル精度（複数 run 最低値）', () => {
  it(
    `${QUALITY_RUNS} run 最低値で overall・各カテゴリ ${ACCURACY_THRESHOLD * 100}% 以上`,
    async () => {
      // B6c: 非決定 LLM の run ガチャ排除。QUALITY_RUNS 回計測し、
      // overall・各カテゴリの **run をまたいだ最低値** で ≥85% を assert する。
      const cats = new Set<string>();
      const overallByRun: number[] = [];
      const catAccByRun: Record<string, number[]> = {};

      for (let r = 0; r < QUALITY_RUNS; r++) {
        const { overall, perCat } = await measureOnce();
        overallByRun.push(overall);
        const lines: string[] = [];
        for (const [cat, s] of Object.entries(perCat)) {
          cats.add(cat);
          const acc = s.ok / s.total;
          (catAccByRun[cat] ??= []).push(acc);
          lines.push(`  ${cat}: ${s.ok}/${s.total} (${(acc * 100).toFixed(1)}%)`);
        }
        // eslint-disable-next-line no-console
        console.log(
          `[P3-TEST-01 run ${r + 1}/${QUALITY_RUNS}] overall ${(overall * 100).toFixed(1)}%\n${lines.join('\n')}`,
        );
      }

      const overallMin = Math.min(...overallByRun);
      // eslint-disable-next-line no-console
      console.log(
        `[P3-TEST-01 SUMMARY ${QUALITY_RUNS} runs] overall min ${(overallMin * 100).toFixed(1)}% / median ${(median(overallByRun) * 100).toFixed(1)}%`,
      );
      for (const cat of cats) {
        const accs = catAccByRun[cat] ?? [0];
        // eslint-disable-next-line no-console
        console.log(
          `  ${cat}: min ${(Math.min(...accs) * 100).toFixed(1)}% / median ${(median(accs) * 100).toFixed(1)}% (runs: ${accs.map((a) => (a * 100).toFixed(0)).join(',')})`,
        );
      }

      // 最低値ゲート: 「運の良い 1 run」では通さない
      expect(
        overallMin,
        `overall min over ${QUALITY_RUNS} runs`,
      ).toBeGreaterThanOrEqual(ACCURACY_THRESHOLD);
      for (const cat of cats) {
        const accs = catAccByRun[cat] ?? [0];
        expect(
          Math.min(...accs),
          `category "${cat}" min over ${QUALITY_RUNS} runs (runs: ${accs.map((a) => a.toFixed(2)).join(',')})`,
        ).toBeGreaterThanOrEqual(ACCURACY_THRESHOLD);
      }
    },
    // 5 run × ~5 バッチ × ~数十秒。run 数に比例して十分長く取る。
    Math.max(180_000, QUALITY_RUNS * 120_000),
  );
});
