/**
 * Stage 2 判定結果のキャッシュ（Chrome 拡張側実装）。
 *
 * 旧 `stage2.ts` のキャッシュ部分をそのまま継承。
 * judgment-engine の `JudgmentCache` / `CacheStorage` インターフェースは使わず、
 * **既存のキャッシュキー仕様（gameId + 進行状況 + テキスト）と保存キー
 * `fck_judge_cache` を維持**する。これにより v0.2.0 ユーザーの既存キャッシュが
 * 拡張更新後も再利用される。
 *
 * 設計判断（INTEG-01 時点）:
 * - judgment-engine の `JudgmentCache.buildKey` は `normalize + hash` で
 *   別キー体系のため、移行すると既存キャッシュが破棄される
 * - 互換性最優先のため、既存キー体系をそのまま維持し、judgment-engine 側の
 *   キャッシュ抽象は **chrome-ext からは利用しない**
 * - Phase 4 以降で動画別キャッシュ（`fck_cache:{video_id}`）に移行する場合は
 *   この時点で互換性を切る
 */

import type { JudgmentLabel } from '@fresh-chat-keeper/shared';
import type { GameProgress, FilterMode } from '../shared/settings.js';

/** proxy の LLM が返す spoiler_category 値（Phase 2 互換 / 後方互換ブリッジ） */
export type LLMSpoilerCategory = 'direct_spoiler' | 'foreshadowing_hint' | 'gameplay_hint' | 'safe';

const LLM_CATEGORY_SET = new Set<string>([
  'direct_spoiler',
  'foreshadowing_hint',
  'gameplay_hint',
  'safe',
]);

export type Stage2Verdict = 'block' | 'allow';

/**
 * Stage 2 判定結果のキャッシュエントリ。
 *
 * Phase 3（v0.4.0）でマルチラベル化:
 * - `primary` / `labels` が新しい正のフィールド（proxy が `FilterResult.primary`
 *   `FilterResult.labels` を返す）
 * - `spoilerCategory` は **後方互換フィールド**。v0.3.x で保存された既存
 *   `fck_judge_cache` エントリ（primary/labels を持たない）と、proxy の
 *   後方互換ブリッジ（B3 hardening）経由で来る値を読むために残す。
 *
 * すべて optional。判定失敗（LLM エラー / JSON パース失敗）は
 * `primary` 未設定かつ `spoilerCategory: null` で表す。
 */
export interface JudgeCacheEntry {
  /** Phase 3: 最も深刻な単一ラベル（labels から LABEL_PRECEDENCE で導出済み） */
  primary?: JudgmentLabel;
  /** Phase 3: マルチラベルの生結果 */
  labels?: JudgmentLabel[];
  /**
   * 後方互換: Phase 2 までの spoiler サブカテゴリ。
   * - 旧 `fck_judge_cache` エントリ（primary なし）の読み出し
   * - proxy 後方互換ブリッジ経由のレスポンス
   * のために残す。null は LLM 判定失敗。
   */
  spoilerCategory?: LLMSpoilerCategory | null;
  confidence?: number;
}

/** Stage 2 判定待ちコメントの情報 */
export interface Stage2Candidate {
  text: string;
  el: WeakRef<Element>;
  cacheKey: string;
  matchedKeyword: string;
}

export type OnStage2Result = (candidate: Stage2Candidate, entry: JudgeCacheEntry) => void;

/**
 * キャッシュエントリと現在のフィルタモードから verdict を導出する。
 * フィルタモードを変更しても proxy に再リクエストせずに正しい判定が得られる。
 *
 * Phase 3 の評価順:
 * 1. `primary` があれば優先（マルチラベル新経路）
 *    - 'safe' → allow
 *    - 'spoiler' → block（強度は Stage 2 プロンプト側で適用済みなので、
 *      LLM が spoiler と判定した時点でブロック対象）
 *    - 'harassment' / 'spam' / 'off_topic' / 'backseat' → allow
 *      （B3 ではこれらのカテゴリ ON/OFF UI が未実装。Stage 1.5 の spam は
 *      archive.ts 側で直接フィルタするので Stage 2 キャッシュには乗らない。
 *      B4 でカテゴリ別 UI が入ったら強度・ON/OFF を反映する）
 * 2. `primary` がなければ後方互換 `spoilerCategory` で判定（旧キャッシュ /
 *    proxy ブリッジ）。null（判定失敗）は lenient→allow / その他→block
 */
