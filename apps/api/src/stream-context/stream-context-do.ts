/**
 * StreamContextDO — 配信(video_id)単位の音声文脈 Durable Object（Phase 7 / P7-B3）。
 *
 * **役割**: video_id を name にした singleton（`idFromName(videoId)`）。配信単位で
 * 文字起こし segment（当面は DOM 字幕、将来 Scribe v2）を蓄積し、N 分ごとに
 * 要約して判定 prompt に供給するための「器」。
 *
 * **本タスク（P7-B3）のスコープ = 器＋配線まで**:
 * - appendCaptions: segment を DO storage に蓄積（プルーニング付き）+ alarm 設定
 * - alarm: 雛形のみ（次回 alarm の再設定 + 粗プルーニング）。L1/L2 要約本体は P7-B4。
 * - getRecentSummary: 現時点の { whole?, recent?, verbatim? } を返す
 *   （B4 まで whole/recent は undefined、verbatim は直近 segment から構築）。
 *
 * **設計上の注意**:
 * - `cloudflare:workers` を import せず（`extends DurableObject` を使わない）、
 *   public メソッド + `fetch()` ディスパッチで構成する。これにより plain node の
 *   vitest からクラスを直接 import して unit テストできる（既存 api テストの作法）。
 *   endpoint からは stub.fetch(内部 Request) 経由で RPC する。
 * - storage は DO の KV スタイル storage API（structured-clone 値をそのまま保存）。
 *
 * 設計 ground truth: dev-docs/phase-7-asr-audio-context.md §2, §5
 */

import type { Env } from '../env.js';
import {
  AnthropicProvider,
  getSummaryModel,
  buildL1Prompt,
  buildL2Prompt,
  type LLMProvider,
  type LLMRequest,
} from '@fresh-chat-keeper/judgment-engine';

/** 文字起こし segment。`t` は配信開始からの秒数（呼び出し側＝拡張が付与）。 */
export interface CaptionSegment {
  /** 文字起こしテキスト（漢字のまま。かな正規化しない方針）。 */
  text: string;
  /** 配信開始からの経過秒数。プルーニング・窓抽出の基準。 */
  t: number;
}

/**
 * getRecentSummary の戻り。Phase 5 の `streamSummary?: { whole?, recent? }` 拡張に
 * 対応しつつ、L0 逐語（verbatim）も同梱する。
 * - whole:    L2 全体累積要約（P7-B4 で実装。それまで undefined）
 * - recent:   L1 近傍要約（P7-B4 で実装。それまで undefined）
 * - verbatim: L0 直近の逐語（要約しない）。直近 segment から構築。
 */
export interface StreamContextSummary {
  whole?: string;
  recent?: string;
  verbatim?: string;
}

// ─── チューニング定数 ───────────────────────────────────────────

/** storage キー: 蓄積中の segment 配列。 */
const KEY_SEGMENTS = 'segments';

/** 保持する最大 segment 件数（メモリ・storage 肥大の上限）。 */
const MAX_SEGMENTS = 600;

/** 最新 t からこの秒数より古い segment は落とす（L0+L1 窓に十分な余裕）。 */
const RETENTION_SECONDS = 15 * 60;

/** verbatim（L0 逐語）として最新 t から遡って拾う秒数。 */
const L0_VERBATIM_SECONDS = 120;

/** verbatim 連結テキストの文字数上限（prompt 第3ブロックは小さく保つ）。 */
const MAX_VERBATIM_CHARS = 2000;

/** 要約 alarm の間隔（5〜10 分の中央。要約周期）。 */
const ALARM_INTERVAL_MS = 7 * 60 * 1000;

/** storage キー: L1 近傍要約。 */
const KEY_L1 = 'l1_recent';
/** storage キー: L2 全体累積要約。 */
const KEY_L2 = 'l2_whole';
/** storage キー: 最後に要約した segment の t（同じ窓の再要約を防ぐマーカー）。 */
const KEY_SUMMARIZED_T = 'summarized_t';
/** L2 累積要約の storage 保存時ハード上限（プロンプトは §400 字目安。これは安全網）。 */
const MAX_L2_CHARS = 1500;
/** 要約モデルに渡す窓テキストの最大文字数（過大入力の抑制。超過時は新しい側を残す）。 */
const MAX_WINDOW_CHARS = 4000;

/**
 * StreamContextDO 本体。
 *
 * Cloudflare は `(state, env)` で各 DO instance を構築する。
 */
