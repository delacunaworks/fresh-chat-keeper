/**
 * ElevenLabs Scribe v2 文字起こしクライアント（P7-B1）。
 *
 * W-Spike（2026-06-25 確定）で ASR は ElevenLabs Scribe v2 が本命と決定。
 * 本ファイルは検証スクリプト `whisper-asr-spike/scripts/cloud-transcribe.mjs`
 * の elevenlabs 分岐を apps/api の本番 TS クライアントとして移植したもの。
 *
 * 今回スコープは「クライアント単体 + テスト」のみ。ASR をどこから呼ぶか
 * （Durable Object / endpoint 配線）は後続 P7-B3 で扱う。
 *
 * 設計 ground truth: dev-docs/phase-7-asr-audio-context.md §0, §5, §7（P7-B1）
 *
 * 方針:
 * - 「LLM へは漢字のまま渡す」（かな正規化は幻聴を誘発）→ 生 text をそのまま返す。
 * - エラーは throw せず Result 型で成否を表す（CLAUDE.md 推奨パターン）。
 * - API キーはハードコードせず引数で受け取る。呼び出し側（P7-B3）が
 *   `env.ELEVENLABS_API_KEY` を渡す。
 */

/** Scribe v2 のエンドポイント（cloud-transcribe.mjs に準拠）。 */
const SCRIBE_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

/** model_id（cloud-transcribe.mjs に準拠）。 */
const SCRIBE_MODEL_ID = 'scribe_v2';

/** 既定の言語コード。日本語配信を主対象とするため 'jpn'。 */
const DEFAULT_LANGUAGE_CODE = 'jpn';

/** エラーレスポンス本文をログ/エラーに載せる際の最大長（キー漏洩・肥大化の防止）。 */
const ERROR_BODY_MAX_LEN = 300;

/**
 * Scribe v2 の word/segment 単位タイムスタンプ（AR-2 で利用）。
 *
 * ElevenLabs `speech-to-text` は本文 `text` に加え `words[]` を返す。各要素は
 * `start`/`end`（秒）付きで、`type` は 'word' | 'spacing' | 'audio_event'。
 * VOD をチャンク転写する際、これを 15〜30 秒粒度の segment に束ねてタイムスタンプを
 * 付与する（AR-1 の transcript 取り込みに渡す）。
 */
export interface TranscribeWord {
  /** トークン本文（'spacing' の場合は空白そのもの）。 */
  text: string;
  /** 開始秒（チャンク先頭からの相対）。 */
  start: number;
  /** 終了秒（チャンク先頭からの相対）。 */
  end: number;
  /** 'word' | 'spacing' | 'audio_event' 等（provider 依存）。 */
  type?: string;
  /** 話者 ID（diarization 有効時）。 */
  speaker_id?: string;
}

/**
 * 文字起こしの結果。throw ではなく成否を型で返す（Result 型パターン）。
 *
 * 失敗の `kind`:
 * - 'config':  呼び出し側の設定不備（API キー未指定 / 空 / 音声が空）。送信前に検出。
 * - 'http':    Scribe が非 2xx を返した（status と本文抜粋を載せる）。
 * - 'network': fetch 自体が throw（DNS / TLS / オフライン等）。
 *
 * 成功時 `words` は**レスポンスにタイムスタンプが含まれる場合のみ**付く（後方互換:
 * 従来 text だけを見る呼び出し側は影響を受けない）。
 */
export type TranscribeResult =
  | { ok: true; text: string; words?: TranscribeWord[] }
  | { ok: false; kind: 'config' | 'http' | 'network'; status?: number; message: string };

/**
 * `transcribe` のオプション。
 *
 * - `apiKey`:     ELEVENLABS_API_KEY。ハードコードせず必ず引数で受け取る。
 * - `languageCode`: Scribe の language_code。既定 'jpn'。
 * - `mimeType`:   送信する Blob の MIME。既定 'audio/wav'。ArrayBuffer 入力時に使用。
 * - `fileName`:   multipart の file 名。既定 'audio.wav'。
 * - `fetchImpl`:  fetch の差し替え（テストで実 API 通信を避けるための注入点）。
 */
export interface TranscribeOptions {
  apiKey: string;
  languageCode?: string;
  mimeType?: string;
  fileName?: string;
  fetchImpl?: typeof fetch;
}

/** Scribe v2 の成功レスポンス形状（text 必須、words は任意）。 */
interface ScribeSuccessBody {
  text?: unknown;
  words?: unknown;
}

