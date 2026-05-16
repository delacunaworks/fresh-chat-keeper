/**
 * Stage 2 LLM 判定用のプロンプトビルダー（Phase 3 / v0.4.0 マルチラベル対応）。
 *
 * Phase 2 まで: 単一カテゴリ（`spoiler_category`）出力で proxy 側がネタバレ
 * サブカテゴリ → verdict 変換していた。
 *
 * Phase 3: マルチラベル分類（6 ラベル: safe / spoiler / harassment / spam /
 * off_topic / backseat）に変更。各メッセージに対して `labels[]` と `primary`
 * （{@link LABEL_PRECEDENCE} で導出）と `confidence` と `reason_ja` を返す
 * フォーマットを LLM に指示する。
 *
 * 出力構造（{@link buildSystemPrompt}）:
 * - Block 1: 固定指示（役割定義 + 6 ラベル定義 + 強度設定の意味 + primary 優先順位 + 出力形式）
 *   → 全リクエストで完全に同一なのでキャッシュ可
 * - Block 2: 動的コンテキスト（ゲーム情報 + ユーザーのフィルタ設定）
 *   → 同一ユーザーの同一動画再生中は5分以上同じ内容になりがちなのでキャッシュ可
 *
 * Block 2 は判定対象メッセージを含まない。動的な部分（メッセージ列）は
 * {@link buildUserPrompt} で user role に流し込む。
 *
 * 設計 ground truth: `dev-docs/phase-3-multilabel.md` 「プロンプト設計（詳細）」
 */

import type { JudgmentContext } from '../types.js';
import type { GameContext, FilterSettings } from '@fresh-chat-keeper/shared';
import { getAllGenreTemplates } from '@fresh-chat-keeper/knowledge-base';
import { LABEL_PRECEDENCE } from './label-precedence.js';

/**
 * Anthropic API の system 配列に渡せる単一ブロック型。
 * `cache_control` を付与したブロックは API 側で5分間キャッシュされる。
 */
export interface SystemPromptBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** {@link buildSystemPrompt} のオプション */
export interface BuildSystemPromptOptions {
  /**
   * モデルがプロンプトキャッシングをサポートするか。
   * `false` のときは `cache_control` を一切付与しない。
   * 通常は `getEffectiveModel(tier).supportsCaching` の値を渡す。
   */
  supportsCaching: boolean;
}

/** メッセージの最小入力（buildUserPrompt 用） */
export interface PromptMessage {
  id: string;
  text: string;
}

/**
 * システムプロンプトを構築する（複数ブロック）。
 *
 * @param context 判定コンテキスト（ゲーム情報 + ユーザー設定）
 * @param options モデルキャッシング対応有無
 * @returns Anthropic API の system 配列にそのまま渡せるブロック列
 */
export function buildSystemPrompt(
  context: JudgmentContext,
  options: BuildSystemPromptOptions,
): SystemPromptBlock[] {
  const blocks: SystemPromptBlock[] = [];

  // Block 1: 固定指示（全リクエストで完全に同一）
  blocks.push({
    type: 'text',
    text: STATIC_INSTRUCTIONS,
    ...(options.supportsCaching ? { cache_control: { type: 'ephemeral' } } : {}),
  });

  // Block 2: 動的コンテキスト（ゲーム + ユーザーのフィルタ設定）
  const block2 = buildDynamicContextBlock(context);
  if (block2) {
    blocks.push({
      type: 'text',
      text: block2,
      ...(options.supportsCaching ? { cache_control: { type: 'ephemeral' } } : {}),
    });
  }

  return blocks;
}

/**
 * ユーザープロンプト（メッセージバッチの動的部分）を構築する。
 *
 * 既存 proxy では1メッセージずつリクエストしていたが、本実装では
 * バッチで複数メッセージを1リクエストにまとめる前提のため、配列形式で送信する。
 * モデルからの返答も messageId をキーにした配列で受ける想定。
 */
