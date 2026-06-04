/**
 * Phase 5（v0.6.0 / P5-B5 hotfix）字幕テキストのクリーニング（純粋関数・DOM 非依存）。
 *
 * 実機で字幕連動 ON のとき proxy に乗った recentAudio.text に 3 種のゴミが混入していた:
 *   1. 効果音/状況注釈 `[叫び声] [笑い] [荒い息]` 等の非発話タグ
 *   2. ローリング字幕由来の重複（同じ文が繰り返される）
 *   3. YouTube UI 文字列（provider 側 denylist で別途防御。本層は扱わない）
 *
 * 本層は 1（{@link sanitizeCaptionText}）と 2（{@link dedupeRepeatedPhrases}）を
 * 純粋関数で担う。3 は YouTube 固有なので chrome-ext の provider 側に置く。
 *
 * 設計方針: 過度な NLP 重複検出はしない。文（。．！？!? + 改行）単位の
 * 「連続重複の畳み込み」+「全体が短周期の繰り返しなら 1 周期に縮約」のみ。
 */

/** 文の区切り（保持して分割する）。日本語句点・全角/半角の感嘆符・疑問符・改行。 */
const SENTENCE_DELIMITERS = '。．！？!?\n';
const SPLIT_KEEP_DELIMITER = /(?<=[。．！？!?\n])/;

/**
 * 1 字幕断片のクリーニング。
 * - 効果音/状況注釈 `[叫び声] [笑い] [音楽]` 等（角括弧で囲まれた短い注釈）を除去
 * - 連続空白を 1 つに圧縮し、前後を trim
 *
 * 角括弧内は 1〜20 文字に限定（長い本文を巻き込まない安全弁）。
 */
export function sanitizeCaptionText(raw: string): string {
  return raw
    .replace(/\[[^\]]{1,20}\]/g, ' ') // [叫び声] [笑い] [荒い息] 等
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ローリング字幕由来の重複を畳む。
 *
 * 文（{@link SENTENCE_DELIMITERS} 区切り、区切り文字は保持）に分割し、
 *   1. **連続して重複する文**を 1 つに collapse（A A B → A B）
 *   2. 全体が短周期の繰り返しなら 1 周期に縮約（A B C A B C → A B C）
 * を順に適用する。文の順序は保つ。区切りを持たないテキストはそのまま返す。
 *
 * 例「やは。よしよし。来た来た。やは。よしよし。来た来た。」→「やは。よしよし。来た来た。」
 */
export function dedupeRepeatedPhrases(text: string): string {
  if (!text) return '';
  const units = text
    .split(SPLIT_KEEP_DELIMITER)
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  if (units.length <= 1) return text.trim();

  const collapsed = collapseConsecutive(units);
  const reduced = reducePeriodic(collapsed);
  return reduced.join('');
}

/** 連続して同一の要素を 1 つに畳む（区切り除去後の本体で比較）。 */
function collapseConsecutive(units: string[]): string[] {
  const out: string[] = [];
  let prevKey = '';
  for (const u of units) {
    const key = stripTrailingDelimiters(u);
    if (key.length > 0 && key === prevKey) continue;
    out.push(u);
    prevKey = key;
  }
  return out;
}

/**
 * 配列全体が長さ p の周期の繰り返し（n が p の倍数 かつ units[i] === units[i % p]）なら
 * 先頭 p 要素に縮約する。最小の p を採用。周期性がなければそのまま返す。
 */
function reducePeriodic(units: string[]): string[] {
  const n = units.length;
  if (n < 2) return units;
  for (let p = 1; p <= Math.floor(n / 2); p++) {
    if (n % p !== 0) continue;
    let periodic = true;
    for (let i = p; i < n; i++) {
      if (stripTrailingDelimiters(units[i]) !== stripTrailingDelimiters(units[i % p])) {
        periodic = false;
        break;
      }
    }
    if (periodic) return units.slice(0, p);
  }
  return units;
}

/**
 * YouTube ライブ自動字幕の「逐次成長（incremental）」を畳む（P5-B5 hotfix-2）。
 *
 * ライブ字幕は単語ずつ text が伸びる途中スナップショットを生む:
 *   ["なんかさ、", "なんかさ、行っ", "なんかさ、行ったり来", …, "なんかさ、…戻ってんだよね。"]
 * 連続する断片で **前者が後者の接頭辞**（後者が前者で始まる）なら、成長中の同一
 * 発話とみなし**最長（最後）のみ残す**。前者の方が長い（後者が前者の接頭辞）場合は
 * 後者を捨てる（成長の逆＝稀）。接頭辞関係になければ別発話として両方残す。
 *
 * 完全一致の連続/周期重複は {@link dedupeRepeatedPhrases} が担当。本関数は
 * 「伸びていく接頭辞」専用。語内反復（「よしよしよし」）・非連続再出現は対象外
 * （実発話の可能性が高く、誤除去を避けるため触らない）。
 */
export function collapseRollingPrefixes(texts: string[]): string[] {
  const out: string[] = [];
  for (const raw of texts) {
    const t = raw.trim();
    if (!t) continue;
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (last !== undefined && t.startsWith(last)) {
      out[out.length - 1] = t; // 成長 → 最長に置換
    } else if (last !== undefined && last.startsWith(t)) {
      // t は last の接頭辞（より短い）→ 捨てる（last を保持）
      continue;
    } else {
      out.push(t);
    }
  }
  return out;
}

/** 末尾の区切り文字・空白を取り除いた比較用キーを返す。 */
function stripTrailingDelimiters(s: string): string {
  let end = s.length;
  while (end > 0 && (SENTENCE_DELIMITERS.includes(s[end - 1]) || s[end - 1] === ' ')) {
    end--;
  }
  return s.slice(0, end);
}
