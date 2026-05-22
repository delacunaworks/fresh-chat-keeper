/**
 * Phase 3 マルチラベル判定の LLM レスポンスパーサー（apps/proxy 専用）。
 *
 * 役割:
 * - Anthropic API から返ってきた生テキストを `[{messageId, labels, primary, confidence, reason_ja}, ...]`
 *   形式の JSON 配列としてパース
 * - 不正値・欠落値に対して fail-safe にフォールバック（クラッシュさせない）
 * - 全メッセージが入力順に対応する判定結果を返す
 *
 * 設計判断（CLAUDE.md 設計原則 3 の例外運用 / phase-3-multilabel.md §追補 2）:
 * - **fail-safe 既定値は `['safe']` / primary='safe'**。Stage 2 に来るのは定義上
 *   gray（Stage 1/1.5 で判別不能）。判定できなければ通る＝実質 safe。全件 block は
 *   正常コメントも全消しで体験破壊。「安全側に倒す」原則の Stage 2 パース失敗時
 *   例外として「通すが恒久キャッシュせず、見逃しは FN 報告（P3-UI-06）で回収」。
 * - パース失敗（配列抽出不可 / JSON.parse 例外）は **握り潰さず** 呼び出し側へ
 *   伝える（{@link parseMultiLabelResponseDetailed} の `degraded`）。proxy は
 *   warn → 1 回再送リトライ → なお失敗なら全件 safe + `degraded:true` を返し、
 *   chrome-ext は degraded を safe キャッシュに永続化しない（再判定の余地を残す）。
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
import { derivePrimary, LABEL_PRECEDENCE } from '@fresh-chat-keeper/judgment-engine';

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

/**
 * 妥当なラベル集合。{@link LABEL_PRECEDENCE}（judgment-engine の単一の真実）を
 * そのまま流用する。`includes` での membership 判定にしか使わないので順序は不問。
 * 別配列で二重管理すると LABEL_PRECEDENCE 追加時に typo・追記漏れが起きるため、
 * 導出に統一する。
 */
const VALID_LABELS: readonly JudgmentLabel[] = LABEL_PRECEDENCE;

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
 * パース状態の分類。`degraded` 判定に使う。
 * - `ok`: 配列抽出 + JSON.parse 成功（空配列 `[]` も ok。LLM が空回答した
 *   だけで「壊れた」わけではない＝部分 safeFallback で正常運用）
 * - `no_array`: テキストに JSON 配列が見つからない（空文字 / 説明文のみ等）
 * - `json_error`: 配列らしき断片はあるが JSON.parse が例外
 */
export function classifyParse(
  rawText: string,
): { status: 'ok' | 'no_array' | 'json_error'; error?: unknown } {
  const arrayMatch = rawText.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return { status: 'no_array' };
  try {
    JSON.parse(arrayMatch[0]);
    return { status: 'ok' };
  } catch (error) {
    return { status: 'json_error', error };
  }
}

/**
 * パース失敗（`degraded`）を判別できる詳細版。proxy はこちらを使い、
 * `degraded` の場合 1 回リトライ → なお失敗なら `degraded:true` を伝播する。
 *
 * `degraded` は **テキストが壊れている**（no_array / json_error）場合のみ true。
 * 正常にパースできたが一部メッセージが欠ける（部分 safeFallback）のは
 * degraded ではない（LLM が一部を返さなかっただけ、再判定不要）。
 */
export function parseMultiLabelResponseDetailed(
  rawText: string,
  messageIds: readonly string[],
): { judgments: ParsedJudgment[]; degraded: boolean } {
  const cls = classifyParse(rawText);
  return {
    judgments: parseMultiLabelResponse(rawText, messageIds),
    degraded: cls.status !== 'ok',
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
  classifyParse,
};