export function buildUserPrompt(messages: readonly PromptMessage[]): string {
  if (messages.length === 0) return '';

  const lines: string[] = ['判定対象メッセージ（messageId と text のペア）:'];
  for (const m of messages) {
    // Anthropic API に渡す段階でテキスト内の引用符・改行は問題ないが、
    // メッセージ間の区切りを明確にするため箇条書き形式で1行ずつ出力する。
    const safeText = m.text.replace(/\n/g, ' ');
    lines.push(`- id: ${JSON.stringify(m.id)}, text: ${JSON.stringify(safeText)}`);
  }
  return lines.join('\n');
}

// ─── 内部実装: Block 1 ────────────────────────────────────────────────

/**
 * 役割定義 + 6 ラベル定義（強度設定の意味込み）+ primary 優先順位 + 出力形式。
 *
 * 完全に静的。`LABEL_PRECEDENCE` 配列を読んで優先順位文字列を生成しているため、
 * 配列を更新すると本プロンプトも追従する（drift しない）。
 *
 * 既存 proxy の `direct_spoiler` / `foreshadowing_hint` / `gameplay_hint` /
 * `safe` という4種出力からの完全な切り替え。`spoiler` の中の3段階は本プロンプト
 * 内で `strength` 設定として記述し、proxy のサブカテゴリ → verdict 変換は廃止する。
 */
const STATIC_INSTRUCTIONS = `あなたは YouTube 配信のチャットコメントを分析するモデレーター AI です。
各コメントに該当するラベルを **全て** 返してください（マルチラベル分類）。

# ラベル定義

## safe
問題のないコメント:
- 感想・応援・共感（「かわいい」「面白い」「がんばれ」）
- 定型リアクション（「草」「w」「88888」）
- ゲーム・配信内容への肯定的コメント

## spoiler
ゲームのネタバレ・伏線の匂わせ・攻略ヒント。視聴者の進行状況より先の情報への言及。
強度判定:
- strict: 明示的ネタバレ + 匂わせ + 攻略ヒントの全てをブロック
- standard: 明示的ネタバレ + 匂わせをブロック（攻略ヒントは safe）
- loose: 明示的ネタバレのみブロック

## harassment
配信者または他視聴者への攻撃的コメント。
強度判定:
- strict: 軽度の否定的コメントも含む（「上手くないね」等）
- standard: 明確な攻撃・侮辱・差別発言
- loose: 強い侮辱・差別的発言のみ

## spam
意味のない・繰り返しの・宣伝目的のコメント。
（spam には強度設定がない。enabled / disabled の二択）

## off_topic
**配信／ゲーム内容と無関係なコメント**。無害かどうかは無関係。次を含む:
- 日常雑談・私事・時事: 食事「今日の晩ごはん何にしよう」/ 天気「明日の天気どうかな」/
  交通「電車遅延でまだ帰れない」/ 経済・スポーツ・芸能「株価下がってる」「昨日の野球見た？」
- 他配信者・他コンテンツへの言及や比較: 「◯◯の配信のほうが面白い」「△△ちゃん今何やってる？」
  「□□引退したの？」「◇◇のコラボそろそろ始まる」「推しのライブ当たった（この配信と無関係）」
判定の勘所: **配信／ゲームに関係しない話題なら、たとえ穏やかで友好的でも off_topic**。
「配信内容への反応・応援・感想」は safe、「配信と無関係な話題」は off_topic（下記 safe との境界参照）。
強度判定:
- strict: 配信内容と無関係な話題全般（日常雑談・時事・他配信者言及）をブロック
- standard: 他配信者・他コンテンツへの明確な言及のみブロック（無害な日常雑談は safe 寄り）
- loose: 明らかに煽り目的の他配信者言及のみブロック

## backseat
頼まれていない攻略指示、プレイ批判、押し付けがましい助言（VTuber 配信で特に嫌われる）。
強度判定:
- strict: 攻略情報・プレイ批判全般をブロック
- standard: 明確な指示・否定をブロック
- loose: 強い押し付け口調のみブロック

# 判定方針

1. **文脈を読む**: 単語だけでなく、配信の流れと照らし合わせる
2. **複数ラベル可**: 1コメントが複数カテゴリに該当することがある
   例:「下手すぎ、左に行くべきだろ」→ ["harassment", "backseat"]
3. **primary（主要ラベル）は最も深刻なもの**を選ぶ。優先度（高い順）:
   ${LABEL_PRECEDENCE.join(' > ')}
4. **曖昧な場合は safe に倒す**（誤検出を避ける）。ただし *off_topic か safe か*
   の判断は「曖昧」ではなく **配信／ゲームに関係する話題か否か** の二択で機械的に
   行う: 関係する反応・応援・感想・定型リアクション＝safe／関係しない話題
   （日常雑談・時事・他配信者言及）＝off_topic。穏やかさ・友好性は safe の根拠に
   ならない（off_topic は無害でも off_topic）
5. **VTuber 文化への配慮**: その配信／ゲームに関する身内ネタ・推し発言・定型
   リアクション（「草」「てぇてぇ」「うぽつ」等）は safe。ただし **配信と無関係な
   日常雑談・他配信者への言及は off_topic**（VTuber 配慮を理由に safe にしない）
6. **safe と off_topic の境界（重要）**: 「この配信／プレイ中のゲームに向けられた
   発話か？」を最初に判定する。Yes→safe 系、No→off_topic。例: 「このボス強いね」=safe、
   「お腹すいた、晩ごはん何にしよう」=off_topic、「◯◯の配信のほうが好き」=off_topic
7. **OFF のカテゴリ**: 視聴者がそのカテゴリを OFF にしている場合、該当する判定を行わず safe として扱う

# 出力形式

**JSON 配列のみ** で回答（前後に説明文や \`\`\`json フェンスを付けない）。
各メッセージに対応する判定を、入力と同じ順序で返す:

[
  {
    "messageId": "<入力の id をそのまま>",
    "labels": ["safe" | "spoiler" | "harassment" | "spam" | "off_topic" | "backseat", ...],
    "primary": "<labels のうち最も深刻なもの>",
    "confidence": 0.0-1.0,
    "reason_ja": "判定理由を簡潔に（safe の場合は省略可）"
  }
]`;

