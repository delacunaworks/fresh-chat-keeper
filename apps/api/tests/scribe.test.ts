/**
 * ElevenLabs Scribe v2 クライアントの単体テスト（P7-B1）。
 *
 * fetch は `fetchImpl` 注入でモックし、実 API 通信は一切しない。
 *
 * 検証観点:
 * - リクエスト形状: endpoint / multipart フィールド（file・model_id・language_code）/
 *   xi-api-key ヘッダ（cloud-transcribe.mjs の elevenlabs 分岐に準拠）
 * - 成功: { text } をそのまま返す（かな正規化しない＝漢字のまま）
 * - 失敗を握り潰さず Result の error 側に載せる: config / http / network
 * - API キーの実値はコード・テストに一切埋めない（ダミー値のみ）
 */

import { describe, it, expect, vi } from 'vitest';
import { transcribe, __test__ } from '../src/lib/scribe.js';

const { SCRIBE_ENDPOINT, SCRIBE_MODEL_ID, DEFAULT_LANGUAGE_CODE } = __test__;

/** ダミー API キー（実値ではない）。 */
const DUMMY_KEY = 'test-dummy-key';

/** JSON 成功レスポンスを返す fetch モックを作る。 */
function okFetch(json: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

/** 小さな非空 Blob（audio 代用）。 */
function sampleAudio(): Blob {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' });
}

describe('transcribe — リクエスト形状', () => {
  it('Scribe v2 の endpoint に POST する', async () => {
    const fetchImpl = okFetch({ text: 'こんにちは' });
    await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(SCRIBE_ENDPOINT);
    expect(init.method).toBe('POST');
  });

  it('xi-api-key ヘッダにキーを載せ、Content-Type は手動指定しない（FormData 自動付与）', async () => {
    const fetchImpl = okFetch({ text: 'ok' });
    await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers['xi-api-key']).toBe(DUMMY_KEY);
    // boundary 付き multipart の Content-Type は FormData に任せる（手動指定しない）。
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.headers['content-type']).toBeUndefined();
  });

  it('multipart に model_id=scribe_v2 / language_code（既定 jpn）/ file を含める', async () => {
    const fetchImpl = okFetch({ text: 'ok' });
    await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model_id')).toBe(SCRIBE_MODEL_ID);
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('language_code')).toBe(DEFAULT_LANGUAGE_CODE);
    expect(form.get('language_code')).toBe('jpn');
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as unknown as Blob).size).toBe(4);
  });

  it('languageCode を指定すると上書きできる', async () => {
    const fetchImpl = okFetch({ text: 'ok' });
    await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, languageCode: 'eng', fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.body as FormData).get('language_code')).toBe('eng');
  });

  it('ArrayBuffer 入力も Blob に包んで送れる', async () => {
    const fetchImpl = okFetch({ text: 'ok' });
    const buf = new Uint8Array([9, 8, 7]).buffer;
    const res = await transcribe(buf, { apiKey: DUMMY_KEY, fetchImpl });

    expect(res.ok).toBe(true);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
  });
});

describe('transcribe — 成功', () => {
  it('{ text } をそのまま返す（漢字のまま・かな正規化しない）', async () => {
    const kanji = '荷星三郎がトノサマンを倒した';
    const fetchImpl = okFetch({ text: kanji });
    const res = await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, fetchImpl });

    expect(res).toEqual({ ok: true, text: kanji });
  });

  it('空文字 text も成功として返す（Scribe が無音を空で返すケース）', async () => {
    const fetchImpl = okFetch({ text: '' });
    const res = await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, fetchImpl });

    expect(res).toEqual({ ok: true, text: '' });
  });
});

describe('transcribe — 失敗を握り潰さない', () => {
  it('API キーが空なら config エラー（fetch を呼ばない）', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await transcribe(sampleAudio(), { apiKey: '   ', fetchImpl });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('config');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('音声が空（0 バイト）なら config エラー（fetch を呼ばない）', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await transcribe(new Blob([]), { apiKey: DUMMY_KEY, fetchImpl });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('config');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('非 2xx は http エラー（status と本文抜粋を載せる）', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('Unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;
    const res = await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, fetchImpl });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('http');
      expect(res.status).toBe(401);
      expect(res.message).toContain('401');
      expect(res.message).toContain('Unauthorized');
    }
  });

  it('http エラーメッセージに API キーを含めない', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('bad request', { status: 400 }),
    ) as unknown as typeof fetch;
    const res = await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, fetchImpl });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).not.toContain(DUMMY_KEY);
  });

  it('fetch が throw したら network エラー', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const res = await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, fetchImpl });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('network');
      expect(res.message).toContain('Failed to fetch');
    }
  });

  it('レスポンスが JSON でないと http エラー', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('not json', { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, fetchImpl });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('http');
  });

  it('text フィールド欠落は http エラー（契約違反）', async () => {
    const fetchImpl = okFetch({ detected_language: 'jpn' });
    const res = await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, fetchImpl });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('http');
      expect(res.message).toContain('text');
    }
  });

  it('text が非文字列（number）でも http エラー', async () => {
    const fetchImpl = okFetch({ text: 123 });
    const res = await transcribe(sampleAudio(), { apiKey: DUMMY_KEY, fetchImpl });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('http');
  });
});
