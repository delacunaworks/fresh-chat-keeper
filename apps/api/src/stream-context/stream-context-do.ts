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

// ─── AR-1: アーカイブ transcript（VOD 一括転写）────────────────────
// live rolling（segments/L1/L2）とはキー名前空間を分離する。

/** storage キー: 最後に append した実時間（wall-clock ms）。FIX-IDLE 判定に使う。 */
const KEY_LAST_APPEND_WALL = 'last_append_wall';
/** live rolling の idle 停止しきい値（最終 append からこの実時間経過で alarm を止める）。 */
const IDLE_STOP_MS = 2 * 60 * 60 * 1000; // 2h

/** transcript のバケット幅（秒）。10 分単位で分割保存（DO 1 値 128KiB 制限対応）。 */
const BUCKET_SECONDS = 600;
/** 1 バケット storage 値のバイト上限（128KiB=131072 に対し余裕を取る安全網）。 */
const MAX_BUCKET_BYTES = 120_000;
/** 1 回の alarm で処理する transcript バケット数（Sonnet 呼び出しを分散）。 */
const BUCKETS_PER_ALARM = 4;
/** transcript 要約が未完のときの alarm 再設定間隔（バケットを順次消化する）。 */
const TRANSCRIPT_CATCHUP_MS = 15_000;
/** 1 バケットを要約モデルに渡す際の最大文字数（過大入力の抑制）。 */
const MAX_BUCKET_LLM_CHARS = 8000;

/** storage キー: transcript メタ（bucketSeconds / bucketCount / ingestedAt）。 */
const KEY_TR_META = 'tr:meta';
/** storage キー: transcript 累積要約の進捗（要約済みバケット数）。 */
const KEY_TR_PROGRESS = 'tr:progress';
/** transcript バケット i の segment 配列キー。 */
function bucketKey(i: number): string {
  return `tr:bucket:${i}`;
}
/** transcript バケット 0..i の累積要約キー。 */
function sumKey(i: number): string {
  return `tr:sum:${i}`;
}

