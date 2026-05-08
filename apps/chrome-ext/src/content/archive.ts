/**
 * アーカイブモード: YouTube チャットリプレイの監視
 *
 * 知見（Phase -1 より）:
 * - チャットリプレイは iframe 内にある（all_frames: true で対応済み）
 * - #items 要素は遅延初期化されるため MutationObserver で出現を検知する
 * - setTimeout ポーリングは使用しない
 *
 * フィルタ 2 段構成:
 * - Stage 1: キーワードマッチ（即時、ブラウザ内完結）
 * - Stage 2: プロキシ経由 LLM 判定（非同期、判定中は通常表示を維持）
 */

import {
  buildKeywordSet,
  buildDescriptionPhraseSet,
  matchesKeyword,
  matchesKeywordForStage2,
  matchesCustomNGWord,
  buildActiveGenreTemplates,
  matchesGenreTemplate,
  matchesGenreKeywordForStage2,
  matchesGameplayHintForStage2,
  isObviouslySafe,
} from '@fresh-chat-keeper/judgment-engine/stage1';
import type { GenreTemplate } from '@fresh-chat-keeper/knowledge-base';
import { filterMessageElement, restoreMessageElement, switchDisplayMode, ATTR_FALSE_POSITIVE } from './chat-dom.js';
import {
  STORAGE_KEY,
  FILTER_COUNT_KEY,
  getOrCreateAnonToken,
  getStage2Usage,
  incrementStage2Usage,
  STAGE2_MONTHLY_LIMIT,
  saveMisreport,
  type Settings,
} from '../shared/settings.js';
import { loadSettings } from '../shared/settings-loader.js';
import type { MisreportEntry } from '@fresh-chat-keeper/shared';
import {
  initStage2Cache,
  getCachedVerdict,
  buildStage2CacheKey,
  verdictFromCache,
  type Stage2Candidate,
  type JudgeCacheEntry,
} from './chrome-cache.js';
import { sendStage2Batch } from './filter-orchestrator.js';
import {
  initCollectionEmitter,
  emitJudgmentLog,
  shutdownCollectionEmitter,
} from './collection-emit.js';

/** YouTube チャットリプレイのメッセージコンテナ */
const ITEMS_SELECTOR = '#items';

/** 各チャットメッセージのテキスト要素 */
const MSG_TEXT_SELECTOR = '#message';

/** フィルタ済みメッセージを検索するセレクタ（revealed も含む） */
const FILTERED_SELECTOR = '[data-fck-filtered]';

/** chat-dom.ts と同じ属性名（DOM チェック用） */
const ATTR_FILTERED = 'data-fck-filtered';

/** Stage 2 判定待ちを示す属性 */
const ATTR_PENDING = 'data-fck-pending';

/** Stage 2 判定待ち中に非表示にした行要素を示す属性 */
const ATTR_PENDING_ROW = 'data-fck-pending-row';

/** Stage 2 タイムアウト時間（ms）。これを超えたら強制的に表示に戻す */
const STAGE2_PENDING_TIMEOUT_MS = 5000;

// ─── コンテキスト有効性チェック ───────────────────────────────────────────────

/**
 * 拡張機能のコンテキストがまだ有効かどうかを確認する。
 * 拡張がリロード・更新・無効化されると chrome.runtime.id が undefined になる。
 * Content Script はページが残っている限り生き続けるため、このチェックが必要。
 */
function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/**
 * コンテキスト無効を検知したときの終了処理。
 * Observer を止め、Stage 2 キューをクリアしてこれ以上 Chrome API を呼ばないようにする。
 */
function shutdownOnInvalidContext(): void {
  console.log('[FreshChatKeeper] 拡張コンテキストが無効になりました。監視を停止します。');
  itemsObserver?.disconnect();
  itemsObserver = null;
  clearStage2Queue();
  // Phase 2.5: ingest バッファをフラッシュ（拡張更新前に直近のログを救う）。
  // chrome.runtime が無効化されている場合 fetch も失敗するが try で保護される。
  void shutdownCollectionEmitter();
}

// ─── モジュールスコープ状態 ───────────────────────────────────────────────────

let currentSettings: Settings | null = null;
let currentKeywords: Set<string> = new Set();
let currentDescriptionPhrases: Set<string> = new Set();
let currentGenreTemplates: GenreTemplate[] = [];