export class StreamContextDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  /** 要約に使う LLMProvider。テストから差し替え可（未指定なら env から遅延生成）。 */
  private readonly injectedSummaryProvider: LLMProvider | null;

  constructor(state: DurableObjectState, env: Env, summaryProvider?: LLMProvider) {
    this.state = state;
    this.env = env;
    // Cloudflare は本番で (state, env) のみで構築する。summaryProvider はテスト用の
    // 注入シーム（実通信を避ける）。本番は getSummaryProvider が env から構築する。
    this.injectedSummaryProvider = summaryProvider ?? null;
  }

  /**
   * 要約用 LLMProvider を返す。注入があればそれ、無ければ env の ANTHROPIC_API_KEY から
   * AnthropicProvider を構築する（Gemini 差し替えは P7-B-Gemini）。
   */
  private getSummaryProvider(): LLMProvider {
    if (this.injectedSummaryProvider) return this.injectedSummaryProvider;
    return new AnthropicProvider({ apiKey: this.env.ANTHROPIC_API_KEY });
  }

  /**
   * 直近の文字起こし segment を蓄積する。
   * - 既存配列に concat → プルーニング → 保存。
   * - alarm 未設定なら次回 alarm をセット（要約周期の起点）。
   */
  async appendCaptions(incoming: CaptionSegment[]): Promise<void> {
    if (incoming.length === 0) return;

    const existing = (await this.state.storage.get<CaptionSegment[]>(KEY_SEGMENTS)) ?? [];
    const pruned = pruneSegments(existing.concat(incoming));
    await this.state.storage.put(KEY_SEGMENTS, pruned);

    // alarm 未設定時のみセット（既設定なら多重設定しない）。
    const current = await this.state.storage.getAlarm();
    if (current === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /**
   * 現時点の音声文脈サマリを返す。
   * B4 まで whole/recent は undefined。verbatim は直近 segment から構築する。
   */
  async getRecentSummary(): Promise<StreamContextSummary> {
    const [segments, l1, l2] = await Promise.all([
      this.state.storage.get<CaptionSegment[]>(KEY_SEGMENTS),
      this.state.storage.get<string>(KEY_L1),
      this.state.storage.get<string>(KEY_L2),
    ]);
    const verbatim = buildVerbatim(segments ?? []);
    const summary: StreamContextSummary = {};
    // 空文字は載せない（prompt-builder の「あれば 1 行足す」分岐に合わせる）。
    if (l2 && l2.length > 0) summary.whole = l2; // L2 全体累積
    if (l1 && l1.length > 0) summary.recent = l1; // L1 近傍
    if (verbatim.length > 0) summary.verbatim = verbatim; // L0 逐語
    return summary;
  }

  /**
   * alarm ハンドラ（P7-B4）。
   *
   * 前回要約マーカー超の新規 segment 窓を要約モデルで L1 に圧縮し、L1 + 既存 L2 を
   * 畳み込んで L2 を更新する。新規窓が無ければ要約はスキップ。最後に B3 同様の
   * プルーニング + 次 alarm 再設定を行う（蓄積が続く限り要約周期を回す）。
   *
   * **未実装（後続）**: ゲーム KB 固有名詞補正（P7-B4.5）/ Gemini 差し替え（P7-B-Gemini）。
   */
  async alarm(): Promise<void> {
    const segments = (await this.state.storage.get<CaptionSegment[]>(KEY_SEGMENTS)) ?? [];

    if (segments.length === 0) {
      // 蓄積なし（配信終了/長い無音）→ 次 alarm を張らず idle 化（B3 挙動）。
      return;
    }

    // 前回要約マーカー超の新規 segment だけを要約対象にする（同じ窓の再要約を避ける）。
    const lastSummarizedT =
      (await this.state.storage.get<number>(KEY_SUMMARIZED_T)) ?? Number.NEGATIVE_INFINITY;
    const newSegments = segments.filter((s) => s.t > lastSummarizedT);
    if (newSegments.length > 0) {
      // 失敗時は内部で握りつぶし、既存 L1/L2・マーカーを保持する（DO を落とさない）。
      await this.summarizeWindow(newSegments);
    }

    // B3 挙動: プルーニング + 次 alarm 再設定。
    const pruned = pruneSegments(segments);
    if (pruned.length !== segments.length) {
      await this.state.storage.put(KEY_SEGMENTS, pruned);
    }
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  /**
   * 新規窓を要約して L1/L2 を更新する。
   *
   * - L1（近傍要約）生成 → 成功時のみ保存し、再要約マーカーを窓の最新 t に前進。
   * - L2（全体累積）= 既存 L2 + 新 L1 の畳み込み（best-effort）。
   * - LLM 失敗（complete が null / throw / 空応答）は warn して握りつぶし、既存値を
   *   保持して次 alarm に委ねる（complete の契約: HTTP 非2xx→null / network・parse→throw）。
   */
  private async summarizeWindow(newSegments: CaptionSegment[]): Promise<void> {
    const windowText = joinForWindow(newSegments);
    if (windowText.length === 0) return;

    const provider = this.getSummaryProvider();
    const model = getSummaryModel();
    const toRequest = (parts: {
      system: LLMRequest['system'];
      messages: LLMRequest['messages'];
    }): LLMRequest => ({
      model: model.model,
      maxTokens: model.maxTokens,
      temperature: model.temperature,
      system: parts.system,
      messages: parts.messages,
    });

    try {
      // L1: 直近窓の近傍要約。
      const l1res = await provider.complete(toRequest(buildL1Prompt(windowText)));
      if (l1res === null || l1res.text.trim().length === 0) {
        // HTTP 非2xx（null）/ 空応答。既存 L1/L2・マーカーを保持して次 alarm へ。
        console.warn('[fck-api] StreamContextDO: L1 summary unavailable; keeping previous');
        return;
      }
      const l1 = l1res.text.trim();
      await this.state.storage.put(KEY_L1, l1);

      // L1 成功 → 再要約マーカーを今回窓の最新 t へ前進（同じ窓を二度要約しない）。
      const newestT = newSegments.reduce((max, s) => (s.t > max ? s.t : max), newSegments[0].t);
      await this.state.storage.put(KEY_SUMMARIZED_T, newestT);

      // L2: 既存 L2 と新 L1 を畳み込み（best-effort。失敗しても L1 は保存済み）。
      const existingL2 = (await this.state.storage.get<string>(KEY_L2)) ?? null;
      const l2res = await provider.complete(toRequest(buildL2Prompt(existingL2, l1)));
      if (l2res !== null && l2res.text.trim().length > 0) {
        await this.state.storage.put(KEY_L2, capTail(l2res.text.trim(), MAX_L2_CHARS));
      } else {
        console.warn('[fck-api] StreamContextDO: L2 fold unavailable; keeping previous L2');
      }
    } catch (err) {
      // network / JSON パース例外。握りつぶして既存値を保持（DO を落とさない）。
      console.warn(
        `[fck-api] StreamContextDO summary error (kept previous): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * endpoint からの内部 RPC（stub.fetch）ディスパッチ。
   * URL の pathname でメソッドへ振り分ける（host はダミーで良い）。
   */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === 'POST' && pathname === '/append') {
      let body: { segments?: unknown };
      try {
        body = (await request.json()) as { segments?: unknown };
      } catch {
        return jsonResponse({ error: 'invalid JSON' }, 400);
      }
      if (!Array.isArray(body.segments)) {
        return jsonResponse({ error: 'segments must be an array' }, 400);
      }
      // endpoint 側で検証済みだが DO 側でも防御的に型を確定させる。
      const segments = body.segments.filter(isCaptionSegment);
      await this.appendCaptions(segments);
      return jsonResponse({ ok: true, accepted: segments.length }, 200);
    }

    if (request.method === 'GET' && pathname === '/summary') {
      const summary = await this.getRecentSummary();
      return jsonResponse(summary, 200);
    }

    return jsonResponse({ error: 'not found' }, 404);
  }
}

// ─── 内部ヘルパー ───────────────────────────────────────────────

/** segment 配列を「最新 t から RETENTION_SECONDS 以内」かつ「最大 MAX_SEGMENTS 件」に絞る。 */
export function pruneSegments(segments: CaptionSegment[]): CaptionSegment[] {
  if (segments.length === 0) return segments;
  const newestT = segments.reduce((max, s) => (s.t > max ? s.t : max), segments[0].t);
  const cutoff = newestT - RETENTION_SECONDS;
  const recent = segments.filter((s) => s.t >= cutoff);
  // 件数上限は新しい方（末尾）を残す。
  return recent.length > MAX_SEGMENTS ? recent.slice(recent.length - MAX_SEGMENTS) : recent;
}

/** 最新 t から L0_VERBATIM_SECONDS 以内の segment テキストを連結（文字数上限付き）。 */
export function buildVerbatim(segments: CaptionSegment[]): string {
  if (segments.length === 0) return '';
  const newestT = segments.reduce((max, s) => (s.t > max ? s.t : max), segments[0].t);
  const cutoff = newestT - L0_VERBATIM_SECONDS;
  const text = segments
    .filter((s) => s.t >= cutoff)
    .map((s) => s.text.trim())
    .filter((s) => s.length > 0)
    .join(' ');
  // 末尾（新しい側）を優先して上限に収める。
  return text.length > MAX_VERBATIM_CHARS ? text.slice(text.length - MAX_VERBATIM_CHARS) : text;
}

/** 新規窓 segment を要約モデル入力用テキストに連結（最大 MAX_WINDOW_CHARS、新しい側を残す）。 */
export function joinForWindow(segments: CaptionSegment[]): string {
  const text = segments
    .map((s) => s.text.trim())
    .filter((s) => s.length > 0)
    .join(' ');
  return text.length > MAX_WINDOW_CHARS ? text.slice(text.length - MAX_WINDOW_CHARS) : text;
}

/** 文字列を上限に収める（末尾＝新しい側を残す）。 */
export function capTail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

/** unknown が CaptionSegment かを判定（DO 側の防御的ガード）。 */
function isCaptionSegment(v: unknown): v is CaptionSegment {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<CaptionSegment>;
  return typeof s.text === 'string' && typeof s.t === 'number' && Number.isFinite(s.t);
}

/** Response.json 相当（テスト環境の差異を避け明示構築）。 */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── テスト用エクスポート ─────────────────────────────────────
export const __test__ = {
  KEY_SEGMENTS,
  KEY_L1,
  KEY_L2,
  KEY_SUMMARIZED_T,
  MAX_SEGMENTS,
  RETENTION_SECONDS,
  L0_VERBATIM_SECONDS,
  MAX_VERBATIM_CHARS,
  MAX_L2_CHARS,
  MAX_WINDOW_CHARS,
  ALARM_INTERVAL_MS,
  isCaptionSegment,
};
