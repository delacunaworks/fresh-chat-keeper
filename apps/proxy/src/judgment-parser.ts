/**
 * Phase 3 マルチラベル判定の LLM レスポンスパーサー（apps/proxy 専用）。
 *
 * 役割:
 * - Anthropic API から返ってきた生テキストを `[{messageId, labels, primary, confidence, reason_ja}, ...]`
 *   形式の JSON 配列としてパース
 * - 不正値・欠落値に対して fail-safe にフォールバック（クラッシュさせない）
 * - 全メッセージが入力順に対応する判定結果を返す
 *
 * 設計判断:
 * - **fail-safe 既定値は `['safe']` / primary='safe'**（誤検出より見逃しを優先）。
 *   既存 proxy の verdict 計算が verdict='uncertain' で安全側に倒していたのと
 *   同じ趣旨。chrome-ext 側のフィルタ強度設定によっては uncertain が
 *   ブロックされない（lenient = allow）ため、安全側 = pass の方が妥当。
 * - LLM レスポンスは Anthropic 仕様に従って `content[0].text` を読む。
 *   `\`\`\`json ... \`\`\`` フェンスや前後の説明文に強くするため、最初の `[`
 *   から最後の `]` を抽出してから JSON.parse する。
 * - labels の各要素は VALID_LABELS（{@link import('@fresh-chat-keeper/shared').JudgmentLabel}
 *   の値集合）でフィルタする。ハルシネーション（"sex_violence" 等の不正ラベル）は
 *   silently 落とし、結果が空配列になったら `['safe']` にフォールバック。
 * - primary が labels に含まれていない or 不正値なら、{@link derivePrimary} で
 *   labels から再導出する（drift 防止）。
 *
 * 設計 ground truth: `dev-docs/phase-3-multilabel.md` 「レスポンスのパース」
 */

import type { JudgmentLabel } from '@fresh-chat-keeper/shared';
import { derivePrimary } from '@fresh-chat-keeper/judgment-engine';

/**
 * パースされた1メッセージ分の判定結果。
 *
 * proxy 側で {@link import('@fresh-chat-keeper/shared').FilterResult} に
 * 変換される（labels / primary / confidence / reasonJa はそのまま入る）。
 */
export interface ParsedJudgment {
  messageId: string;
  labels: JudgmentLabel[];
  primary: JudgmentLabel;
  /** 0.0〜1.0 の信頼度。LLM 不在/不正値時は 0.5（fail-safe デフォルト） */
  confidence: number;
  /** 日本語の理由説明（任意） */
  reasonJa?: string;
}

/** LLM 出力 1 件の生 JSON エントリ（バリデーション前） */
interface RawJudgmentEntry {
  messageId?: unknown;
  // 設計書 L255-L289 の出力例に従い、labels / primary は単数ではなく配列・単一値
  labels?: unknown;
  primary?: unknown;
  confidence?: unknown;
  reason_ja?: unknown;
}

const VALID_LABELS: readonly JudgmentLabel[] = [
  'safe',
  'spoiler',
  'harassment',
  'spam',
  'off_topic',
  'backseat',
] as const;

/** 安全側に倒す fallback（LLM 全体失敗時 / 個別エントリ失敗時に使用） */
function safeFallback(messageId: string): ParsedJudgment {
  return {
    messageId,
    labels: ['safe'],
    primary: 'safe',
    confidence: 0,
    reasonJa: 'fallback: parse error or missing entry',
  };
}

/**
 * Anthropic API の `content[0].text` を入力として、マルチラベル判定の配列を返す。
 *
 * 入力 messages とは独立に呼べる「テキスト → 配列」関数。proxy 側で配列の各要素を
 * 元メッセージと突き合わせて FilterResult に組み立てる。
 *
 * @param rawText LLM 生応答テキスト
 * @returns パース済み配列。失敗時は空配列（全件 fallback を提案）
 */
