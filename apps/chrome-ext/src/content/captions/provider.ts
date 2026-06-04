/**
 * Phase 5（v0.6.0）YouTube 字幕 DOM 抽出プロバイダ（caption MVP）。
 *
 * 設計 ground truth: `dev-docs/phase-5-audio-context.md`
 *   §「YouTube字幕の取得（アプローチA）」§「課題1/3」§「アーキテクチャレビュー反映」。
 *
 * `AudioContextProvider`（P5-B2、judgment-engine）の最初の実装。`.ytp-caption-window-container`
 * を MutationObserver で監視し、字幕テキスト変化を `CaptionSegment` として収集する。
 *
 * **重要: 字幕 DOM と `<video>` は watch ページ本体（parent frame）にある。**
 * content script は `live_chat_replay` iframe で動くため、`window.parent.document` 経由で
 * 横断アクセスする（author-extract.ts の getChannelIdFromDom と同じ同一 origin 横断）。
 * cross-frame messaging は使わない（MVP の単純さ優先）。
 *
 * 役割分担:
 * - `isAvailable()`: 字幕トラック自体の有無（コンテナの存在）
 * - `getRecentContext()` の null: この瞬間の品質不足（字幕 OFF / 短すぎ）
 * - 5 秒メモ化: 生 DOM の全走査を毎回しない（DOM 走査の節約。**P5-B4a の判定
 *   キャッシュキーとは別物**）
 */

import {
  evaluateCaptionQuality,
  sanitizeCaptionText,
  dedupeRepeatedPhrases,
  collapseRollingPrefixes,
  type AudioContextProvider,
  type CaptionSegment,
  type RecentAudioContext,
} from '@fresh-chat-keeper/judgment-engine';

/** 字幕コンテナのセレクタ（P5-B1 実測で要確認、複数候補を順に試す）。 */
const CAPTION_CONTAINER_SELECTORS = [
  '.ytp-caption-window-container',
  '.caption-window',
] as const;

/**
 * 字幕**テキスト**要素のセレクタ（行レベルのみ）。
 *
 * P5-B5 hotfix: 以前は `.caption-window`（= コンテナ相当）を含めていたため、
 * その textContent に YouTube の設定メニュー文字列（「日本語 (自動生成) を
 * クリックして設定」等）が混入していた。行レベルの実テキスト要素だけに限定し、
 * マッチしなければ「字幕なし（空文字）」とする（コンテナ全体の UI 文字列を拾わない）。
 * `.ytp-caption-segment` は YouTube の標準的な字幕行クラス。
 */
const CAPTION_TEXT_SELECTORS = '.ytp-caption-segment, .captions-text, .caption-visual-line';

/**
 * YouTube 字幕 UI 文字列の denylist（断片に含まれたら ingest しない防御）。
 * 源は CAPTION_TEXT_SELECTORS の行レベル限定で断っているが、念のための二重防御。
 * YouTube 固有なので judgment-engine（純粋層）ではなく provider に置く。
 */
const YT_CAPTION_UI_MARKERS = [
  '自動生成',
  'クリックして設定',
  '字幕を選択',
] as const;

/** 断片が YouTube の字幕 UI 文字列を含むか（含めば発話ではないので捨てる）。 */
function containsCaptionUiString(text: string): boolean {
  return YT_CAPTION_UI_MARKERS.some((m) => text.includes(m));
}

/** リングバッファの保持上限。 */
const MAX_SEGMENT_AGE_MS = 5 * 60 * 1000; // 5 分
const MAX_SEGMENTS = 500;

/** 5 秒メモ化の TTL。 */
const CONTEXT_MEMO_TTL_MS = 5000;

/** ライブ / アーカイブの useable しきい値（設計文書 §課題2: ライブはより厳格）。 */
const LIVE_QUALITY_THRESHOLD = 0.5;
const ARCHIVE_QUALITY_THRESHOLD = 0.4;

interface MemoEntry {
  result: RecentAudioContext | null;
  builtAt: number;
  /** memo を構築したときの windowSeconds（異なる窓長で呼ばれたら再走査）。 */
  windowSeconds: number;
  /** memo を構築したときの useable しきい値（設定変更で異なれば再走査）。 */
  threshold: number;
}

/**
 * YouTube DOM から字幕を抽出する {@link AudioContextProvider} 実装。
 *
 * `mode` で useable しきい値を切り替える（live 0.5 / archive 0.4）。
 * DOM アクセスは parent frame 経由 + try/catch（拡張リロード / cross-origin 保険）。
 */
