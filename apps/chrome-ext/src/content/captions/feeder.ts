/**
 * 字幕 feeder（Phase 7 / P7-FEED）。
 *
 * chrome-ext が既に抽出している DOM 字幕（{@link YouTubeCaptionProvider}）を定期的に
 * video_id 単位の StreamContextDO へ POST し、音声文脈パイプラインの**入口**を点火する。
 * 出口（DO 要約 → 判定プロンプト）は B1〜B5 で完成済み。本 feeder はその逆方向。
 *
 * **gating**: `captionContext.enabled === true`（既定 OFF・オプトイン）のときだけ収集・
 * 送信する。OFF の間は collect も flush も即 return（ネットワーク・DOM 走査なし）。
 * gating は `getEnabled()` をライブ参照するので、設定変更に動的追従する。
 *
 * **best-effort**: 送信失敗（!ok / 非200 / 例外）は warn して当該バッチを捨てる
 * （リトライ嵐にしない。字幕は継続的に再生成されるため次バッチで回復する）。判定本線は
 * ブロックしない。
 *
 * **収集方式**: 既存 provider の `getRecentContext(windowSeconds, threshold)`（5 秒メモ化・
 * 品質ゲート・dedupe 済みの窓テキスト + currentTimeSeconds）を 1 tick = 1 segment として
 * 取り込む（t = video.currentTime 秒。captionSignature の 30 秒バケットと整合）。直前送信と
 * 同一テキストは重複として送らない。
 *
 * 設計 ground truth: dev-docs/phase-7-asr-audio-context.md §2, §7（P7-FEED）
 */

import type { AudioContextProvider } from '@fresh-chat-keeper/judgment-engine';
import type { BackgroundFetchResponse } from '@fresh-chat-keeper/shared';
import type { StreamCaptionSegment } from '../collection-client.js';

// ─── チューニング定数 ───────────────────────────────────────────

/** 字幕を 1 件収集する間隔（ms）。 */
export const COLLECT_INTERVAL_MS = 15_000;

/** 蓄積した segment をまとめて POST する間隔（ms）。 */
export const FLUSH_INTERVAL_MS = 60_000;

/** 1 リクエストあたりの最大 segment 件数（endpoint 側 MAX_SEGMENTS_PER_REQUEST と一致）。 */
export const MAX_SEGMENTS_PER_BATCH = 200;

/** segment テキストの最大文字数（endpoint 側 MAX_SEGMENT_TEXT_LENGTH と一致。超過はトリム）。 */
export const MAX_SEGMENT_TEXT_LENGTH = 1000;

/** videoId の形式（endpoint 側 VIDEO_ID_REGEX と一致）。 */
const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/** feeder の依存（テストから全て差し替え可能）。 */
export interface CaptionFeederDeps {
  /** 字幕 provider（getRecentContext のみ使用）。 */
  provider: Pick<AudioContextProvider, 'getRecentContext'>;
  /** captionContext.enabled をライブ参照する（OFF なら収集も送信もしない）。 */
  getEnabled: () => boolean;
  /** 参照窓（秒）。settings.captionContext.windowSeconds を返す想定。 */
  getWindowSeconds: () => number;
  /** useable しきい値。settings.captionContext.qualityThreshold 由来。 */
  getThreshold: () => number;
  /** 配信の video_id（取得不能なら ''）。 */
  getVideoId: () => string;
  /** 送信関数（既定は postStreamCaptions の束縛。テストはモック注入）。 */
  send: (videoId: string, segments: StreamCaptionSegment[]) => Promise<BackgroundFetchResponse>;
  /** 現在時刻（テスト用）。 */
  now?: () => number;
}

/**
 * DOM 字幕を StreamContextDO へ定期送信する feeder。
 *
 * start() で 2 タイマー（collect / flush）を回す。stop() で確実に停止し buffer を
 * クリアする（ページ離脱・モード切替でリークしない）。
 */
export class CaptionFeeder {
  private readonly deps: Required<Pick<CaptionFeederDeps, 'now'>> & CaptionFeederDeps;
  private buffer: StreamCaptionSegment[] = [];
  private lastCollectedText = '';
  private collectTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: CaptionFeederDeps) {
    this.deps = { now: () => Date.now(), ...deps };
  }

  /** collect / flush タイマーを開始する（多重起動は無視）。 */
  start(): void {
    if (this.collectTimer !== null || this.flushTimer !== null) return;
    this.collectTimer = setInterval(() => void this.collectOnce(), COLLECT_INTERVAL_MS);
    this.flushTimer = setInterval(() => void this.flushOnce(), FLUSH_INTERVAL_MS);
  }

  /** タイマー停止 + バッファ破棄（リーク防止）。 */
  stop(): void {
    if (this.collectTimer !== null) {
      clearInterval(this.collectTimer);
      this.collectTimer = null;
    }
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer = [];
    this.lastCollectedText = '';
  }

  /**
   * 1 件収集する。OFF / 品質不足 / 重複 / 空 は skip。
   * buffer が上限に達したら早期 flush する。
   */
  async collectOnce(): Promise<void> {
    if (!this.deps.getEnabled()) return; // OFF: 収集しない

    let ctx;
    try {
      ctx = await this.deps.provider.getRecentContext(
        this.deps.getWindowSeconds(),
        this.deps.getThreshold(),
      );
    } catch {
      return; // provider 例外（拡張リロード等）は無視
    }
    if (!ctx) return; // 品質不足（useable=false）

    const text = ctx.text.trim();
    if (!text) return;
    if (text === this.lastCollectedText) return; // 直前と同一 → 重複送らない
    this.lastCollectedText = text;

    this.buffer.push({
      text: text.length > MAX_SEGMENT_TEXT_LENGTH ? text.slice(0, MAX_SEGMENT_TEXT_LENGTH) : text,
      t: ctx.currentTimeSeconds,
    });

    if (this.buffer.length >= MAX_SEGMENTS_PER_BATCH) {
      await this.flushOnce();
    }
  }

  /**
   * 蓄積した segment を 200 件ずつ POST する。OFF / 空 / videoId 不正は skip。
   * 失敗は warn して当該バッチを捨てる（best-effort・リトライ嵐にしない）。
   */
  async flushOnce(): Promise<void> {
    if (!this.deps.getEnabled()) return; // OFF: 送信しない
    if (this.buffer.length === 0) return;

    const videoId = this.deps.getVideoId();
    if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
      // videoId 取得不能 → 送り先を決められない。バッファは温存し次回に委ねる。
      return;
    }

    // 上限ごとに分割して送る（endpoint は 1 リクエスト最大 200 件）。
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, MAX_SEGMENTS_PER_BATCH);
      try {
        const res = await this.deps.send(videoId, batch);
        if (!res.ok) {
          console.warn(
            `[FreshChatKeeper] caption feed bg-fetch failed (${res.kind}): ${res.message}`,
          );
        } else if (res.status !== 200) {
          console.warn(`[FreshChatKeeper] caption feed HTTP ${res.status}; dropping batch`);
        }
        // 失敗時も batch は splice 済み＝drop（best-effort）。
      } catch (err) {
        console.warn(
          `[FreshChatKeeper] caption feed error (dropping batch): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // ─── テスト用 ───────────────────────────────────────────────────

  /** @internal テスト用: 現在の buffer 件数。 */
  _bufferSize(): number {
    return this.buffer.length;
  }

  /** @internal テスト用: タイマーが動作中か。 */
  _isRunning(): boolean {
    return this.collectTimer !== null || this.flushTimer !== null;
  }
}