export function parseMultiLabelResponseText(rawText: string): RawJudgmentEntry[] {
  // ```json ... ``` フェンスや前後の説明文に強くするため、最初の `[` から最後の `]` を抽出。
  // `\[[\s\S]*\]` は貪欲マッチなので、入れ子配列を含む応答でも全体を捕捉する。
  const arrayMatch = rawText.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];
  // 配列要素はオブジェクト想定。プリミティブが混じっていたら除外。
  return parsed.filter((p): p is RawJudgmentEntry => isPlainObject(p));
}

/**
 * 単一の生エントリを ParsedJudgment にバリデート＋整形する。
 *
 * - labels: VALID_LABELS でフィルタ、空なら `['safe']`
 * - primary: VALID_LABELS なら採用、それ以外は labels から derivePrimary で再導出
 * - confidence: 数値かつ [0, 1] にクランプ。NaN/欠落は 0.5
 * - reasonJa: 文字列のみ採用
 *
 * @param entry 生エントリ
 * @param fallbackMessageId entry.messageId が欠落していたときに使う ID
 */
export function validateJudgmentEntry(
  entry: RawJudgmentEntry,
  fallbackMessageId: string,
): ParsedJudgment {
  const messageId =
    typeof entry.messageId === 'string' && entry.messageId.length > 0
      ? entry.messageId
      : fallbackMessageId;

  const labels = validateLabels(entry.labels);

  let primary: JudgmentLabel;
  if (isJudgmentLabel(entry.primary) && labels.includes(entry.primary)) {
    primary = entry.primary;
  } else {
    primary = derivePrimary(labels);
  }

  const confidence = validateConfidence(entry.confidence);
  const reasonJa = typeof entry.reason_ja === 'string' ? entry.reason_ja : undefined;

  return {
    messageId,
    labels,
    primary,
    confidence,
    ...(reasonJa ? { reasonJa } : {}),
  };
}

/**
 * LLM レスポンスを入力 messages 配列と突き合わせ、各メッセージに対応する
 * `ParsedJudgment` を返す。LLM が一部メッセージを返し損ねた場合は `safeFallback`
 * で埋める。
 *
 * @param rawText LLM 生応答テキスト
 * @param messageIds 元の入力メッセージ ID 配列（順序を保持）
 */
export function parseMultiLabelResponse(
  rawText: string,
  messageIds: readonly string[],
): ParsedJudgment[] {
  const entries = parseMultiLabelResponseText(rawText);

  // LLM 全体失敗 → 全件 safe fallback
  if (entries.length === 0) {
    return messageIds.map((id) => safeFallback(id));
  }

  // messageId をキーにルックアップを作る
  const byId = new Map<string, RawJudgmentEntry>();
  for (const entry of entries) {
    if (typeof entry.messageId === 'string' && entry.messageId.length > 0) {
      byId.set(entry.messageId, entry);
    }
  }

  // 元 messages の順序を維持
  return messageIds.map((id) => {
    const raw = byId.get(id);
    if (!raw) return safeFallback(id);
    return validateJudgmentEntry(raw, id);
  });
}

// ─── 内部ヘルパー ──────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJudgmentLabel(value: unknown): value is JudgmentLabel {
  return typeof value === 'string' && (VALID_LABELS as readonly string[]).includes(value);
}

function validateLabels(value: unknown): JudgmentLabel[] {
  if (!Array.isArray(value)) return ['safe'];
  const filtered = value.filter(isJudgmentLabel);
  // 重複除去（LLM が `['spoiler', 'spoiler']` を返す可能性）
  const unique = Array.from(new Set(filtered));
  return unique.length > 0 ? unique : ['safe'];
}

function validateConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 公開定数（テスト用）。
 */
export const __test__ = {
  VALID_LABELS,
  safeFallback,
  isJudgmentLabel,
  validateLabels,
  validateConfidence,
};