/** YouTubeの動画タイトル（Stage 2のゲーム推測に使用） */
let currentVideoTitle = '';
let itemsContainerRef: Element | null = null;

/** #items の childList を監視する Observer（pause/resume のために保持） */
let itemsObserver: MutationObserver | null = null;

/**
 * 表示方式の切り替え処理中フラグ。
 * reprocessAll 実行中は MutationObserver のコールバックをスキップすることで、
 * DOM 更新と chrome.storage.onChanged ハンドラの競合を防ぐ。
 */
let isUpdatingDisplayMode = false;

/**
 * ユーザーがクリックして展開したコメントのオリジナルテキストを記憶する。
 * YouTube が DOM を差し替えて新しい要素が追加された場合でも、
 * 同じテキストを再フィルタしないために使用する。
 */
const revealedTexts = new Set<string>();

// ─── Stage 2 状態 ─────────────────────────────────────────────────────────────

/** Stage 2 判定待ちキュー */
let stage2Queue: Stage2Candidate[] = [];

/** Stage 2 タイムアウトタイマー（cacheKey → timer ID） */
const stage2PendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/** Stage 2 判定を実行中かどうか（再入防止） */
let isDraining = false;

/** キュー蓄積用デバウンスタイマー */
let drainDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** 起動時に取得した匿名トークン */
let anonToken = '';

/** 現在のモード（archive / live）。ingest 時の judgmentMode に使う */
let currentPageMode: 'archive_replay' | 'live' = 'archive_replay';

/** 配信開始時刻（live モードのみ。archive は常に null） */
let liveStartedAtMs: number | null = null;

// ─── エントリポイント ─────────────────────────────────────────────────────────

export function startArchiveMode(mode: 'archive' | 'live' = 'archive'): void {
  console.log(`[FreshChatKeeper] ${mode === 'live' ? 'ライブモード' : 'アーカイブモード'}で起動しました`);

  currentPageMode = mode === 'live' ? 'live' : 'archive_replay';
  liveStartedAtMs = mode === 'live' ? Date.now() : null;

  // 動画タイトルを取得（親フレームの document.title から "- YouTube" を除去）
  currentVideoTitle = getVideoTitle();

  // 動画単位のフィルタカウンターをリセット（リロード・別動画への移動時）
  chrome.storage.local.set({ [FILTER_COUNT_KEY]: 0 });

  // Stage 2 キャッシュの読み込みとトークン取得を並行して初期化
  Promise.all([initStage2Cache(), getOrCreateAnonToken()])
    .then(([, token]) => {
      anonToken = token;
      // Phase 2.5: collection-emit に正しい token を渡す。
      // currentSettings が先に解決していれば apiUrl を、未解決なら DEFAULT を使う。
      const apiUrl = currentSettings?.collectionApiUrl ?? '';
      if (apiUrl) {
        void initCollectionEmitter(apiUrl, anonToken);
      }
    })
    .catch((err) => {
      // chrome.storage 失敗等。anonToken が空のままだと Stage 2 が動かないが、
      // Stage 1 は引き続き機能する。サイレント失敗を避けるため必ずログ出力する。
      console.error('[FreshChatKeeper] 起動時初期化エラー（Stage 2 キャッシュ/トークン）:', err);
    });

  loadSettings()
    .then((settings) => {
      currentSettings = settings;
      currentKeywords = buildKeywordsFromSettings(settings);

      // Phase 2.5: opt-in している場合のみ collection-emit を起動。
      // anonToken が空でも初期化は進める（あとから resolve した時点で
      // initCollectionEmitter は再呼び出ししない設計だが、IngestClient は
      // refreshClient() のタイミングで token を再評価するため問題ない）。
      // ※anonToken の Promise が完了する前に initCollectionEmitter が走る
      // 可能性があるため、Promise.all ブロック側でも initCollectionEmitter を
      // 呼んで二段構えにする（後勝ち）。
      void initCollectionEmitter(settings.collectionApiUrl, anonToken);

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[STORAGE_KEY]) return;
        const prev = changes[STORAGE_KEY].oldValue as Settings | undefined;
        const next = changes[STORAGE_KEY].newValue as Settings;

        const displayModeChanged = prev?.displayMode !== next.displayMode;
        const onlyDisplayModeChanged =
          displayModeChanged &&
          prev?.enabled === next.enabled &&
          prev?.gameId === next.gameId &&
          prev?.filterMode === next.filterMode &&
          JSON.stringify(prev?.progressByGame) === JSON.stringify(next.progressByGame) &&
          JSON.stringify(prev?.customNgWords) === JSON.stringify(next.customNgWords) &&
          JSON.stringify(prev?.selectedGenreTemplates) === JSON.stringify(next.selectedGenreTemplates);

        currentSettings = next;
        currentKeywords = buildKeywordsFromSettings(next);

        if (!itemsContainerRef) return;

        if (onlyDisplayModeChanged) {
          // displayMode のみ変更: 復元→再フィルタせず、表示方式だけ直接切り替える（フラッシュ防止）
          isUpdatingDisplayMode = true;
          itemsContainerRef.querySelectorAll('[data-fck-filtered="true"]').forEach((el) => {
            switchDisplayMode(el, next.displayMode, () => {
              const text = el.getAttribute('data-fck-original') ?? el.textContent?.trim() ?? '';
              if (text) revealedTexts.add(text);
            });
          });
          isUpdatingDisplayMode = false;
        } else {
          // 設定変更: Stage 2 キューをクリアして再処理
          clearStage2Queue();
          reprocessAll(itemsContainerRef);
        }
      });

      if (settings.enabled) {
        waitForItemsContainer();
      }
    })
    .catch((err) => {
      // chrome.storage 失敗等で設定ロードに失敗。フィルタが全く起動せず
      // 全コメント素通しになるため必ずログ出力する。
      console.error('[FreshChatKeeper] 設定ロード失敗（フィルタ未起動）:', err);
    });
}