// ─── 内部実装: Block 2 ────────────────────────────────────────────────

/**
 * Block 2: 動的コンテキスト（ゲーム情報 + ユーザーのフィルタ設定）。
 *
 * 両者ともに「同一視聴セッション中はあまり変わらない」ため、まとめて
 * Block 2 に置きキャッシュ可能にする。空文字列を返した場合は Block 2 自体を
 * 出力しない（後方互換: gameContext も settings も実質デフォルトの場合）。
 */
function buildDynamicContextBlock(context: JudgmentContext): string {
  const gameSection = buildGameContextDescription(context.game);
  const settingsSection = buildSettingsSection(context.settings);

  // どちらも空 → Block 2 を出力しない
  if (!gameSection && !settingsSection) return '';

  const sections: string[] = [];
  if (gameSection) sections.push(gameSection);
  if (settingsSection) sections.push(settingsSection);
  return sections.join('\n\n');
}

/**
 * 視聴者のフィルタ設定セクション（カテゴリ ON/OFF + 強度）を構築する。
 *
 * LLM はこれを読んで「OFF のカテゴリは判定しない」「強度に応じた基準を適用する」と
 * 振る舞う。spam は強度設定なし（enabled のみ）。
 *
 * categories.harassment 等は型上 optional だが、`migrateSettings` を通れば
 * 必ず populate されているため、optional chain で安全に読む。未設定は OFF 扱い。
 */
