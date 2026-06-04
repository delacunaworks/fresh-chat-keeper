/**
 * Stage 2 判定結果キャッシュ。
 *
 * 同一の動画を複数回視聴する際にAPI呼び出しを節約する。
 * ストレージ実装は呼び出し側で注入する（Chrome拡張は `chrome.storage.local`、
 * Cloudflare Workers は KV、テストはインメモリ等）。判定エンジン本体は
 * chrome.* / Web API には依存しない。
 *
 * @see dev-docs/phase-2-engine-split.md §キャッシュ
 */

import type { Judgment, JudgmentContext } from '../types.js';
import { normalizeText } from '../utils/normalize.js';
import { hashString } from '../utils/hash.js';
import { getProgressSignature } from '../utils/progress-signature.js';

/** キャッシュ1エントリの値 */
export interface CacheEntry {
  judgment: Judgment;
  /** Unix ms。{@link CacheOptions.ttlMs} と組み合わせて有効期限を判定 */
  cachedAt: number;
}

/**
 * キャッシュストレージ抽象。
 *
 * 全メソッド非同期。Chrome拡張側では `chrome.storage.local` 由来の Promise、
 * Cloudflare Workers では KV 由来の Promise をそのまま返す実装になる。
 */
export interface CacheStorage {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, value: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

/** {@link JudgmentCache} のコンストラクタオプション */
export interface CacheOptions {
  storage: CacheStorage;
  /** TTL（ミリ秒）。未指定なら有効期限なし */
  ttlMs?: number;
}

/**
 * テキストとコンテキストを組み合わせてキャッシュキーを生成し、
 * `CacheStorage` にエントリを保管・取得するクラス。
 *
 * - キーは `<contextHash>:<textHash>` の形式（先頭がコンテキスト由来）
 * - 取得時に TTL 切れエントリは自動削除する
 * - 取得した `Judgment` は `fromCache: true` に書き換えて返す
 */
export class JudgmentCache {
  constructor(private readonly options: CacheOptions) {}

  /**
   * キャッシュキーを構築する。
   *
   * テキストはカナ正規化・トリム・小文字化を経てから FNV-1a でハッシュ化。
   * コンテキストは判定結果に影響するフィールドのみを抽出してハッシュ化する
   * （ゲームID・進行状況シグネチャ・フィルタ強度）。
   *
   * Phase 5 P5-B4a: optional `captionSig`（字幕シグネチャ、
   * {@link import('../context/cache-signature.js').captionCacheSignature} 由来）を
   * 受ける。**後方互換: `'nocap'`（既定・字幕 OFF/未配線）のときは v0.5.0 と
   * バイト一致のキー**（`${contextHash}:${textHash}`）を返す。字幕ありのときだけ
   * contextHash と textHash の間に要素を挿入する。配線は P5-B4b。
   */
  buildKey(text: string, context: JudgmentContext, captionSig: string = 'nocap'): string {
    const normalized = normalizeText(text);
    const contextHash = hashString(
      JSON.stringify({
        gameId: context.game?.gameId,
        progress: getProgressSignature(context.game),
        strength: context.settings.categories.spoiler.strength,
      }),
    );
    // 後方互換: nocap のときは現行と完全同一のキー（バイト一致）。
    if (captionSig === 'nocap') {
      return `${contextHash}:${hashString(normalized)}`;
    }
    return `${contextHash}:${captionSig}:${hashString(normalized)}`;
  }

  /**
   * キャッシュ取得。TTL 切れの場合は内部で削除して null を返す。
   * ヒットした場合 `fromCache: true` フラグを立てた Judgment を返す。
   */
  async get(
    text: string,
    context: JudgmentContext,
    captionSig: string = 'nocap',
  ): Promise<Judgment | null> {
    const key = this.buildKey(text, context, captionSig);
    const entry = await this.options.storage.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      await this.options.storage.delete(key);
      return null;
    }
    return { ...entry.judgment, fromCache: true };
  }

  /**
   * キャッシュ保存。`cachedAt` には現在時刻（Unix ms）を入れる。
   */
  async set(
    text: string,
    context: JudgmentContext,
    judgment: Judgment,
    captionSig: string = 'nocap',
  ): Promise<void> {
    const key = this.buildKey(text, context, captionSig);
    await this.options.storage.set(key, {
      judgment,
      cachedAt: Date.now(),
    });
  }

  /**
   * 任意のキーで明示的に削除。テストや外部からのキャッシュ無効化に使う。
   */
  async delete(
    text: string,
    context: JudgmentContext,
    captionSig: string = 'nocap',
  ): Promise<void> {
    const key = this.buildKey(text, context, captionSig);
    await this.options.storage.delete(key);
  }

  private isExpired(entry: CacheEntry): boolean {
    if (this.options.ttlMs === undefined) return false;
    return Date.now() - entry.cachedAt > this.options.ttlMs;
  }
}

/**
 * テスト・ローカル動作確認用のインメモリ {@link CacheStorage} 実装。
 * 本番（chrome.storage / Workers KV）では別実装を注入する。
 */
export function createMemoryStorage(): CacheStorage {
  const map = new Map<string, CacheEntry>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}