export class YouTubeCaptionProvider implements AudioContextProvider {
  private segments: CaptionSegment[] = [];
  private observer: MutationObserver | null = null;
  private lastText = '';
  private memo: MemoEntry | null = null;
  private readonly threshold: number;
  /** waitForCaptionContainer のポーリング停止フラグ。 */
  private disposed = false;

  constructor(private readonly mode: 'live' | 'archive') {
    this.threshold = mode === 'live' ? LIVE_QUALITY_THRESHOLD : ARCHIVE_QUALITY_THRESHOLD;
  }

  getName(): string {
    return 'youtube-caption';
  }

  /** 字幕トラック自体の有無（コンテナが parent DOM に存在するか）。 */
  async isAvailable(): Promise<boolean> {
    return this.findCaptionContainer() !== null;
  }

  start(): void {
    this.disposed = false;
    // コンテナ出現を待ってから observe（初期描画前に呼ばれても拾えるように）。
    void this.waitForCaptionContainer().then((container) => {
      if (this.disposed || !container) return;
      try {
        const Observer = this.getMutationObserverCtor();
        if (!Observer) return;
        this.observer = new Observer(() => this.onCaptionChange());
        this.observer.observe(container, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      } catch {
        // observe 失敗（要素が消えた等）は無視。次回 start で再試行。
      }
    });
  }

  stop(): void {
    this.disposed = true;
    try {
      this.observer?.disconnect();
    } catch {
      // ignore
    }
    this.observer = null;
    this.segments = [];
    this.memo = null;
    this.lastText = '';
  }

  /** 配信切替時に字幕バッファをリセットする（observer は維持）。 */
  reset(): void {
    this.segments = [];
    this.memo = null;
    this.lastText = '';
  }

  /**
   * 直近 `windowSeconds` 秒の発話文脈を取得する。
   *
   * - 5 秒メモ化: 直近に構築済みなら再走査せずキャッシュを返す
   *   （ただし windowSeconds / threshold が前回と異なる場合は再走査）
   * - `evaluateCaptionQuality(...).useable === false` → **null**（呼び出し側は素通し）
   *
   * @param windowSeconds 参照窓（秒）
   * @param thresholdOverride useable しきい値の上書き（P5-B4c）。
   *   未指定なら mode 由来の既定（live 0.5 / archive 0.4）。
   *   `settings.captionContext.qualityThreshold` 由来の値が**勝つ**（ユーザー設定優先）。
   */
  async getRecentContext(
    windowSeconds: number,
    thresholdOverride?: number,
  ): Promise<RecentAudioContext | null> {
    const threshold = thresholdOverride ?? this.threshold;
    const now = Date.now();
    if (
      this.memo &&
      now - this.memo.builtAt < CONTEXT_MEMO_TTL_MS &&
      this.memo.windowSeconds === windowSeconds &&
      this.memo.threshold === threshold
    ) {
      return this.memo.result;
    }

    const currentTime = this.readVideoTime();
    const recent = this.getRecentSegments(windowSeconds, currentTime);
    const quality = evaluateCaptionQuality(recent, windowSeconds, threshold);

    let result: RecentAudioContext | null;
    if (!quality.useable) {
      result = null;
    } else {
      result = {
        // P5-B5 hotfix/hotfix-2: 逐次成長（接頭辞）を畳んでから連結し、
        // 残る完全一致の連続/周期重複を畳む。
        text: dedupeRepeatedPhrases(
          collapseRollingPrefixes(recent.map((s) => s.text)).join(' ').trim(),
        ),
        qualityScore: quality.overallScore,
        source: 'caption',
        segmentCount: recent.length,
        // text/quality と同一スナップショットの再生位置（B4c）。呼び出し側が
        // captionCacheSignature に渡し、recentAudio とキャッシュキーを揃える。
        currentTimeSeconds: currentTime,
      };
    }

    this.memo = { result, builtAt: now, windowSeconds, threshold };
    return result;
  }

  // ─── 内部: 字幕収集 ──────────────────────────────────────────────

  /** 字幕 DOM 変化時のハンドラ。新テキストを segment として push + prune。 */
  private onCaptionChange(): void {
    const doc = this.getParentDocument();
    if (!doc) return;
    let textEl: Element | null = null;
    try {
      textEl = doc.querySelector(CAPTION_TEXT_SELECTORS);
    } catch {
      return;
    }
    const currentText = textEl?.textContent ?? '';
    if (!currentText.trim()) return;
    // 重複/sanitize/denylist の最終判定は ingestCaption に一元化する。
    this.ingestCaption(currentText, this.readVideoTime(), Date.now());
  }

  /**
   * 1 字幕テキストをバッファに取り込む（UI 文字列除外 + sanitize + 重複/空スキップ、
   * prune 込み）。テスト用に分離（observer を立てずに収集ロジックを検証できる）。
   *
   * P5-B5 hotfix:
   * - YouTube UI 文字列（{@link containsCaptionUiString}）を含む断片は捨てる
   * - {@link sanitizeCaptionText} で効果音注釈 `[..]`・連続空白を除去してから積む
   * - 連続重複（sanitize 後の本文一致）はスキップ
   */
  private ingestCaption(text: string, currentTime: number, receivedAt: number): void {
    if (containsCaptionUiString(text)) return;
    const cleaned = sanitizeCaptionText(text);
    if (!cleaned || cleaned === this.lastText) return;
    this.lastText = cleaned;
    this.segments.push({ text: cleaned, timestamp: currentTime, receivedAt });
    this.pruneOldSegments(receivedAt);
    // 新規字幕が入ったらメモを無効化（次回 getRecentContext で再構築）
    this.memo = null;
  }

  /** 5 分超 or 500 件超のセグメントを破棄。 */
  private pruneOldSegments(now: number): void {
    this.segments = this.segments.filter((s) => now - s.receivedAt < MAX_SEGMENT_AGE_MS);
    if (this.segments.length > MAX_SEGMENTS) {
      this.segments = this.segments.slice(-MAX_SEGMENTS);
    }
  }

  /** 直近 windowSeconds のセグメント（timestamp が [currentTime-window, currentTime]）。 */
  private getRecentSegments(windowSeconds: number, currentTime: number): CaptionSegment[] {
    const minTime = currentTime - windowSeconds;
    return this.segments.filter((s) => s.timestamp >= minTime && s.timestamp <= currentTime);
  }

  // ─── 内部: parent frame DOM アクセス（横断、try/catch ガード） ─────

  /** parent watch ページの document（content script は chat iframe で動く）。 */
  private getParentDocument(): Document | null {
    try {
      if (typeof window === 'undefined') return null;
      // chat iframe なら window.parent.document（同一 origin）。
      // top レベルで動く場合（all_frames で watch ページ本体）も window.document で可。
      const parentDoc = window.parent?.document;
      if (parentDoc) return parentDoc;
      return typeof document !== 'undefined' ? document : null;
    } catch {
      // cross-origin（通常 YouTube では起きない）/ 拡張リロード時の例外ガード
      return null;
    }
  }

  /** 字幕コンテナ要素（複数セレクタ候補を順に試す）。 */
  private findCaptionContainer(): Element | null {
    const doc = this.getParentDocument();
    if (!doc) return null;
    for (const sel of CAPTION_CONTAINER_SELECTORS) {
      try {
        const el = doc.querySelector(sel);
        if (el) return el;
      } catch {
        // セレクタ不正等は無視して次候補
      }
    }
    return null;
  }

  /** parent video の currentTime（秒）。取得不能は 0。 */
  private readVideoTime(): number {
    try {
      const doc = this.getParentDocument();
      const video = doc?.querySelector('video') as HTMLVideoElement | null;
      const t = video?.currentTime;
      return typeof t === 'number' && Number.isFinite(t) ? t : 0;
    } catch {
      return 0;
    }
  }

  /** コンテナ出現待ち（observer ではなく軽量ポーリング、stop で中断）。 */
  private async waitForCaptionContainer(timeoutMs = 10000): Promise<Element | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.disposed) return null;
      const container = this.findCaptionContainer();
      if (container) return container;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  /** MutationObserver コンストラクタ（非ブラウザ環境では undefined）。 */
  private getMutationObserverCtor(): typeof MutationObserver | null {
    return typeof MutationObserver !== 'undefined' ? MutationObserver : null;
  }

  // ─── テスト用 ───────────────────────────────────────────────────

  /** @internal テスト用: observer を立てずに字幕収集ロジックを駆動する。 */
  readonly __test__ = {
    ingest: (text: string, currentTime: number, receivedAt: number): void =>
      this.ingestCaption(text, currentTime, receivedAt),
    segmentCount: (): number => this.segments.length,
    getThreshold: (): number => this.threshold,
  };
}
