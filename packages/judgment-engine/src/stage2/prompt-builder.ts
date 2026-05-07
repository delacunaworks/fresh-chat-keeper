/**
 * Stage 2 LLM 判定用のプロンプトビルダー。
 *
 * 既存 `apps/proxy/src/index.ts` の判定プロンプトと意味的に等価な内容を、
 * Anthropic API のプロンプトキャッシング（`cache_control: { type: 'ephemeral' }`）
 * 対応の構造で再構築する。
 *
 * 出力構造（{@link buildSystemPrompt}）:
 * - Block 1: 固定指示（役割定義 + ラベル定義 + 出力形式） → 全リクエストで完全に同一なのでキャッシュ可
 * - Block 2: ゲームコンテキスト（gameId / 進行状況 / ジャンル / 動画タイトル）
 *   → 同一ユーザーの同一動画再生中は5分以上同じ内容になりがちなのでキャッシュ可
 *
 * Block 2 は判定対象メッセージを含まない。動的な部分（メッセージ列）は
 * {@link buildUserPrompt} で user role に流し込む。
 *
 * ジャンルテンプレート名のマッピングは `@fresh-chat-keeper/knowledge-base` の
 * `getAllGenreTemplates().name` を参照する。proxy 側の `GENRE_NAMES` ハードコードは
 * 段階的にこちらに移行する（P2-PROXY-01 で proxy から削除予定）。
 *
 * @see dev-docs/phase-2-engine-split.md §プロンプトビルダー
 */

import type { Message, JudgmentContext } from '../types.js';
import type { GameContext } from '@fresh-chat-keeper/shared';
import { getAllGenreTemplates } from '@fresh-chat-keeper/knowledge-base';

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

/**
 * システムプロンプトを構築する（複数ブロック）。
 *
 * @param context 判定コンテキスト（ゲーム情報・ユーザー設定）
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

  // Block 2: ゲームコンテキスト
  const ctxText = buildContextDescription(context);
  if (ctxText) {
    blocks.push({
      type: 'text',
      text: ctxText,
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
export function buildUserPrompt(messages: Message[]): string {
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

// ─── 内部実装 ────────────────────────────────────────────────────

/**
 * 役割定義 + ラベル定義 + 出力形式。
 * 既存 proxy のプロンプトと文言を整合させ、判定精度を維持する。
 * バッチ判定（複数メッセージを1リクエスト）に合わせて出力形式は配列に変更している。
 */
const STATIC_INSTRUCTIONS = `あなたはゲームのライブ配信チャットのネタバレ判定AIです。

# 判定基準（spoiler_category）

"direct_spoiler" — 明示的なネタバレ（重度）
  現在の進行状況より先のストーリー展開、キャラクターの生死、真相、結末などを直接的に述べている。
  例: 「○○は実は裏切り者だよ」「ラスボスは○○」

"foreshadowing_hint" — 伏線の指摘・匂わせ（中度）
  先の展開を知っている人が、初見を装いつつ特定の場面・台詞・キャラクターに注意を向けさせるコメント。
  例: 「ここ覚えておいて」「今の会話重要だよ」「この人怪しいな...（意味深）」

"gameplay_hint" — 攻略ヒント（軽度）
  次に何をすべきか、どこに行くべきかなどの指示・アドバイス。ストーリーには触れないが、初見プレイヤーの自力発見・体験を損なう。善意のアドバイスも含む。
  「負けイベ」「スルーでいい」「戦わなくていい」のようなゲームシステムに関する情報開示もこれに含む。
  例: 「左の道に行った方がいいよ」「そのボスは炎属性が弱点」「弾使わないほうがいいよ」「ここ負けイベだよ」「アイテム見逃してるよ」「探索甘くない？」

"safe" — 安全
  既に通過した内容への言及、ゲームと無関係な会話、純粋な感想、配信者への応援。

# 出力形式
JSON配列のみで回答（余分なテキストを含めないこと）。各メッセージに対応する判定を、入力と同じ順序で返す:

[
  {
    "messageId": "<入力の id をそのまま>",
    "spoiler_category": "direct_spoiler" | "foreshadowing_hint" | "gameplay_hint" | "safe",
    "confidence": 0.0-1.0,
    "reason": "判定理由を簡潔に"
  }
]`;

/**
 * ゲームコンテキスト記述を構築する。
 *
 * 既存 proxy の `buildContextDescription` を移植。条件分岐を保ち、
 * judgment-engine 側の GameContext 構造（progressType / currentChapter / completedEvents /
 * genreTemplate / gameTitle）を使う点だけ差し替える。
 */
function buildContextDescription(context: JudgmentContext): string {
  const game = context.game;
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

  // 何も追加されなかった場合（gameId も genreTemplate も gameTitle もない）は空文字
  if (parts.length === 1) return '';

  return parts.join('\n');
}

const UNSET_PROGRESS = '未設定（ゲーム開始前として扱う）';

function formatProgress(game: GameContext): string {
  switch (game.progressType) {
    case 'chapter':
      // v0.3.1 PROG-01: 「視聴中セマンティクス」を反映した文言。
      // currentChapter は「現在視聴中の章（未通過）」であり、その章自身のネタバレも
      // フィルタ対象。LLM プロンプトでもこの解釈を明示する。
      return game.currentChapter
        ? `現在チャプター「${game.currentChapter}」を視聴中（未通過）`
        : UNSET_PROGRESS;
    case 'event':
      // event モードの completedEventIds は「通過済み」の意味で正しい（変更なし）
      return game.completedEvents && game.completedEvents.length > 0
        ? `通過済みイベント: ${game.completedEvents.join(', ')}`
        : UNSET_PROGRESS;
    case 'none':
      return UNSET_PROGRESS;
  }
}

/**
 * `genreTemplate` ID から表示名を解決する。
 * 知識ベース上に該当 ID がなければ ID をそのまま返す（呼び出し側でフォールバック）。
 */
function resolveGenreName(templateId: string | undefined): string | null {
  if (!templateId) return null;
  const found = getAllGenreTemplates().find((t) => t.id === templateId);
  return found ? found.name : templateId;
}
