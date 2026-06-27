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

/** 要約 alarm の間隔（5〜10 分の中央。B4 で要約周期として本格使用）。 */
const ALARM_INTERVAL_MS = 7 * 60 * 1000;

/**
 * StreamContextDO 本体。
 *
 * Cloudflare は `(state, env)` で各 DO instance を構築する。
 */
export class StreamContextDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // env は P7-B4 で要約モデル（LLMProvider 経由）呼び出しに使う。現状は保持のみ。
    // model-router の `void tier;` と同じく、意図的な未使用を明示する。
    void this.env;
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
    const segments = (await this.state.storage.get<CaptionSegment[]>(KEY_SEGMENTS)) ?? [];
    const verbatim = buildVerbatim(segments);
    const summary: StreamContextSummary = {};
    // 空文字は載せない（prompt-builder の「あれば 1 行足す」分岐に合わせる）。
    if (verbatim.length > 0) summary.verbatim = verbatim;
    // whole / recent は P7-B4 で要約モデルが埋める。今は undefined のまま。
    return summary;
  }

  /**
   * alarm ハンドラ（雛形）。
   *
   * **P7-B4 で実装予定**: 直近窓を要約モデル（LLMProvider 経由）で L1 に圧縮し、
   * L1 + 既存 L2 を畳み込んで L2 を再生成、ゲーム KB で固有名詞補正する。
   *
   * 現状（P7-B3）は LLM を呼ばず、蓄積 segment の粗プルーニングのみ行い、
   * 蓄積が続いている限り次回 alarm を再設定する（空なら DO を idle 化）。
   */
  async alarm(): Promise<void> {
    const segments = (await this.state.storage.get<CaptionSegment[]>(KEY_SEGMENTS)) ?? [];

    // TODO(P7-B4): ここで L1/L2 要約を生成し storage に保存する
    // （要約モデルを env 経由の LLMProvider で呼ぶ。getRecentSummary が返す
    //  whole/recent を埋める）。今は no-op に近い最小処理。

    if (segments.length === 0) {
      // 蓄積なし（配信終了/長い無音）→ 次 alarm を張らず idle 化。
      return;
    }

    const pruned = pruneSegments(segments);
    if (pruned.length !== segments.length) {
      await this.state.storage.put(KEY_SEGMENTS, pruned);
    }
    // 蓄積が続く限り要約周期を回し続ける（B4 で要約生成のトリガになる）。
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
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
  MAX_SEGMENTS,
  RETENTION_SECONDS,
  L0_VERBATIM_SECONDS,
  MAX_VERBATIM_CHARS,
  ALARM_INTERVAL_MS,
  isCaptionSegment,
};
