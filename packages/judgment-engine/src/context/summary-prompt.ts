/**
 * 音声文脈 rolling summary の要約プロンプトビルダー（Phase 7 / P7-B4）。
 *
 * 3 層ウィンドウ（doc §3）のうち L1（近傍要約）/ L2（全体累積要約）を生成する
 * ための **純粋な** プロンプト構築関数。LLM 呼び出し・storage・DO 依存は持たない
 * （judgment-engine の DOM/chrome.* 非依存方針に従う）。
 *
 * 出力契約: モデルには「要約テキストのみを返す」ことを指示する（JSON や前置きを
 * 付けさせない）。呼び出し側（StreamContextDO.alarm）は {@link getSummaryModel} と
 * 合わせて {@link LLMRequest} を組み立て、{@link LLMProvider.complete} に渡す。
 *
 * cache_control は付けない。要約は判定経路の prompt cache 設計に影響させない
 * （doc §4: 非 Anthropic でも効かない / 要約は per-stream で頻度が低い）。
 *
 * 設計 ground truth: dev-docs/phase-7-asr-audio-context.md §3, §4
 */

import type { SystemPromptBlock } from '../stage2/prompt-builder.js';
import type { LLMMessage } from '../llm/provider.js';

/** 要約プロンプトの system / messages 部分（model 設定は呼び出し側が合成）。 */
export interface SummaryPromptParts {
  system: SystemPromptBlock[];
  messages: LLMMessage[];
}

/** L1（近傍要約）の目安文字数。 */
export const L1_TARGET_CHARS = { min: 80, max: 150 } as const;

/** L2（全体累積要約）の文字数上限（storage 肥大・prompt 肥大の抑制）。 */
export const L2_MAX_CHARS = 400;

/**
 * L1（近傍要約）プロンプトを構築する。
 *
 * 直近窓の逐語テキスト（配信者の発言）を 80〜150 字程度の日本語要約にする。
 * ゲーム実況の「いま何が起きているか」を判定 LLM が掴めることが目的。
 *
 * @param recentWindow 直近窓の逐語テキスト（連結済み）
 */
export function buildL1Prompt(recentWindow: string): SummaryPromptParts {
  const system: SystemPromptBlock[] = [
    {
      type: 'text',
      text:
        'あなたはゲーム配信の音声文字起こしを要約するアシスタントです。' +
        '配信者の直近の発言（文字起こし）を読み、いま配信で何が起きているかを' +
        `${L1_TARGET_CHARS.min}〜${L1_TARGET_CHARS.max}字程度の自然な日本語で要約してください。\n` +
        '- 固有名詞・地名・ボス名などはそのまま（漢字のまま）残す。\n' +
        '- 推測で情報を足さない。文字起こしに無い展開を創作しない。\n' +
        '- 箇条書きや前置きを付けず、要約文のみを出力する。',
    },
  ];
  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: `次の直近の発言（文字起こし）を要約してください:\n\n${recentWindow}`,
    },
  ];
  return { system, messages };
}

/**
 * L2（全体累積要約）プロンプトを構築する。
 *
 * 既存の L2（配信全体の累積要約。初回は null）と新しい L1（近傍要約）を畳み込み、
 * 配信序盤からの文脈を保持したまま長くなりすぎない累積要約に更新する。
 *
 * @param existingL2 これまでの累積要約（初回は null）
 * @param newL1      今回生成した近傍要約
 */
export function buildL2Prompt(existingL2: string | null, newL1: string): SummaryPromptParts {
  const system: SystemPromptBlock[] = [
    {
      type: 'text',
      text:
        'あなたはゲーム配信の文脈を追跡するアシスタントです。' +
        '「これまでの累積要約」と「最新の近傍要約」を統合し、配信全体の流れを' +
        `${L2_MAX_CHARS}字以内の日本語でまとめ直してください。\n` +
        '- 序盤からの重要な進行（到達した場所・倒したボス・入手した重要アイテム等）を保持する。\n' +
        '- 古い些末な発話は圧縮・省略してよいが、ネタバレ判定に効く進行情報は残す。\n' +
        '- 固有名詞はそのまま（漢字のまま）残す。推測で足さない。\n' +
        `- ${L2_MAX_CHARS}字を超えない。箇条書きや前置きを付けず、要約文のみを出力する。`,
    },
  ];
  const previous =
    existingL2 && existingL2.trim().length > 0 ? existingL2.trim() : '(まだ累積要約はありません)';
  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: `これまでの累積要約:\n${previous}\n\n最新の近傍要約:\n${newL1}\n\n統合した累積要約を出力してください。`,
    },
  ];
  return { system, messages };
}
