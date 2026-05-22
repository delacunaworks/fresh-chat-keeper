/**
 * P3-TEST-01: マルチラベルプロンプト品質テストのラベル付きフィクスチャ。
 *
 * 設計 ground truth: `dev-docs/phase-3-multilabel.md`「テスト戦略 / LLM判定の
 * 品質テスト」。100 件以上、6 ラベル（safe/spoiler/harassment/spam/off_topic/
 * backseat）+ VTuber 文化配慮 + マルチラベルを網羅。
 *
 * 評価方法（prompt-quality.test.ts）:
 * - `primary` 一致で全体 85% 以上、カテゴリ別精度も計測
 * - `primary` は LABEL_PRECEDENCE（harassment > spoiler > backseat > spam >
 *   off_topic > safe）で導出される単一ラベル。マルチラベル想定でも採点は
 *   primary 一致のみ（設計書の評価指標に準拠）
 * - 実 LLM 呼び出しはコスト高のため既定 CI ではスキップ。
 *   `FCK_LLM_QUALITY=1` + `ANTHROPIC_API_KEY` で実測（ローカル/別タグ）。
 *   常時 CI ではフィクスチャの構造健全性のみ検証する
 *
 * VTuber 文化メモ: 「草/w/888/ぽぽ/わこつ/うぽつ/おつ/しか勝たん/てぇてぇ/
 * すこ/ぐうかわ」等は spam/harassment ではなく safe（定番リアクション・
 * 称賛スラング）。配信のコール&レスポンス（同一文言の集中）は協調スパムでは
 * なく safe。これらを取りこぼすと体験破壊なので fixture に厚めに含める。
 */

import type { JudgmentLabel } from '@fresh-chat-keeper/shared';

export interface QualityFixture {
  /** 判定対象コメント本文 */
  comment: string;
  /** 期待 primary ラベル（LABEL_PRECEDENCE 導出後の単一ラベル） */
  expectedPrimary: JudgmentLabel;
  /** 分類観点のタグ（サブセット精度集計・可読性用） */
  tags?: Array<'vtuber' | 'multilabel' | 'call_and_response' | 'context_game'>;
  /** 任意: ゲーム文脈が判定に必要なものに付すゲームタイトル（任意利用） */
  gameTitle?: string;
}

