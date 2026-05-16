/**
 * Stage 1.5: パターン分析レイヤー（Phase 3 / v0.4.0 新設）。
 *
 * 役割:
 * - Stage 1 で `gray` になったメッセージのうち、明らかなスパム（連投・
 *   コピペ・文字連打・URL羅列・絵文字連打等）を Stage 2（LLM）に
 *   送る前にメモリ内パターン検出で確定させる
 * - 履歴を必要とするため、`HistoryStore` をタブごとに1つ持ち回る
 *
 * 公開API:
 * - {@link runStage1_5} — エントリポイント。Stage 1 の後・Stage 2 の前に呼ぶ
 * - {@link HistoryStore} — メモリ内履歴ストア（タブ単位で保持）
 * - {@link detectSpam} — 純粋なスパム検出関数（履歴を引数で渡す）
 *
 * 統合パターン（Chrome 拡張側、B2 で実装予定）:
 * ```ts
 * const historyStore = new HistoryStore();
 * watchUrlChange(() => historyStore.clear());
 *
 * const stage1 = runStage1(message, context);
 * if (stage1.outcome !== 'gray') return stage1ToJudgment(stage1);
 *
 * const stage1_5 = runStage1_5(message, context, historyStore);
 * if (stage1_5.outcome === 'filter') return stage1_5ToJudgment(stage1_5);
 *
 * // gray → Stage 2 へ
 * ```
 *
 * 設計 ground truth: `dev-docs/phase-3-multilabel.md` 「Stage 1.5のエントリーポイント」
 */

import type { Message, JudgmentContext, JudgmentLabel } from '../types.js';
import { HistoryStore } from './history-store.js';
import {
  detectSpam,
  SPAM_DETECTION_THRESHOLDS,
  type SpamDetectionResult,
} from './spam-detector.js';

/** Stage 1.5 で確定的なフィルタを発火させる最小 confidence */
const SPAM_FILTER_MIN_CONFIDENCE = 0.8;

/**
 * Stage 1.5 の判定結果。
 *
 * - `filter`: 確定的にブロック対象（Stage 2 を通さない）
 * - `gray`:   Stage 2 に委ねる
 *
 * Stage 1 の `Stage1Result` と異なり `pass` 系は持たない（Stage 1.5 は
 * 「明らかなスパム以外は素通し」の役割なので、確定 pass は出さない）。
 */
export type Stage1_5Result =
  | {
      outcome: 'filter';
      label: JudgmentLabel;
      reason: string;
      confidence: number;
    }
  | { outcome: 'gray'; reason: string };

/**
 * Stage 1.5 のエントリポイント。
 *
 * 評価順:
 * 1. スパム判定（{@link detectSpam}）→ `spam` カテゴリが ON かつ
 *    confidence が SPAM_FILTER_MIN_CONFIDENCE 以上なら filter
 * 2. それ以外 → gray（Stage 2 に委ねる）
 *
 * 副作用:
 * - 判定後に `historyStore.addMessage(message)` を呼んで履歴に積む
 * - 判定対象を履歴に積むのは判定の「後」にすること
 *   （履歴に含まれていると self_copy_paste / rapid_fire を誤発火する）
 *
 * 設定参照:
 * - `context.settings.categories.spam?.enabled` が真のときのみフィルタする
 * - `categories.spam` は v2 スキーマで optional（Phase 3 の v3 マイグレーションで
 *   常時存在になる予定）。optional chain で読み、未設定時は OFF として扱う
 *
 * @param message 判定対象メッセージ
 * @param context 判定コンテキスト（設定）
 * @param historyStore タブ単位で持ち回るメモリ内履歴
 */
export function runStage1_5(
  message: Message,
  context: JudgmentContext,
  historyStore: HistoryStore,
): Stage1_5Result {
  const now = message.timestamp;
  const userHistory = historyStore.getUserHistory(
    message.authorChannelId,
    now,
  );
  const chatHistory = historyStore.getChatHistory(now);

  const spamResult: SpamDetectionResult = detectSpam(
    message,
    userHistory,
    chatHistory,
  );

  // 履歴更新は判定後（自己コピペ等の誤発火を避ける）
  historyStore.addMessage(message);

  // B6a 可観測性ログ: 短文除外（≤ SHORT_TEXT_MAX_CODEPOINTS）で rapid_fire を
  // 見送り gray に落ちた経路を debug 可視化（「なぜ弾かれない？」の調査用。
  // 通常運用ではノイズにならない debug レベル）。
  if (
    spamResult.type === 'none' &&
    Array.from(message.text).length <=
      SPAM_DETECTION_THRESHOLDS.SHORT_TEXT_MAX_CODEPOINTS
  ) {
    console.debug(
      `[FreshChatKeeper] Stage 1.5: short text (≤${SPAM_DETECTION_THRESHOLDS.SHORT_TEXT_MAX_CODEPOINTS}cp) exempt from rapid_fire; passing to Stage 2`,
    );
  }

  if (
    spamResult.type !== 'none' &&
    spamResult.confidence >= SPAM_FILTER_MIN_CONFIDENCE
  ) {
    // spam カテゴリが ON のときだけフィルタする。
    // categories.spam は v2 スキーマで optional のため optional chain で読む。
    // v3 マイグレーション（P3-MIG-01）後は常時存在に変わるが、本コードは
    // 自然に動作する。
    const spamEnabled = context.settings.categories.spam?.enabled === true;
    if (spamEnabled) {
      return {
        outcome: 'filter',
        label: 'spam',
        reason: spamResult.type,
        confidence: spamResult.confidence,
      };
    }
    // B4a hardening 🟡: spam を検出したが spam カテゴリ OFF のため見送り。
    // サイレントに gray へ落ちると「なぜ弾かれない？」の調査が困難なので
    // debug ログで可視化（通常運用ではノイズにならない debug レベル）。
    console.debug(
      `[FreshChatKeeper] Stage 1.5: spam pattern '${spamResult.type}' detected but spam category is OFF; passing through`,
    );
  }

  return { outcome: 'gray', reason: 'needs_stage2' };
}

// ─── 公開エクスポート ───────────────────────────────────────
export {
  HistoryStore,
  USER_HISTORY_MAX,
  USER_HISTORY_TTL_MS,
  CHAT_HISTORY_MAX,
  CHAT_HISTORY_TTL_MS,
} from './history-store.js';
export type {
  UserHistoryEntry,
  UserMessageHistory,
  ChatHistoryEntry,
  ChatWideHistory,
} from './history-store.js';
export { detectSpam, SPAM_DETECTION_THRESHOLDS } from './spam-detector.js';
export type { SpamDetectionResult } from './spam-detector.js';