/** transcript メタ情報。 */
interface TranscriptMeta {
  bucketSeconds: number;
  bucketCount: number;
  ingestedAt: number;
}

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
    // FIX-IDLE: 最終 append の実時間を記録（配信終了後の idle 停止判定に使う）。
    await this.state.storage.put(KEY_LAST_APPEND_WALL, Date.now());

    // alarm 未設定時のみセット（既設定なら多重設定しない）。
    const current = await this.state.storage.getAlarm();
    if (current === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /**
   * アーカイブ transcript（VOD 全量）を一括取り込みする（AR-1）。
   *
   * - segment を 10 分バケットに振り分け、`tr:bucket:<i>` に分割保存する
   *   （DO の 1 値 128KiB 制限を超えないよう、バケットごとにバイト測定＋トリム）。
   * - meta / progress を初期化し、alarm を張って累積要約の事前計算を開始する。
   *
   * @returns 取り込んだ segment 数とバケット数。
   */
  async ingestTranscript(segments: CaptionSegment[]): Promise<{ accepted: number; buckets: number }> {
    // バケットごとにグルーピング（t < 0 は捨てる）。
    const byBucket = new Map<number, CaptionSegment[]>();
    let maxBucket = -1;
    let accepted = 0;
    for (const s of segments) {
      if (!Number.isFinite(s.t) || s.t < 0) continue;
      const b = Math.floor(s.t / BUCKET_SECONDS);
      const arr = byBucket.get(b);
      if (arr) arr.push(s);
      else byBucket.set(b, [s]);
      if (b > maxBucket) maxBucket = b;
      accepted++;
    }

    // 各バケットを t 昇順で保存（128KiB 安全のためバイト上限でトリム）。
    for (const [b, segs] of byBucket) {
      segs.sort((a, x) => a.t - x.t);
      await this.state.storage.put(bucketKey(b), fitBucketToBytes(segs));
    }

    const bucketCount = maxBucket + 1;
    const meta: TranscriptMeta = {
      bucketSeconds: BUCKET_SECONDS,
      bucketCount,
      ingestedAt: Date.now(),
    };
    await this.state.storage.put(KEY_TR_META, meta);
    // 再取り込み時は進捗を 0 に戻して全バケットを再要約する。
    await this.state.storage.put(KEY_TR_PROGRESS, 0);

    // 累積要約の事前計算を開始する alarm を張る（未設定時のみ）。
    const current = await this.state.storage.getAlarm();
    if (current === null && bucketCount > 0) {
      await this.state.storage.setAlarm(Date.now() + TRANSCRIPT_CATCHUP_MS);
    }
    return { accepted, buckets: bucketCount };
  }

  /**
   * 音声文脈サマリを返す。
   *
   * - `t` なし: 従来の **live rolling**（verbatim=L0 逐語 / recent=L1 / whole=L2）。
   *   transcript は返さない（後方互換。既存 proxy 呼び出しの挙動を一切変えない）。
   * - `t` あり: **アーカイブ transcript の時刻指定取得**（AR-1）。★不変条件: T より
   *   未来の transcript / それを含む累積要約を絶対に返さない（文脈自体がネタバレ源に
   *   なる）。transcript が無ければ空を返す。
   *
   * @param t 視聴者の再生時刻（秒）。省略時は live rolling。
   */
  async getRecentSummary(t?: number): Promise<StreamContextSummary> {
    if (t === undefined) {
      // ── live rolling（従来どおり・不変）─────────────────────────
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

    // ── アーカイブ transcript の時刻指定取得（≤T 厳守）───────────────
    return this.getTranscriptSummaryAt(t);
  }

  /**
   * 再生時刻 T のアーカイブ音声文脈を返す（AR-1）。
   *
   * ★不変条件（最重要）: **T より未来の情報を絶対に返さない**。
   * - `whole`: 「バケット全体が T 以前」かつ計算済みの最大バケットの累積要約のみ。
   * - `verbatim`: transcript segment を `t' <= T` で厳密フィルタした [T-120s, T]。
   */
  private async getTranscriptSummaryAt(t: number): Promise<StreamContextSummary> {
    const meta = await this.state.storage.get<TranscriptMeta>(KEY_TR_META);
    if (!meta) return {}; // transcript 未取り込み → 空（proxy が recentAudio にフォールバック）

    const summary: StreamContextSummary = {};

    // whole: バケット i が「全体 T 以前」= (i+1)*BUCKET <= T ⇔ i <= floor(T/BUCKET)-1。
    // かつ計算済み（progress-1 以下）の最大バケットの累積要約のみ使う（≤T 保証）。
    const maxSafeBucket = Math.floor(t / BUCKET_SECONDS) - 1;
    const progress = (await this.state.storage.get<number>(KEY_TR_PROGRESS)) ?? 0;
    const availBucket = Math.min(maxSafeBucket, progress - 1);
    if (availBucket >= 0) {
      const whole = await this.state.storage.get<string>(sumKey(availBucket));
      if (whole && whole.length > 0) summary.whole = whole;
    }

    // verbatim: [T-120s, T] の逐語。t' <= T を厳密に守る（未来を絶対に含めない）。
    const verbatim = await this.buildTranscriptVerbatim(t);
    if (verbatim.length > 0) summary.verbatim = verbatim;

    // recent（直近バケットの要約）は AR-1 では省略（任意）。
    return summary;
  }

  /** transcript から [T-L0_VERBATIM_SECONDS, T] の逐語を構築する（t' <= T 厳守）。 */
  private async buildTranscriptVerbatim(t: number): Promise<string> {
    const lo = t - L0_VERBATIM_SECONDS;
    const startBucket = Math.max(0, Math.floor(lo / BUCKET_SECONDS));
    const endBucket = Math.floor(t / BUCKET_SECONDS);
    const texts: string[] = [];
    for (let b = startBucket; b <= endBucket; b++) {
      const segs = (await this.state.storage.get<CaptionSegment[]>(bucketKey(b))) ?? [];
      for (const s of segs) {
        // ★ t' <= T の厳密フィルタ（未来を返さない不変条件の核）。
        if (s.t >= lo && s.t <= t) {
          const cleaned = s.text.trim();
          if (cleaned.length > 0) texts.push(cleaned);
        }
      }
    }
    return capTail(texts.join(' '), MAX_VERBATIM_CHARS);
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
    // 1) transcript の累積要約を数バケットずつ事前計算（AR-1）。
    const transcriptMore = await this.processTranscriptBuckets();
    // 2) live rolling の要約（B4）＋ idle 停止判定（FIX-IDLE）。
    const liveActive = await this.processLiveRolling();

    // 3) 残務に応じて次 alarm を張る。transcript 未完なら短間隔で消化、
    //    live のみなら要約周期（7分）、どちらも無ければ張らない（idle 化）。
    if (transcriptMore) {
      await this.state.storage.setAlarm(Date.now() + TRANSCRIPT_CATCHUP_MS);
    } else if (liveActive) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /**
   * transcript バケットの累積要約を最大 BUCKETS_PER_ALARM 件ずつ進める（AR-1）。
   *
   * summaries[i] = バケット 0..i の累積要約（B4 の L2 畳み込みと同じ発想:
   * 前累積 + 新バケット生text → 新累積、文字数 cap）。空バケットは LLM を呼ばず
   * 前累積を carry。**LLM 失敗（null/throw）は progress を進めず break → 次 alarm で
   * 同じバケットを再試行**（B4 のフォールバック方針。DO を落とさない）。
   *
   * @returns まだ未処理バケットが残っていれば true。
   */
  private async processTranscriptBuckets(): Promise<boolean> {
    const meta = await this.state.storage.get<TranscriptMeta>(KEY_TR_META);
    if (!meta || meta.bucketCount <= 0) return false;

    let progress = (await this.state.storage.get<number>(KEY_TR_PROGRESS)) ?? 0;
    if (progress >= meta.bucketCount) return false; // 完了済み

    const provider = this.getSummaryProvider();
    const model = getSummaryModel();

    let processed = 0;
    while (progress < meta.bucketCount && processed < BUCKETS_PER_ALARM) {
      const segs = (await this.state.storage.get<CaptionSegment[]>(bucketKey(progress))) ?? [];
      const prev =
        progress > 0 ? ((await this.state.storage.get<string>(sumKey(progress - 1))) ?? null) : null;

      if (segs.length === 0) {
        // 空バケット → 前累積を carry（LLM 呼ばない＝コストゼロ）。
        await this.state.storage.put(sumKey(progress), prev ?? '');
        progress++;
        processed++;
        continue;
      }

      // バケット生text を連結（MAX_BUCKET_LLM_CHARS で cap。末尾＝新しい側を残す）。
      const bucketText = capTail(
        segs
          .map((s) => s.text.trim())
          .filter((x) => x.length > 0)
          .join(' '),
        MAX_BUCKET_LLM_CHARS,
      );
      const req = summaryRequest(model, buildL2Prompt(prev, bucketText));

      let res: Awaited<ReturnType<LLMProvider['complete']>>;
      try {
        res = await provider.complete(req);
      } catch (err) {
        // network / parse 例外 → progress を進めず中断。次 alarm で同バケット再試行。
        console.warn(
          `[fck-api] StreamContextDO transcript summary error at bucket ${progress} (retry next alarm): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        break;
      }
      if (res === null || res.text.trim().length === 0) {
        // HTTP 非2xx（null）/ 空応答 → progress 据置で再試行。
        console.warn(
          `[fck-api] StreamContextDO transcript summary unavailable at bucket ${progress}; retry next alarm`,
        );
        break;
      }

      await this.state.storage.put(sumKey(progress), capTail(res.text.trim(), MAX_L2_CHARS));
      progress++;
      processed++;
    }

    await this.state.storage.put(KEY_TR_PROGRESS, progress);
    return progress < meta.bucketCount;
  }

  /**
   * live rolling の要約（B4）＋ idle 停止判定（FIX-IDLE）。
   *
   * @returns live alarm を維持すべきなら true（segments があり idle でない）。
   */
  private async processLiveRolling(): Promise<boolean> {
    const segments = (await this.state.storage.get<CaptionSegment[]>(KEY_SEGMENTS)) ?? [];
    if (segments.length === 0) return false; // 蓄積なし → idle（B3 挙動）

    // FIX-IDLE: プルーニングは「最新 t からの相対」基準のため配信終了後も segment が
    // 残り alarm が永久再発火する。最終 append の実時間（wall-clock）で idle 判定する。
    const lastAppendWall = (await this.state.storage.get<number>(KEY_LAST_APPEND_WALL)) ?? 0;
    if (lastAppendWall > 0 && Date.now() - lastAppendWall > IDLE_STOP_MS) {
      // 最終 append から IDLE_STOP_MS 超 → alarm を止める（segments は残す）。
      return false;
    }

    // 前回要約マーカー超の新規 segment だけを要約対象にする（同じ窓の再要約を避ける）。
    const lastSummarizedT =
      (await this.state.storage.get<number>(KEY_SUMMARIZED_T)) ?? Number.NEGATIVE_INFINITY;
    const newSegments = segments.filter((s) => s.t > lastSummarizedT);
    if (newSegments.length > 0) {
      // 失敗時は内部で握りつぶし、既存 L1/L2・マーカーを保持する（DO を落とさない）。
      await this.summarizeWindow(newSegments);
    }

    // B3 挙動: プルーニング。
    const pruned = pruneSegments(segments);
    if (pruned.length !== segments.length) {
      await this.state.storage.put(KEY_SEGMENTS, pruned);
    }
    return true; // live alarm を維持
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

    try {
      // L1: 直近窓の近傍要約。
      const l1res = await provider.complete(summaryRequest(model, buildL1Prompt(windowText)));
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
      const l2res = await provider.complete(summaryRequest(model, buildL2Prompt(existingL2, l1)));
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

    if (request.method === 'POST' && pathname === '/ingest-transcript') {
      let body: { segments?: unknown };
      try {
        body = (await request.json()) as { segments?: unknown };
      } catch {
        return jsonResponse({ error: 'invalid JSON' }, 400);
      }
      if (!Array.isArray(body.segments)) {
        return jsonResponse({ error: 'segments must be an array' }, 400);
      }
      const segments = body.segments.filter(isCaptionSegment);
      const result = await this.ingestTranscript(segments);
      return jsonResponse({ ok: true, ...result }, 200);
    }

    if (request.method === 'GET' && pathname === '/summary') {
      // t クエリ（あれば）で transcript の時刻指定取得。無ければ live rolling。
      const tRaw = new URL(request.url).searchParams.get('t');
      let t: number | undefined;
      if (tRaw !== null) {
        const parsed = Number(tRaw);
        if (Number.isFinite(parsed) && parsed >= 0) t = parsed;
      }
      const summary = await this.getRecentSummary(t);
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

/** ModelConfig + プロンプト parts から LLMRequest を組む（要約経路の共通化）。 */
function summaryRequest(
  model: { model: string; maxTokens: number; temperature: number },
  parts: { system: LLMRequest['system']; messages: LLMRequest['messages'] },
): LLMRequest {
  return {
    model: model.model,
    maxTokens: model.maxTokens,
    temperature: model.temperature,
    system: parts.system,
    messages: parts.messages,
  };
}

/** segment 配列を JSON 化したときの UTF-8 バイト長。 */
function byteLen(segs: CaptionSegment[]): number {
  return new TextEncoder().encode(JSON.stringify(segs)).length;
}

/**
 * バケットの segment 配列を storage 1 値上限（MAX_BUCKET_BYTES）に収める（AR-1・128KiB 安全網）。
 *
 * 通常の 10 分バケットは数KB で発火しないが、病的に密な入力に対する防御。超過時は
 * 末尾（新しい側）の segment を比例的にトリムして収める（データ欠落は warn）。
 */
export function fitBucketToBytes(segs: CaptionSegment[]): CaptionSegment[] {
  let arr = segs;
  let bytes = byteLen(arr);
  if (bytes <= MAX_BUCKET_BYTES) return arr;
  while (arr.length > 1 && bytes > MAX_BUCKET_BYTES) {
    // 現バイト数から収まる件数を推定して 95% にスライス（数回で収束）。
    const ratio = MAX_BUCKET_BYTES / bytes;
    const target = Math.max(1, Math.floor(arr.length * ratio * 0.95));
    arr = arr.slice(0, target);
    bytes = byteLen(arr);
  }
  console.warn(
    `[fck-api] StreamContextDO transcript bucket trimmed to ${arr.length}/${segs.length} segments (128KiB safety)`,
  );
  return arr;
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
  KEY_LAST_APPEND_WALL,
  MAX_SEGMENTS,
  RETENTION_SECONDS,
  L0_VERBATIM_SECONDS,
  MAX_VERBATIM_CHARS,
  MAX_L2_CHARS,
  MAX_WINDOW_CHARS,
  ALARM_INTERVAL_MS,
  IDLE_STOP_MS,
  BUCKET_SECONDS,
  MAX_BUCKET_BYTES,
  BUCKETS_PER_ALARM,
  TRANSCRIPT_CATCHUP_MS,
  KEY_TR_META,
  KEY_TR_PROGRESS,
  bucketKey,
  sumKey,
  isCaptionSegment,
};
