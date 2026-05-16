/**
 * Stage 1.5 のスパム検出ロジック。
 *
 * 検出パターン（評価順、最初にマッチしたものを返す）:
 *   1. rapid_fire           — 同一ユーザーによる連投（10秒以内に他の発言が2件以上）
 *                             ※ 短文（≤ SHORT_TEXT_MAX_CODEPOINTS）は対象外
 *   2. self_copy_paste      — 同一ユーザーが**連続**で同一文言（連続 3 回以上）
 *                             ※ 非連続（間に別文言）は連続リセット。短文でも維持
 *   3. url_spam             — URL が3件以上含まれる（短文でも維持）
 *   4. emoji_spam           — Unicode 絵文字が大半（80%超）かつ長さ20コードポイント超
 *
 * Stage 1.5 確定検出はすべて **同一ユーザー起因 or 明確パターン**のみ。
 * 文脈依存の判別（叫び/協調スパム/定番リアクション）は Stage 2 LLM に委譲する。
 *
 * 撤去の経緯（いずれも非破壊・gray→Stage 2 委譲）:
 * - **character_repeat（同一文字連打）**: B5-fix で撤去。「あああああ」
 *   「うおおおお」等は叫び・感情表現でもあり文字連打のみで spam 確定は誤検出大
 * - **coordinated_copy_paste（横断コピペ＝別アカ3+が同一文言）**: B6a で撤去。
 *   配信のコール&レスポンス／定番リアクション（「うぽつです」「おつかれ
 *   さまでした」等）に誤発火。7 文字超は短文除外でも救えない。協調スパムか
 *   定番リアクションかは文脈依存＝LLM の領分。撤去後 chatHistory は本関数では
 *   未使用（横断検出を将来 Stage 2 文脈で扱う際の signature 安定のため引数は保持）
 *
 * 短文除外（≤ SHORT_TEXT_MAX_CODEPOINTS）は coordinated 撤去により
 * **rapid_fire のみ**が対象。self_copy_paste / url_spam / emoji_spam は短文でも維持。
 *
 * 設計方針:
 * - false-positive を避けるため、各しきい値は保守的に設定
 * - 純粋関数。`HistoryStore` を直接参照せず、`UserMessageHistory` /
 *   `ChatWideHistory` を引数で受け取る（テスト容易性）
 *
 * 設計 ground truth: `dev-docs/phase-3-multilabel.md` 「スパム検出ロジック」
 */

import type { Message } from '../types.js';
import type {
  UserMessageHistory,
  ChatWideHistory,
} from './history-store.js';

/** 連投判定の時間窓（ミリ秒） */
const RAPID_FIRE_WINDOW_MS = 10_000;
/** 連投と判定する「window 内の他発言数」しきい値（>=） */
const RAPID_FIRE_THRESHOLD = 2;
/** URL 羅列と判定するしきい値（>=） */
const URL_SPAM_THRESHOLD = 3;
/** 絵文字スパムと判定する「絵文字コードポイント比率」（>=） */
const EMOJI_SPAM_RATIO = 0.8;
/** 絵文字スパムと判定する最小長（コードポイント単位） */
const EMOJI_SPAM_MIN_LENGTH = 20;
/**
 * 「短文」と見なすコードポイント長の上限（<=）。これ以下のメッセージは
 * **rapid_fire の対象外**（定番リアクション保護）。coordinated_copy_paste
 * 撤去（B6a）により短文除外が効くのは rapid_fire のみになった。
 * 「ざわざわ」(4) / 「うおお」(3) / 「草」(1) / 「888」(3) を救う目安値。
 */
const SHORT_TEXT_MAX_CODEPOINTS = 6;

export type SpamDetectionResult =
  | { type: 'none' }
  | { type: 'rapid_fire'; confidence: number }
  | { type: 'self_copy_paste'; confidence: number }
  | { type: 'url_spam'; confidence: number }
  | { type: 'emoji_spam'; confidence: number };

/**
 * スパム検出のエントリポイント。
 *
 * 引数の `userHistory` は判定対象メッセージ自身を含まない想定。
 * 判定対象を履歴に積むのは spam 判定の「後」とすること
 * （履歴に含まれていると `self_copy_paste` が常に発火するため）。
 *
 * @param message 判定対象メッセージ
 * @param userHistory 同一ユーザーの過去メッセージ履歴（TTL 内）
 * @param _chatHistory チャット横断履歴。coordinated_copy_paste 撤去（B6a）
 *   により現状未使用。横断検出を将来 Stage 2 文脈で扱う際の signature
 *   安定のため引数は保持する
 */