function buildSettingsSection(settings: FilterSettings): string {
  const lines: string[] = ['# 視聴者のフィルタ設定（カテゴリ ON/OFF + 強度）'];
  const cats = settings.categories;

  lines.push(`- spoiler: ${formatEnabled(cats.spoiler.enabled)} / 強度 ${cats.spoiler.strength}`);
  lines.push(
    `- harassment: ${formatEnabled(cats.harassment?.enabled)} / 強度 ${cats.harassment?.strength ?? 'standard'}`,
  );
  lines.push(`- spam: ${formatEnabled(cats.spam?.enabled)}`);
  lines.push(
    `- off_topic: ${formatEnabled(cats.offTopic?.enabled)} / 強度 ${cats.offTopic?.strength ?? 'standard'}`,
  );
  lines.push(
    `- backseat: ${formatEnabled(cats.backseat?.enabled)} / 強度 ${cats.backseat?.strength ?? 'standard'}`,
  );
  lines.push('');
  lines.push(
    'OFF のカテゴリに該当しそうなコメントは labels に含めず、結果的に safe になるよう判定してください。',
  );

  return lines.join('\n');
}

function formatEnabled(enabled: boolean | undefined): string {
  return enabled === true ? 'ON' : 'OFF';
}

/**
 * ゲームコンテキスト記述を構築する。
 *
 * 既存実装を維持。条件分岐を保ち、judgment-engine 側の GameContext 構造
 * （progressType / currentChapter / completedEvents / genreTemplate / gameTitle）を使う。
 */
function buildGameContextDescription(game: GameContext | undefined): string {
  if (!game) return '';

  const parts: string[] = ['# ゲームコンテキスト'];

  const genreName = resolveGenreName(game.genreTemplate);
  const progressDescription = formatProgress(game);
  const hasProgress = progressDescription !== UNSET_PROGRESS;

  if (genreName) {
    if (hasProgress && game.gameId) {
      parts.push(`ユーザーは${genreName}ジャンルのゲームを視聴中です。`);
      parts.push(`ゲーム: ${game.gameId}`);
      parts.push(`現在の進行状況: ${progressDescription}`);
      parts.push(`ジャンル（テンプレート）: ${genreName}`);
    } else {
      parts.push(
        `ユーザーは${genreName}ジャンルのゲーム配信を視聴中です。具体的なゲームタイトルや進行状況は不明です。`,
      );
      parts.push(`ジャンル（テンプレート）: ${genreName}`);
    }
  } else if (game.gameId) {
    parts.push(`ゲーム: ${game.gameId}`);
    parts.push(`現在の進行状況: ${progressDescription}`);
  }

  if (game.gameTitle) {
    parts.push(`配信の動画タイトル: ${game.gameTitle}`);
    parts.push(
      'このタイトルからプレイ中のゲームを推測し、そのゲームの一般的な知識を踏まえてネタバレ判定を行ってください。ゲーム知識ベースが提供されている場合はそちらを優先してください。',
    );
    parts.push(
      '注意: タイトルに「ネタバレあり」等の表記がある場合、これは「この配信自体にネタバレが含まれる」という未プレイ視聴者への注意書きであり、チャットでのネタバレコメントを視聴者に許可しているわけではありません。チャットコメントの判定基準はこの表記に関わらず同じように適用してください。',
    );
  }

  if (parts.length === 1) return '';
  return parts.join('\n');
}

const UNSET_PROGRESS = '未設定（ゲーム開始前として扱う）';

function formatProgress(game: GameContext): string {
  switch (game.progressType) {
    case 'chapter':
      return game.currentChapter
        ? `現在チャプター「${game.currentChapter}」を視聴中（未通過）`
        : UNSET_PROGRESS;
    case 'event':
      return game.completedEvents && game.completedEvents.length > 0
        ? `通過済みイベント: ${game.completedEvents.join(', ')}`
        : UNSET_PROGRESS;
    case 'none':
      return UNSET_PROGRESS;
  }
}

function resolveGenreName(templateId: string | undefined): string | null {
  if (!templateId) return null;
  const found = getAllGenreTemplates().find((t) => t.id === templateId);
  return found ? found.name : templateId;
}
