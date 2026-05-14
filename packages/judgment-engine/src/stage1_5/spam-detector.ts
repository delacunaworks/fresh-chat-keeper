/**
 * Stage 1.5 のスパム検出ロジック。
 *
 * 検出パターン（評価順、最初にマッチしたものを返す）:
 *   1. rapid_fire           — 同一ユーザーによる連投（10秒以内に他の発言が2件以上）
 *   2. self_copy_paste      — 同一ユーザーが過去に投稿した内容を再投稿（自己コピペ）
 *   3. coordinated_copy_paste — 別の3アカウント以上が同一文言を投稿（横断コピペ）
 *   4. character_repeat     — 同一文字を10回以上連打（「ああああああああああ」）
 *   5. url_spam             — URL が3件以上含まれる
 *   6. emoji_spam           — Unicode 絵文字が大半（80%超）かつ長さ20コードポイント超
 *
 * 設計方針:
 * - false-positive を避けるため、各しきい値は保守的に設定
 *   （「888」「草www」「同じ感想を2回投稿」程度は spam にしない）
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
/** 横断コピペと判定する「異なるアカウント数」しきい値（>=） */
const COORDINATED_THRESHOLD = 3;
/**
 * 文字連打と判定する最小コードポイント長。
 * 全体が同一コードポイントのみで構成され、かつこの長さ以上で発火。
 */
const CHARACTER_REPEAT_MIN_LENGTH = 10;
/** URL 羅列と判定するしきい値（>=） */
const URL_SPAM_THRESHOLD = 3;
/** 絵文字スパムと判定する「絵文字コードポイント比率」（>=） */
const EMOJI_SPAM_RATIO = 0.8;
/** 絵文字スパムと判定する最小長（コードポイント単位） */
const EMOJI_SPAM_MIN_LENGTH = 20;

export type SpamDetectionResult =
  | { type: 'none' }
  | { type: 'rapid_fire'; confidence: number }
  | { type: 'self_copy_paste'; confidence: number }
  | { type: 'coordinated_copy_paste'; confidence: number }
  | { type: 'character_repeat'; confidence: number }
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
 * @param chatHistory チャット横断履歴（TTL 内）
 */
export function detectSpam(
  message: Message,
  userHistory: UserMessageHistory,
  chatHistory: ChatWideHistory,
): SpamDetectionResult {
  // 1. 連投: 直近 RAPID_FIRE_WINDOW_MS 内に同一ユーザーが他の発言を
  //    RAPID_FIRE_THRESHOLD 件以上していたら連投扱い
  //    （同一文言の連投は self_copy_paste で先に捕捉されるよう、ここでは
  //     「他発言」のみを数える）
  const recentByUser = userHistory.messages.filter(
    (m) =>
      message.timestamp - m.timestamp < RAPID_FIRE_WINDOW_MS &&
      message.timestamp - m.timestamp >= 0 &&
      m.text !== message.text,
  );
  if (recentByUser.length >= RAPID_FIRE_THRESHOLD) {
    return { type: 'rapid_fire', confidence: 0.9 };
  }

  // 2. 自己コピペ: 同一ユーザーが過去に全く同じ文言を投稿していた
  const identicalByUser = userHistory.messages.filter(
    (m) => m.text === message.text,
  );
  if (identicalByUser.length >= 1) {
    return { type: 'self_copy_paste', confidence: 0.95 };
  }

  // 3. 横断コピペ: 別アカウント COORDINATED_THRESHOLD 個以上が同一文言を投稿
  //    （投稿者自身は除く。集計はアカウント単位、同一アカウントの複数投稿は1としてカウント）
  const distinctOtherChannelIds = new Set<string>();
  for (const m of chatHistory.messages) {
    if (m.text === message.text && m.channelId !== message.authorChannelId) {
      distinctOtherChannelIds.add(m.channelId);
    }
  }
  if (distinctOtherChannelIds.size >= COORDINATED_THRESHOLD) {
    return { type: 'coordinated_copy_paste', confidence: 0.85 };
  }

  // 4. 文字連打: 全体が同一コードポイントの繰り返しで、長さが
  //    CHARACTER_REPEAT_MIN_LENGTH 以上（例: "ああああああああああ"）。
  //    部分的に同一文字が並ぶケース（例: "おはよう！ああああ"）は誤検出を避けるため対象外。
  if (isAllSameCharacterAndLong(message.text, CHARACTER_REPEAT_MIN_LENGTH)) {
    return { type: 'character_repeat', confidence: 0.95 };
  }

  // 5. URL 羅列: URL が URL_SPAM_THRESHOLD 個以上
  const urlMatches = message.text.match(/https?:\/\/\S+/g) ?? [];
  if (urlMatches.length >= URL_SPAM_THRESHOLD) {
    return { type: 'url_spam', confidence: 0.9 };
  }

  // 6. 絵文字スパム: 絵文字比率 EMOJI_SPAM_RATIO 超 かつ
  //    コードポイント長 EMOJI_SPAM_MIN_LENGTH 超
  if (isMainlyEmoji(message.text)) {
    return { type: 'emoji_spam', confidence: 0.8 };
  }

  return { type: 'none' };
}

/**
 * テキスト全体が同一コードポイントで構成され、かつ長さが minLength 以上か。
 *
 * 単純な `/^(.)\1{N,}$/` 正規表現はサロゲートペア（絵文字等）で誤判定する
 * （上位/下位サロゲートそれぞれを別文字として扱うため、絵文字の連打が
 * 「2文字パターンの繰り返し」になり捕捉できない）。Array.from で
 * コードポイント単位に分割してから比較する。
 *
 * 設計判断: 設計書 `phase-3-multilabel.md` の正規表現 `/^(.)\1{9,}$/`
 * (= 全体一致の10文字以上同一文字) に揃えている。`/(.)\1{9,}/` のような
 * 部分一致版は誤検出が増えるため採用しない。
 */
function isAllSameCharacterAndLong(text: string, minLength: number): boolean {
  const codePoints = Array.from(text);
  if (codePoints.length < minLength) return false;
  const first = codePoints[0];
  for (let i = 1; i < codePoints.length; i++) {
    if (codePoints[i] !== first) return false;
  }
  return true;
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
  COORDINATED_THRESHOLD,
  CHARACTER_REPEAT_MIN_LENGTH,
  URL_SPAM_THRESHOLD,
  EMOJI_SPAM_RATIO,
  EMOJI_SPAM_MIN_LENGTH,
} as const;