export function detectSpam(
  message: Message,
  userHistory: UserMessageHistory,
  _chatHistory: ChatWideHistory,
): SpamDetectionResult {
  // B5-fix: 短文は定番リアクション（「ざわざわ」「うおお」「草」「888」等）が
  // 短時間で自然に重なるため rapid_fire の対象外にする（B6a で coordinated を
  // 撤去したので短文除外が効くのは rapid_fire のみ）。
  const isShortText =
    Array.from(message.text).length <= SHORT_TEXT_MAX_CODEPOINTS;

  // 1. 連投: 直近 RAPID_FIRE_WINDOW_MS 内に同一ユーザーが他の発言を
  //    RAPID_FIRE_THRESHOLD 件以上していたら連投扱い（短文は除外）
  if (!isShortText) {
    const recentByUser = userHistory.messages.filter(
      (m) =>
        message.timestamp - m.timestamp < RAPID_FIRE_WINDOW_MS &&
        message.timestamp - m.timestamp >= 0 &&
        m.text !== message.text,
    );
    if (recentByUser.length >= RAPID_FIRE_THRESHOLD) {
      return { type: 'rapid_fire', confidence: 0.9 };
    }
  }

  // 2. 自己コピペ: 同一ユーザーが**連続**で同一文言を投稿（連続 3 回以上）。
  //    B6b: 旧実装は履歴全体に同一文言 1 件で 2 回目発火（非連続でも発火）し、
  //    「あじまるあじまる」コール時の "あじまる" 誤送信→再送信（連続 2 回）を
  //    誤検出していた。最新から遡り message.text と一致し続ける件数を数え、
  //    別文言が出たら連続終了（break）。連続一致が 2 件以上＝今回投稿を入れて
  //    連続 3 回以上でのみ発火（時間差は不問。間に別文言が挟まれば連続リセット）。
  //    userHistory.messages は古い順（末尾が最新、message 自身は未追加）。
  let consecutiveSame = 0;
  for (let i = userHistory.messages.length - 1; i >= 0; i--) {
    if (userHistory.messages[i].text === message.text) {
      consecutiveSame++;
    } else {
      break;
    }
  }
  if (consecutiveSame >= 2) {
    return { type: 'self_copy_paste', confidence: 0.95 };
  }

  // 3. 横断コピペ（coordinated_copy_paste）は B6a で撤去。コール&レスポンス／
  //    定番リアクションと協調スパムは文脈依存のため Stage 2 LLM に委譲する。

  // 4. URL 羅列: URL が URL_SPAM_THRESHOLD 個以上（短文でも維持）
  const urlMatches = message.text.match(/https?:\/\/\S+/g) ?? [];
  if (urlMatches.length >= URL_SPAM_THRESHOLD) {
    return { type: 'url_spam', confidence: 0.9 };
  }

  // 5. 絵文字スパム: 絵文字比率 EMOJI_SPAM_RATIO 超 かつ
  //    コードポイント長 EMOJI_SPAM_MIN_LENGTH 超
  if (isMainlyEmoji(message.text)) {
    return { type: 'emoji_spam', confidence: 0.8 };
  }

  return { type: 'none' };
}

/**
 * テキストが「ほぼ絵文字のみ」で構成されているか判定。
 *
 * 判定条件: コードポイント長 EMOJI_SPAM_MIN_LENGTH 超 かつ
 * Extended_Pictographic コードポイントの比率が EMOJI_SPAM_RATIO 超。
 */
function isMainlyEmoji(text: string): boolean {
  const codePoints = Array.from(text);
  if (codePoints.length <= EMOJI_SPAM_MIN_LENGTH) return false;
  // Extended_Pictographic は絵文字本体。バリエーションセレクタ（FE0F）や
  // ZWJ（200D）は含まれないが、本体だけで比率を見れば十分。
  let emojiCount = 0;
  for (const cp of codePoints) {
    if (/\p{Extended_Pictographic}/u.test(cp)) {
      emojiCount++;
    }
  }
  return emojiCount / codePoints.length > EMOJI_SPAM_RATIO;
}

/**
 * しきい値定数の公開（テスト用 / Chrome 拡張側からのチューニング参照用）。
 */
export const SPAM_DETECTION_THRESHOLDS = {
  RAPID_FIRE_WINDOW_MS,
  RAPID_FIRE_THRESHOLD,
  URL_SPAM_THRESHOLD,
  EMOJI_SPAM_RATIO,
  EMOJI_SPAM_MIN_LENGTH,
  SHORT_TEXT_MAX_CODEPOINTS,
} as const;