export function verdictFromCache(entry: JudgeCacheEntry, filterMode: FilterMode): Stage2Verdict {
  if (entry.primary !== undefined) {
    switch (entry.primary) {
      case 'safe':
        return 'allow';
      case 'spoiler':
        return 'block';
      case 'harassment':
      case 'spam':
      case 'off_topic':
      case 'backseat':
        // B3: カテゴリ別 ON/OFF UI 未実装のため allow（B4 で拡張）
        return 'allow';
      default: {
        // B4a hardening D: コンパイル時網羅チェック。JudgmentLabel に
        // ラベルを追加して上の case を足し忘れると型エラーになる。
        const _exhaustive: never = entry.primary;
        void _exhaustive;
        return 'allow';
      }
    }
  }

  const spoilerCategory = entry.spoilerCategory ?? null;
  if (spoilerCategory === null) {
    return filterMode === 'lenient' ? 'allow' : 'block';
  }
  switch (spoilerCategory) {
    case 'direct_spoiler':
      return 'block';
    case 'foreshadowing_hint':
      return filterMode === 'lenient' ? 'allow' : 'block';
    case 'gameplay_hint':
      return filterMode === 'strict' ? 'block' : 'allow';
    case 'safe':
      return 'allow';
  }
}

/**
 * proxy レスポンスの `spoilerCategory` 文字列を {@link LLMSpoilerCategory} へ
 * narrowing する。未知の値は null（LLM 判定失敗）扱い。
 */
export function parseSpoilerCategory(raw: string | undefined | null): LLMSpoilerCategory | null {
  if (raw == null) return null;
  return LLM_CATEGORY_SET.has(raw) ? (raw as LLMSpoilerCategory) : null;
}

// ─── キャッシュ ────────────────────────────────────────────────────────────────

export const JUDGE_CACHE_KEY = 'fck_judge_cache';

let _cache: Record<string, JudgeCacheEntry> = {};
let _cacheLoaded = false;

/** 起動時に一度だけ呼び出す。chrome.storage から判定キャッシュをメモリに読み込む。 */
export async function initStage2Cache(): Promise<void> {
  if (_cacheLoaded) return;
  const result = await chrome.storage.local.get(JUDGE_CACHE_KEY);
  _cache = (result[JUDGE_CACHE_KEY] as Record<string, JudgeCacheEntry> | undefined) ?? {};
  _cacheLoaded = true;
}

/** キャッシュから判定結果を同期的に取得する（initStage2Cache 呼び出し後に使用可能）。 */
export function getCachedVerdict(cacheKey: string): JudgeCacheEntry | null {
  return _cache[cacheKey] ?? null;
}

/** 判定結果をメモリキャッシュと chrome.storage の両方に保存する。 */
export async function saveJudgeCacheEntry(
  cacheKey: string,
  entry: JudgeCacheEntry,
): Promise<void> {
  _cache[cacheKey] = entry;
  await chrome.storage.local.set({ [JUDGE_CACHE_KEY]: _cache });
}

/**
 * キャッシュキーを生成する。
 * ゲームID + 進行状況 + テキストの組み合わせで一意にする。
 * 同じ動画を同じ進行状況で再視聴した場合にキャッシュが有効になる。
 */
export function buildStage2CacheKey(
  gameId: string,
  progress: GameProgress | undefined,
  text: string,
): string {
  let progressKey = 'none';
  if (progress?.progressModel === 'chapter') {
    progressKey = progress.currentChapterId ?? 'none';
  } else if (progress?.progressModel === 'event') {
    progressKey = [...(progress.completedEventIds ?? [])].sort().join(',') || 'none';
  }
  return `${gameId}|${progressKey}|${text}`;
}