/**
 * 音声を ElevenLabs Scribe v2 で文字起こしする。
 *
 * @param audio 音声データ。Blob または ArrayBuffer。
 * @param opts  API キー等。`apiKey` は必須。
 * @returns 成功時 `{ ok: true, text }`、失敗時 `{ ok: false, kind, ... }`。
 */
export async function transcribe(
  audio: Blob | ArrayBuffer,
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  const apiKey = opts.apiKey;
  // キーはコードに埋めない。未指定/空は送信前に config エラーで弾く。
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return { ok: false, kind: 'config', message: 'ELEVENLABS_API_KEY is missing or empty.' };
  }

  const mimeType = opts.mimeType ?? 'audio/wav';
  const fileName = opts.fileName ?? 'audio.wav';
  const languageCode = opts.languageCode ?? DEFAULT_LANGUAGE_CODE;

  const blob = audio instanceof Blob ? audio : new Blob([audio], { type: mimeType });
  if (blob.size === 0) {
    return { ok: false, kind: 'config', message: 'audio is empty (0 bytes).' };
  }

  // cloud-transcribe.mjs の elevenlabs 分岐に準拠した multipart/form-data。
  const form = new FormData();
  form.append('file', blob, fileName);
  form.append('model_id', SCRIBE_MODEL_ID);
  form.append('language_code', languageCode);

  // workerd の fetch は this 感受性あり。素の参照の detached 呼び出しは
  // "Illegal invocation" になり得るため globalThis に bind する（provider.ts と同件）。
  const doFetch = opts.fetchImpl ?? fetch.bind(globalThis);

  let response: Response;
  try {
    response = await doFetch(SCRIBE_ENDPOINT, {
      method: 'POST',
      // xi-api-key のみ。Content-Type は FormData から自動付与させる（boundary 込み）。
      headers: { 'xi-api-key': apiKey },
      body: form,
    });
  } catch (err) {
    // fetch が throw した（DNS / TLS / オフライン等）。握り潰さず error 側に載せる。
    return { ok: false, kind: 'network', message: errorMessage(err) };
  }

  if (!response.ok) {
    // 非 2xx。本文を抜粋して載せる（キーは送信ヘッダ側のみなので本文には載らない）。
    const bodyText = await safeReadText(response);
    return {
      ok: false,
      kind: 'http',
      status: response.status,
      message: `Scribe HTTP ${response.status}: ${bodyText.slice(0, ERROR_BODY_MAX_LEN)}`,
    };
  }

  let body: ScribeSuccessBody;
  try {
    body = (await response.json()) as ScribeSuccessBody;
  } catch (err) {
    return {
      ok: false,
      kind: 'http',
      status: response.status,
      message: `Scribe response was not valid JSON: ${errorMessage(err)}`,
    };
  }

  // 成功レスポンスは { text: string }。欠落/非文字列は契約違反として http エラー扱い。
  if (typeof body.text !== 'string') {
    return {
      ok: false,
      kind: 'http',
      status: response.status,
      message: 'Scribe response did not include a "text" string field.',
    };
  }

  // 生 text をそのまま返す（かな正規化しない）。words はタイムスタンプがあれば付与。
  const words = parseWords(body.words);
  return { ok: true, text: body.text, ...(words.length > 0 ? { words } : {}) };
}

/**
 * レスポンスの `words` を {@link TranscribeWord}[] に正規化する。
 * 不正要素（start/end が数値でない等）は捨てる。タイムスタンプが無ければ空配列。
 */
function parseWords(raw: unknown): TranscribeWord[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscribeWord[] = [];
  for (const w of raw) {
    if (typeof w !== 'object' || w === null) continue;
    const o = w as Record<string, unknown>;
    if (typeof o.text !== 'string') continue;
    if (typeof o.start !== 'number' || !Number.isFinite(o.start)) continue;
    if (typeof o.end !== 'number' || !Number.isFinite(o.end)) continue;
    out.push({
      text: o.text,
      start: o.start,
      end: o.end,
      ...(typeof o.type === 'string' ? { type: o.type } : {}),
      ...(typeof o.speaker_id === 'string' ? { speaker_id: o.speaker_id } : {}),
    });
  }
  return out;
}

/** Response.text() を安全に読む（読めなくてもエラー化しない）。 */
async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<failed to read response body>';
  }
}

/** unknown を安全にメッセージ文字列へ。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── テスト用エクスポート ─────────────────────────────────────
export const __test__ = {
  SCRIBE_ENDPOINT,
  SCRIBE_MODEL_ID,
  DEFAULT_LANGUAGE_CODE,
  ERROR_BODY_MAX_LEN,
  parseWords,
};