// ─── 設定・キーワード構築 ─────────────────────────────────────────────────────

function buildKeywordsFromSettings(settings: Settings): Set<string> {
  const progress = settings.progressByGame[settings.gameId];
  currentDescriptionPhrases = buildDescriptionPhraseSet(settings.gameId);
  currentGenreTemplates = buildActiveGenreTemplates(settings.selectedGenreTemplates ?? []);
  return buildKeywordSet(settings.gameId, settings.filterMode, progress);
}

// ─── MutationObserver 管理 ────────────────────────────────────────────────────

function pauseObserver(): void {
  itemsObserver?.disconnect();
}

function resumeObserver(): void {
  if (itemsObserver && itemsContainerRef) {
    itemsObserver.observe(itemsContainerRef, { childList: true });
  }
}

/**
 * #items 要素の出現を MutationObserver で待機する。
 * すでに存在する場合は即座に監視開始する。
 */
function waitForItemsContainer(): void {
  const existing = document.querySelector(ITEMS_SELECTOR);
  if (existing) {
    observeItems(existing);
    return;
  }

  const observer = new MutationObserver(() => {
    const el = document.querySelector(ITEMS_SELECTOR);
    if (el) {
      observer.disconnect();
      observeItems(el);
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

/**
 * #items コンテナを監視し、追加された子要素に Stage 1 フィルタを適用する。
 */
function observeItems(itemsContainer: Element): void {
  itemsContainerRef = itemsContainer;

  itemsContainer.querySelectorAll(MSG_TEXT_SELECTOR).forEach((el) => {
    processMessage(el);
  });

  itemsObserver = new MutationObserver((mutations) => {
    // 表示方式の切り替え処理中は干渉しない
    if (isUpdatingDisplayMode) return;

    // #items の子要素が削除された = 再生位置変更（シーク）
    // revealedTexts をクリアして、巻き戻し後のコメントを正しく再フィルタする
    const hasRemovals = mutations.some((m) => m.removedNodes.length > 0);
    if (hasRemovals) {
      revealedTexts.clear();
      clearStage2Queue();
    }

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        const msgEl = node.matches(MSG_TEXT_SELECTOR)
          ? node
          : node.querySelector(MSG_TEXT_SELECTOR);
        if (msgEl) processMessage(msgEl);
      }
    }
  });

  itemsObserver.observe(itemsContainer, { childList: true });
}

/**
 * 既存の全フィルタを解除して再フィルタする。
 * Observer を一時停止して干渉を防ぐ。
 *
 * @param clearReveals フィルタ基準が変わった場合は true（デフォルト）。
 *   ユーザーがクリックして展開済みのテキスト集合 ({@link revealedTexts}) を
 *   クリアし、新基準での再判定を確実に走らせる。
 *   displayMode 等「フィルタ基準が変わらない」変更の場合は false を渡して
 *   展開状態を維持する（ただし現状そのケースでは reprocessAll は呼ばれない）。
 */
function reprocessAll(itemsContainer: Element, clearReveals = true): void {
  isUpdatingDisplayMode = true;
  pauseObserver();

  // フィルタ基準が変わった場合、展開済みテキストの集合は古い基準に対する
  // ユーザーの意思表明であり、新基準では無効化して再判定する必要がある。
  // クリアしないと processMessage の `if (revealedTexts.has(text)) return;`
  // で早期 return してしまい、再フィルタが走らない。
  if (clearReveals) {
    revealedTexts.clear();
  }

  itemsContainer.querySelectorAll(FILTERED_SELECTOR).forEach((el) => {
    restoreMessageElement(el);
  });

  if (currentSettings?.enabled) {
    itemsContainer.querySelectorAll(MSG_TEXT_SELECTOR).forEach((el) => {
      processMessage(el);
    });
  }

  resumeObserver();
  isUpdatingDisplayMode = false;
}

// ─── メッセージ処理 ────────────────────────────────────────────────────────────

function processMessage(el: Element): void {
  if (!isContextValid()) {
    shutdownOnInvalidContext();
    return;
  }
  if (!currentSettings?.enabled) return;

  // 誤判定報告済みの要素は再フィルタしない
  if (el.getAttribute(ATTR_FALSE_POSITIVE) === 'true') return;

  // DOM 再利用ケース: YouTubeが要素を使い回した場合、古い属性が残っている可能性がある。
  // その場合は属性を一掃して最初から処理する。
  // stale 判定: ATTR_ORIGINAL（元テキスト）が revealedTexts に含まれない revealed 状態 = 使い回し
  if (el.hasAttribute(ATTR_FILTERED)) {
    const storedOriginal = el.getAttribute('data-fck-original');
    const isStale =
      el.getAttribute(ATTR_FILTERED) === 'revealed' &&
      !revealedTexts.has(storedOriginal ?? '');
    const isTrueFiltered = el.getAttribute(ATTR_FILTERED) === 'true';
    if (!isStale && isTrueFiltered) return;
    el.removeAttribute(ATTR_FILTERED);
    el.removeAttribute('data-fck-original');
    el.removeAttribute('data-fck-matched-keyword');
    el.removeAttribute('data-fck-matched-context');
    (el as HTMLElement).style.cursor = '';
    if (el.hasAttribute(ATTR_PENDING)) showPendingElement(el);
  }

  // Stage 2 判定待ち中の要素: テキストが一致していればキュー済みなのでスキップ
  // テキストが変わっていれば YouTube が DOM を使い回したため非表示を解除して再処理
  if (el.getAttribute(ATTR_PENDING) === 'true') {
    const currentText = el.textContent?.trim() ?? '';
    const isStillQueued = stage2Queue.some((c) => c.el.deref() === el && c.text === currentText);
    if (isStillQueued) return;
    showPendingElement(el);
  }

  const text = el.textContent?.trim() ?? '';
  if (!text) return;

  if (revealedTexts.has(text)) return;

  // ── 段階A 前駆体: 「明らかに無害」コメントは Stage 2 をスキップ ───────────────
  // judgment-engine の isObviouslySafe（"草"/"www"/"888"/2文字以下）が真なら
  // ネタバレフィルタは行わない（既存挙動: 何もしない）。
  // Phase 2.5 で opt-in 中なら 'reaction' カテゴリでログを残す（§2.1, §4.4）。
  if (isObviouslySafe(text)) {
    emitJudgmentForElement(el, text, {
      stageACategory: 'reaction',
      labels: ['safe'],
      primaryLabel: 'safe',
      confidence: 1.0,
      stage: 'stage1',
      reasonJa: null,
      labelSource: 'haiku',
    });
    return;
  }

  // ── カスタムNGワード: 即時判定（ゲーム知識ベースと独立） ───────────────────────
  const customNgWords = currentSettings.customNgWords ?? [];
  const matchedNgWord = matchesCustomNGWord(text, customNgWords);
  if (matchedNgWord !== null) {
    emitStage1SpoilerLog(el, text);
    applyFilter(el, text, matchedNgWord);
    return;
  }

  // ── ジャンルテンプレート: 即時判定（ゲーム知識ベースと独立） ──────────────────
  const matchedGenre = matchesGenreTemplate(text, currentGenreTemplates);
  if (matchedGenre !== null) {
    emitStage1SpoilerLog(el, text);
    applyFilter(el, text, matchedGenre);
    return;
  }

  // ── Stage 1: 即時判定 ──────────────────────────────────────────────────────
  const matchResult = matchesKeyword(text, currentKeywords, currentDescriptionPhrases);

  if (matchResult !== null) {
    emitStage1SpoilerLog(el, text);
    applyFilter(el, text, matchResult.keyword, matchResult.verb ?? matchResult.phrase);
    return;
  }

  // ── Stage 2: キーワード単体マッチ → プロキシへ委託 ──────────────────────────
  const stage2keyword = matchesKeywordForStage2(text, currentKeywords);
  if (!stage2keyword) {
    // gameId !== 'none' かつジャンルテンプレート選択時: 指示・攻略ヒント系フレーズを Stage 2 へ
    if (currentSettings.gameId !== 'none' && currentGenreTemplates.length > 0) {
      const hintPhrase = matchesGameplayHintForStage2(text, currentGenreTemplates);
      if (hintPhrase !== null) {
        const progress = currentSettings.progressByGame[currentSettings.gameId];
        const cacheKey = buildStage2CacheKey(currentSettings.gameId, progress, text);
        const cached = getCachedVerdict(cacheKey);
        if (cached !== null) {
          applyStage2Verdict({ text, el: new WeakRef(el), cacheKey, matchedKeyword: hintPhrase }, cached);
          return;
        }
        hidePendingElement(el, cacheKey);
        stage2Queue.push({ text, el: new WeakRef(el), cacheKey, matchedKeyword: hintPhrase });
        scheduleDrain();
        return;
      }
    }
    // ゲームKBがない場合（gameId === 'other'）はジャンルキーワード単体でも Stage 2 を試みる
    if (currentSettings.gameId === 'other' && currentGenreTemplates.length > 0) {
      const genreKeyword = matchesGenreKeywordForStage2(text, currentGenreTemplates);
      if (genreKeyword) {
        const cacheKey = buildStage2CacheKey('other', undefined, text);
        const cached = getCachedVerdict(cacheKey);
        if (cached !== null) {
          applyStage2Verdict({ text, el: new WeakRef(el), cacheKey, matchedKeyword: genreKeyword }, cached);
          return;
        }
        hidePendingElement(el, cacheKey);
        stage2Queue.push({ text, el: new WeakRef(el), cacheKey, matchedKeyword: genreKeyword });
        scheduleDrain();
      }
    }
    return;
  }

  const progress = currentSettings.progressByGame[currentSettings.gameId];
  const cacheKey = buildStage2CacheKey(currentSettings.gameId, progress, text);

  // キャッシュ済みなら即時適用
  const cached = getCachedVerdict(cacheKey);
  if (cached !== null) {
    applyStage2Verdict({ text, el: new WeakRef(el), cacheKey, matchedKeyword: stage2keyword }, cached);
    return;
  }

  // 未判定: キューに追加して後送（判定中は非表示）
  hidePendingElement(el, cacheKey);
  stage2Queue.push({ text, el: new WeakRef(el), cacheKey, matchedKeyword: stage2keyword });
  scheduleDrain();
}

// ─── Stage 2 キュー管理 ────────────────────────────────────────────────────────

function clearStage2Queue(): void {
  for (const timer of stage2PendingTimeouts.values()) clearTimeout(timer);
  stage2PendingTimeouts.clear();
  for (const candidate of stage2Queue) {
    const el = candidate.el.deref();
    if (el) showPendingElement(el);
  }
  stage2Queue = [];
}

/**
 * 新しい候補が追加されたら 200ms のデバウンス後にドレイン開始。
 * 連続する MutationObserver コールバックをまとめてバッチ化する。
 */
function scheduleDrain(): void {
  if (drainDebounceTimer !== null) return;
  drainDebounceTimer = setTimeout(() => {
    drainDebounceTimer = null;
    drainStage2Queue();
  }, 200);
}

/**
 * Stage 2 キューを 5 件ずつプロキシに送信する。
 * バッチ間は 1 秒待機してレート制限に配慮する。
 */
async function drainStage2Queue(): Promise<void> {
  if (isDraining || !currentSettings?.enabled || !anonToken) return;
  if (stage2Queue.length === 0) return;

  isDraining = true;
  try {
    while (stage2Queue.length > 0) {
      // コンテキストが無効になったら中断（拡張リロード時等）
      if (!isContextValid()) {
        shutdownOnInvalidContext();
        break;
      }
      // enabled が途中でオフになったら中断
      if (!currentSettings?.enabled) break;

      // 月間上限チェック: 上限に達していたら Stage 2 を停止し Stage 1 のみで継続
      const usage = await getStage2Usage();
      if (usage.messageCount >= STAGE2_MONTHLY_LIMIT) {
        console.log(`[FreshChatKeeper] Stage 2月間上限(${STAGE2_MONTHLY_LIMIT}回)に達しました。Stage 1のみで動作を継続します。`);
        // clearStage2Queue() を使い、pending 中の DOM 要素を showPendingElement で
        // 復元してから queue を空にする。`stage2Queue = []` だけだと hidePendingElement
        // で非表示中の要素がタイムアウト（5 秒）まで非表示のまま残ってしまう。
        clearStage2Queue();
        break;
      }

      const batch = stage2Queue.splice(0, 5);
      // clearStage2Queue() との非同期レースでバッチが空になる場合があるため送信をスキップ
      if (batch.length === 0) break;
      const success = await sendStage2Batch(batch, currentSettings, anonToken, applyStage2Verdict, currentVideoTitle);
      if (success) await incrementStage2Usage(batch.length);

      if (stage2Queue.length > 0) {
        await sleep(1000);
      }
    }
  } finally {
    isDraining = false;
    // ドレイン中に追加されたアイテムがあれば再スケジュール
    if (stage2Queue.length > 0) {
      scheduleDrain();
    }
  }
}

/**
 * Phase 2.5: 1 件の判定を ingest クライアントに渡す。
 *
 * opt-in OFF のユーザーには collection-emit 側で no-op になるため
 * ここでガード不要。stageACategory / labels 等は呼び出し側が決める。
 */
function emitJudgmentForElement(
  el: Element,
  text: string,
  judgment: {
    stageACategory: import('@fresh-chat-keeper/shared').StageACategory;
    labels: import('@fresh-chat-keeper/shared').CollectionLabel[];
    primaryLabel: import('@fresh-chat-keeper/shared').CollectionLabel;
    confidence: number;
    stage: 'stage1' | 'stage2';
    reasonJa: string | null;
    labelSource: import('@fresh-chat-keeper/shared').LabelSource;
  },
): void {
  if (!currentSettings) return;

  const videoId = getVideoIdFromUrl();
  const channelId = getChannelIdFromDom();
  const targetAuthorChannelId = getAuthorChannelIdFromElement(el);

  // 必須フィールドが欠けている場合は emit を諦める（apps/api の 422 を避ける）
  if (!videoId || !channelId || !targetAuthorChannelId) return;

  emitJudgmentLog({
    videoId,
    channelId,
    gameTitle:
      currentSettings.gameId === 'none' || currentSettings.gameId === 'other'
        ? null
        : currentSettings.gameId,
    timeIntoStream: currentPageMode === 'live' && liveStartedAtMs !== null
      ? Math.floor((Date.now() - liveStartedAtMs) / 1000)
      : null,
    judgmentMode: currentPageMode,
    targetBody: text,
    targetAuthorChannelId,
    targetTimestamp: new Date().toISOString(),
    // archive モードなら直前 N 件、live は空配列（仕様書 §4.4）
    precedingMessages:
      currentPageMode === 'archive_replay' ? collectPrecedingMessages(el) : [],
    stageACategory: judgment.stageACategory,
    labels: judgment.labels,
    primaryLabel: judgment.primaryLabel,
    confidence: judgment.confidence,
    stage: judgment.stage,
    reasonJa: judgment.reasonJa,
    labelSource: judgment.labelSource,
  });
}

/**
 * Stage 2 判定結果を DOM に適用する。
 * - 'block' または 'uncertain' → フィルタ（安全側に倒す）
 * - 'allow' → 何もしない
 */
function applyStage2Verdict(candidate: Stage2Candidate, entry: JudgeCacheEntry): void {
  if (!currentSettings) return;

  // タイムアウトをキャンセルして非表示を解除
  const timer = stage2PendingTimeouts.get(candidate.cacheKey);
  if (timer !== undefined) {
    clearTimeout(timer);
    stage2PendingTimeouts.delete(candidate.cacheKey);
  }
  const el = candidate.el.deref();
  if (el) showPendingElement(el);

  // Phase 2.5 ingest: stage 2 の判定結果は verdict に関わらず常に記録する
  // （'allow' = 'safe' ラベル、'block' = 'spoiler' ラベル）。フィルタ後に
  // emit すると el がフィルタ書き換え後で textContent が変わるので、
  // フィルタ適用前にここで emit する。
  if (el && el.textContent?.trim() === candidate.text) {
    const isBlocked = entry.spoilerCategory === 'direct_spoiler'
      || entry.spoilerCategory === 'foreshadowing_hint'
      || entry.spoilerCategory === 'gameplay_hint';
    emitJudgmentForElement(el, candidate.text, {
      stageACategory: 'unknown',
      labels: isBlocked ? ['spoiler'] : ['safe'],
      primaryLabel: isBlocked ? 'spoiler' : 'safe',
      confidence: entry.confidence ?? 1.0,
      stage: 'stage2',
      reasonJa: null,
      labelSource: 'haiku',
    });
  }

  const verdict = verdictFromCache(entry, currentSettings.filterMode);
  if (verdict === 'allow') return;

  if (!el) return; // 要素が DOM から消えた

  if (!currentSettings.enabled) return;

  // 誤判定報告済みの要素は再フィルタしない
  if (el.getAttribute(ATTR_FALSE_POSITIVE) === 'true') return;

  // 要素がすでにフィルタ済み（Stage 1 が後から適用された等）
  if (el.hasAttribute(ATTR_FILTERED)) return;

  // YouTube が DOM を差し替えてテキストが変わっていたらスキップ
  if (el.textContent?.trim() !== candidate.text) return;

  // ユーザーが展開済みのテキストはスキップ
  if (revealedTexts.has(candidate.text)) return;

  applyFilter(el, candidate.text, candidate.matchedKeyword, undefined, entry.spoilerCategory);
}

/** フィルタを適用して filterCount をインクリメントする共通処理 */
function applyFilter(
  el: Element,
  text: string,
  matchedKeyword?: string,
  matchedContext?: string,
  spoilerCategory?: string | null,
): void {
  if (!currentSettings) return;
  const settings = currentSettings;

  const onMisreport = (): void => {
    const entry: MisreportEntry = {
      text,
      spoilerCategory: spoilerCategory ?? null,
      gameId: settings.gameId,
      progress: settings.progressByGame[settings.gameId] ?? null,
      filterMode: settings.filterMode,
      timestamp: new Date().toISOString(),
    };
    saveMisreport(entry);
  };

  filterMessageElement(
    el,
    settings.displayMode,
    matchedKeyword,
    matchedContext,
    () => { revealedTexts.add(text); },
    onMisreport,
  );
  try {
    chrome.storage.local.get(FILTER_COUNT_KEY, (result) => {
      const prev = (result[FILTER_COUNT_KEY] as number | undefined) ?? 0;
      chrome.storage.local.set({ [FILTER_COUNT_KEY]: prev + 1 });
    });
  } catch {
    // processMessage のチェック直後にコンテキストが無効になった場合のレース条件ガード
    shutdownOnInvalidContext();
  }
}

// ─── Phase 2.5 ingest 補助 ─────────────────────────────────────────────────

/** Stage 1 でブロックされたコメントを 'spoiler' ラベルで ingest 用に emit する */
function emitStage1SpoilerLog(el: Element, text: string): void {
  emitJudgmentForElement(el, text, {
    stageACategory: 'unknown',
    labels: ['spoiler'],
    primaryLabel: 'spoiler',
    confidence: 1.0,
    stage: 'stage1',
    reasonJa: null,
    labelSource: 'haiku',
  });
}

/** YouTube の親フレーム URL から videoId を抽出（取得不能なら空文字） */
function getVideoIdFromUrl(): string {
  try {
    const url = new URL(window.parent?.location?.href ?? window.location.href);
    return url.searchParams.get('v') ?? '';
  } catch {
    return '';
  }
}

/**
 * 親フレームの DOM から配信者の channel ID を抽出する。
 *
 * YouTube は `<link rel="canonical">` や `meta[itemprop="channelId"]` 等
 * 複数経路で channelId を露出している。最も安定しているのは `ytd-watch-flexy`
 * 周辺に置かれる `meta[itemprop="channelId"]` だが、レイアウト変更に弱い。
 * 現状は最も単純な `<meta itemprop="channelId">` を試し、なければ空文字。
 */
function getChannelIdFromDom(): string {
  try {
    const doc = window.parent?.document;
    if (!doc) return '';
    const meta = doc.querySelector<HTMLMetaElement>('meta[itemprop="channelId"]');
    return meta?.content ?? '';
  } catch {
    return '';
  }
}

/**
 * チャットメッセージ要素から投稿者の YouTube channel ID を抽出する。
 *
 * yt-live-chat-text-message-renderer は `data-author-external-channel-id`
 * 属性を持つ（live / archive 共通）。取得不能なら空文字を返し、
 * 呼び出し側（emitJudgmentForElement）が 422 回避のため emit を諦める。
 */
function getAuthorChannelIdFromElement(el: Element): string {
  const renderer =
    el.closest('yt-live-chat-text-message-renderer') ??
    el.closest('yt-live-chat-paid-message-renderer');
  if (!renderer) return '';
  return renderer.getAttribute('data-author-external-channel-id') ?? '';
}

/**
 * archive モードで現在の el の直前 N 件のメッセージを集める（最大 10）。
 *
 * VTuber 1B 互換構造に揃えるため { body, timestamp } の配列を返す。
 * 投稿時刻は DOM から取得困難なため、現在時刻の `Date.now()` を - i*1000 ms
 * のように最近順に逆算する。Phase 3+ で正確な timestamp 抽出（ライブ
 * チャット renderer の data-timestamp 属性等）に差し替える。
 */
function collectPrecedingMessages(el: Element): import('@fresh-chat-keeper/shared').ContextMessage[] {
  if (!itemsContainerRef) return [];
  const allMsgs = Array.from(itemsContainerRef.querySelectorAll(MSG_TEXT_SELECTOR));
  const idx = allMsgs.indexOf(el);
  if (idx <= 0) return [];

  const start = Math.max(0, idx - 10);
  const slice = allMsgs.slice(start, idx);
  const now = Date.now();
  return slice.map((m, i) => ({
    body: (m.textContent ?? '').trim(),
    timestamp: new Date(now - (slice.length - i) * 1000).toISOString(),
  }));
}

// ─── ユーティリティ ────────────────────────────────────────────────────────────

/**
 * 親フレーム（YouTube 動画ページ）のタイトルを取得する。
 * チャット iframe は YouTube と同一オリジンのため window.parent.document にアクセス可能。
 * document.title には " - YouTube" が付くため除去する。
 */
function getVideoTitle(): string {
  try {
    const title = window.parent?.document?.title ?? '';
    return title.replace(/\s*[-–]\s*YouTube\s*$/, '').trim();
  } catch {
    // クロスオリジン等で取得できない場合は空文字を返す
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stage 2 判定待ち中のコメント行を非表示にし、タイムアウトをセットする。
 * 5秒以内に判定が返らなければ強制的に表示に戻す（ネットワークエラー等の対策）。
 */
function hidePendingElement(el: Element, cacheKey: string): void {
  el.setAttribute(ATTR_PENDING, 'true');
  const row =
    el.closest('yt-live-chat-text-message-renderer') ??
    el.closest('yt-live-chat-paid-message-renderer') ??
    el.parentElement;
  if (row) {
    row.setAttribute(ATTR_PENDING_ROW, 'true');
    (row as HTMLElement).style.display = 'none';
  }

  const timer = setTimeout(() => {
    stage2PendingTimeouts.delete(cacheKey);
    showPendingElement(el);
  }, STAGE2_PENDING_TIMEOUT_MS);
  stage2PendingTimeouts.set(cacheKey, timer);
}

/** 判定待ち非表示を解除して通常表示に戻す */
function showPendingElement(el: Element): void {
  el.removeAttribute(ATTR_PENDING);
  const row = el.closest(`[${ATTR_PENDING_ROW}]`);
  if (row) {
    row.removeAttribute(ATTR_PENDING_ROW);
    (row as HTMLElement).style.display = '';
  }
}