export const QUALITY_FIXTURES: QualityFixture[] = [
  // ─── safe: 通常コメント ───────────────────────────────────
  { comment: 'この配信めっちゃ面白い！', expectedPrimary: 'safe' },
  { comment: '今日もお疲れさまでした〜', expectedPrimary: 'safe' },
  { comment: 'やったー！クリアおめでとう', expectedPrimary: 'safe' },
  { comment: 'BGM 好きすぎる', expectedPrimary: 'safe' },
  { comment: 'ここのシーン何回見ても泣ける', expectedPrimary: 'safe' },
  { comment: '初見です、よろしくお願いします', expectedPrimary: 'safe' },
  { comment: 'その操作うまいなあ', expectedPrimary: 'safe' },
  { comment: '配信ありがとう、また来ます', expectedPrimary: 'safe' },
  { comment: '声かわいい', expectedPrimary: 'safe' },
  { comment: 'この回好きだから来た', expectedPrimary: 'safe' },
  { comment: '夜更かしして見てる', expectedPrimary: 'safe' },
  { comment: 'コーヒー淹れてきた、準備OK', expectedPrimary: 'safe' },
  { comment: 'いい判断だった', expectedPrimary: 'safe' },
  { comment: 'がんばれ〜応援してる', expectedPrimary: 'safe' },
  { comment: 'なるほど、そういう仕組みなのか', expectedPrimary: 'safe' },
  { comment: 'スパチャ読みありがとう', expectedPrimary: 'safe' },
  { comment: '今北産業？', expectedPrimary: 'safe' },
  { comment: 'お、いいところで来れた', expectedPrimary: 'safe' },
  { comment: '画質きれいだね', expectedPrimary: 'safe' },
  { comment: 'この後どうするか楽しみ', expectedPrimary: 'safe' },

  // ─── safe: VTuber 文化スラング・定番リアクション ───────────
  { comment: '草', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'wwwww', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: '888888', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'うぽつ', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'わこつ', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'おつかれさまでした', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'てぇてぇ', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'すこ', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'ぐうかわ', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'しか勝たん', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'ファッ!?', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'すこすこのすこ', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'かわいいいいい', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'ｺﾝｺﾝ', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'ぽんこつかわいい', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'ナイス！', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'ぱちぱち', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: '神回', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'たまげたなあ', expectedPrimary: 'safe', tags: ['vtuber'] },
  { comment: 'いいぞもっとやれ', expectedPrimary: 'safe', tags: ['vtuber'] },

  // ─── safe: コール&レスポンス（複数人同一文言は協調スパムでない）──
  { comment: 'あじまる', expectedPrimary: 'safe', tags: ['call_and_response'] },
  { comment: 'あじまるあじまる', expectedPrimary: 'safe', tags: ['call_and_response'] },
  { comment: 'いくぞー！', expectedPrimary: 'safe', tags: ['call_and_response'] },
  { comment: 'おかえり', expectedPrimary: 'safe', tags: ['call_and_response'] },
  { comment: 'ただいま', expectedPrimary: 'safe', tags: ['call_and_response'] },
  { comment: 'ようこそ', expectedPrimary: 'safe', tags: ['call_and_response'] },
  { comment: 'がんばれー', expectedPrimary: 'safe', tags: ['call_and_response'] },
  { comment: 'せーの', expectedPrimary: 'safe', tags: ['call_and_response'] },
  { comment: 'ぺこぺこ', expectedPrimary: 'safe', tags: ['call_and_response'] },
  { comment: 'ありがとー', expectedPrimary: 'safe', tags: ['call_and_response'] },

  // ─── spoiler: ネタバレ ────────────────────────────────────
  { comment: '次のボス炎属性だから氷装備な', expectedPrimary: 'spoiler' },
  { comment: 'このあと仲間が裏切るよ', expectedPrimary: 'spoiler' },
  { comment: 'ラスボスは実は主人公の父親', expectedPrimary: 'spoiler' },
  { comment: '真エンドはあの選択肢を選ばないと無理', expectedPrimary: 'spoiler' },
  { comment: 'そのキャラ後で死ぬよ', expectedPrimary: 'spoiler' },
  { comment: '5章で世界が滅ぶ展開になる', expectedPrimary: 'spoiler' },
  { comment: 'ヒロイン実は黒幕なんだよね', expectedPrimary: 'spoiler' },
  { comment: 'この扉の先に隠しボスいる', expectedPrimary: 'spoiler' },
  { comment: '最後の最後で記憶失う展開', expectedPrimary: 'spoiler' },
  { comment: 'その村この後焼かれる', expectedPrimary: 'spoiler' },
  { comment: '実はループ物だったって最後に分かる', expectedPrimary: 'spoiler' },
  { comment: '犯人は執事だよ', expectedPrimary: 'spoiler' },
  { comment: 'あと2時間でエンディング', expectedPrimary: 'spoiler' },
  { comment: 'その仲間 NPC じゃなくて操作キャラになる', expectedPrimary: 'spoiler' },
  { comment: '次の街でその武器手に入る', expectedPrimary: 'spoiler' },
  { comment: 'トノサマンの正体は実は…（以下自重）', expectedPrimary: 'spoiler' },
  { comment: 'この謎解き答えは左右左右な', expectedPrimary: 'spoiler' },
  { comment: '実は夢オチです', expectedPrimary: 'spoiler' },

  // ─── harassment: 暴言・誹謗中傷 ───────────────────────────
  { comment: '下手すぎ見てられない', expectedPrimary: 'harassment' },
  { comment: 'こんなのもクリアできないの？馬鹿じゃん', expectedPrimary: 'harassment' },
  { comment: '声不快だからミュートした', expectedPrimary: 'harassment' },
  { comment: 'センスないからゲーム向いてないよ', expectedPrimary: 'harassment' },
  { comment: 'こいついつも炎上してるよな', expectedPrimary: 'harassment' },
  { comment: '顔出さないのは見せられない顔だから', expectedPrimary: 'harassment' },
  { comment: 'うざいんだよ黙ってプレイしろ', expectedPrimary: 'harassment' },
  { comment: '才能ないんだから引退すれば', expectedPrimary: 'harassment' },
  { comment: 'きもい笑い方', expectedPrimary: 'harassment' },
  { comment: '養分養分、よく貢ぐねえ', expectedPrimary: 'harassment' },
  { comment: 'こんな配信者に金払うやつ頭悪い', expectedPrimary: 'harassment' },
  { comment: '老害は引っ込んでろ', expectedPrimary: 'harassment' },
  { comment: 'ぶりっ子きしょい', expectedPrimary: 'harassment' },
  { comment: 'お前の代わりいくらでもいる', expectedPrimary: 'harassment' },

  // ─── spam: スパム・宣伝・無意味連投 ───────────────────────
  { comment: 'チャンネル登録お願いします！私のチャンネルも見てね', expectedPrimary: 'spam' },
  { comment: '稼げる副業教えます DM ください', expectedPrimary: 'spam' },
  { comment: '今だけ無料配布中 → http://example.com/free', expectedPrimary: 'spam' },
  { comment: 'フォロバ100%します相互お願いします', expectedPrimary: 'spam' },
  { comment: '登録者増やすツールあります', expectedPrimary: 'spam' },
  { comment: '案件のご依頼はこちらまで bit.ly/aaaa', expectedPrimary: 'spam' },
  { comment: '無料でロボックス配布 リンクはプロフ', expectedPrimary: 'spam' },
  { comment: '宣伝失礼します、新作出しました聞いてください', expectedPrimary: 'spam' },
  { comment: 'プレゼント企画やってます参加はこちら', expectedPrimary: 'spam' },
  { comment: '投資で月100万 興味ある人 LINE@', expectedPrimary: 'spam' },

  // ─── off_topic: 無関係・他配信者言及 ──────────────────────
  { comment: '今日の晩ごはん何にしようかな', expectedPrimary: 'off_topic' },
  { comment: '◯◯の配信のほうが面白いよ', expectedPrimary: 'off_topic' },
  { comment: '昨日の野球見た？逆転サヨナラだった', expectedPrimary: 'off_topic' },
  { comment: '△△ちゃんは今何の配信してるの', expectedPrimary: 'off_topic' },
  { comment: '電車遅延でまだ帰れてない', expectedPrimary: 'off_topic' },
  { comment: '明日の天気どうなんだろ', expectedPrimary: 'off_topic' },
  { comment: '別の配信者の話で悪いけど□□って引退したの？', expectedPrimary: 'off_topic' },
  { comment: '株価今日も下がってるなあ', expectedPrimary: 'off_topic' },
  { comment: '推しのライブチケット当たった！（このゲーム無関係）', expectedPrimary: 'off_topic' },
  { comment: '◇◇のコラボ配信そろそろ始まるよ', expectedPrimary: 'off_topic' },

  // ─── backseat: 指示厨・攻略押し付け ───────────────────────
  { comment: 'そこは左に行くべきだよ', expectedPrimary: 'backseat' },
  { comment: 'なんでアイテム使わないの？使えって', expectedPrimary: 'backseat' },
  { comment: 'その装備外して別の付けな', expectedPrimary: 'backseat' },
  { comment: 'はやくセーブしろって何回も言ってる', expectedPrimary: 'backseat' },
  { comment: 'そこ調べてないよ、戻って調べろ', expectedPrimary: 'backseat' },
  { comment: 'レベル上げ足りないから無理だって', expectedPrimary: 'backseat' },
  { comment: '回復しろ回復、なんで回復しないの', expectedPrimary: 'backseat' },
  { comment: 'その攻略法じゃ効率悪い、こうやれ', expectedPrimary: 'backseat' },
  { comment: 'マップ見ればわかるだろ右だよ右', expectedPrimary: 'backseat' },
  { comment: 'そのスキル振り間違ってるからやり直したほうがいい', expectedPrimary: 'backseat' },

  // ─── multilabel: 複数該当 → LABEL_PRECEDENCE で primary 決定 ──
  // harassment > spoiler > backseat > spam > off_topic > safe
  {
    comment: '下手すぎ。どうせこの後ボスに負けるしw',
    expectedPrimary: 'harassment', // harassment + spoiler → harassment
    tags: ['multilabel'],
  },
  {
    comment: 'センスないなあ、そこは左って何度も言ってんだろ',
    expectedPrimary: 'harassment', // harassment + backseat → harassment
    tags: ['multilabel'],
  },
  {
    comment: 'このあと裏切るから今のうちにレベル上げとけよ',
    expectedPrimary: 'spoiler', // spoiler + backseat → spoiler
    tags: ['multilabel'],
  },
  {
    comment: 'チャンネル登録してね！ところで次のボス炎属性だよ',
    expectedPrimary: 'spoiler', // spam + spoiler → spoiler
    tags: ['multilabel'],
  },
  {
    comment: 'そこ右行けって。あと別の配信者はもっと上手かった',
    expectedPrimary: 'backseat', // backseat + off_topic → backseat
    tags: ['multilabel'],
  },
  {
    comment: '宣伝失礼します。あと今日の天気の話だけど',
    expectedPrimary: 'spam', // spam + off_topic → spam
    tags: ['multilabel'],
  },
  {
    comment: 'お前の実況きしょい、しかもこの先みんな死ぬぞ',
    expectedPrimary: 'harassment', // harassment + spoiler → harassment
    tags: ['multilabel'],
  },
  {
    comment: 'へたくそ。登録者買ってるんでしょどうせ',
    expectedPrimary: 'harassment', // harassment + spam → harassment
    tags: ['multilabel'],
  },

  // ─── context_game: ゲーム文脈で safe/spoiler が変わる例 ──────
  {
    comment: '逆転裁判のトノサマンって特撮ね',
    expectedPrimary: 'safe', // 一般知識・ネタバレでない雑談
    tags: ['context_game'],
    gameTitle: '逆転裁判',
  },
  {
    comment: '成歩堂が逆転するとこ最高だった',
    expectedPrimary: 'safe', // 既知の有名シーンへの感想（軽度・safe 寄り）
    tags: ['context_game'],
    gameTitle: '逆転裁判',
  },
  {
    comment: '第4話の真犯人、実は刑事だからね',
    expectedPrimary: 'spoiler',
    tags: ['context_game'],
    gameTitle: '逆転裁判',
  },
];
