/**
 * LLMProvider / AnthropicProvider の単体テスト（P7-B2）。
 *
 * fetch は注入モックで実 API 通信なし。検証観点は「旧 callAnthropicOnce との
 * 挙動等価」:
 * - 送出 HTTP: endpoint / headers（x-api-key・anthropic-version・Content-Type）/
 *   body（model / max_tokens / temperature / system / messages）
 * - 成功: content[0].text を返す。content 空なら '' を返す
 * - HTTP 非 2xx: null を返す（throw しない）+ console.error
 * - ネットワーク失敗・JSON パース失敗: throw して呼び出し側へ伝播
 * - メタ属性: name='anthropic' / callsFrom='worker' / supportsPromptCache=true
 */

import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider, type LLMRequest } from '../../src/llm/provider.js';
import type { SystemPromptBlock } from '../../src/stage2/prompt-builder.js';

const DUMMY_KEY = 'test-dummy-anthropic-key';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

const SYSTEM: SystemPromptBlock[] = [
  { type: 'text', text: 'base prompt', cache_control: { type: 'ephemeral' } },
];

function sampleRequest(): LLMRequest {
  return {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 200,
    temperature: 0,
    system: SYSTEM,
    messages: [{ role: 'user', content: 'judge these comments' }],
  };
}

/** Anthropic 成功レスポンス（content[0].text）を返す fetch モック。 */
function okFetch(text: string): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('AnthropicProvider — メタ属性', () => {
  it('name / callsFrom / supportsPromptCache が仕様どおり', () => {
    const p = new AnthropicProvider({ apiKey: DUMMY_KEY });
    expect(p.name).toBe('anthropic');
    expect(p.callsFrom).toBe('worker');
    expect(p.supportsPromptCache).toBe(true);
  });
});

describe('AnthropicProvider.complete — 送出 HTTP（旧 callAnthropicOnce 等価）', () => {
  it('messages endpoint に POST する', async () => {
    const fetchImpl = okFetch('ok');
    await new AnthropicProvider({ apiKey: DUMMY_KEY, fetchImpl }).complete(sampleRequest());

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
  });

  it('ヘッダに x-api-key / anthropic-version / Content-Type を載せる', async () => {
    const fetchImpl = okFetch('ok');
    await new AnthropicProvider({ apiKey: DUMMY_KEY, fetchImpl }).complete(sampleRequest());

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers['x-api-key']).toBe(DUMMY_KEY);
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('body は model / max_tokens / temperature / system / messages（cache_control 保持）', async () => {
    const fetchImpl = okFetch('ok');
    const req = sampleRequest();
    await new AnthropicProvider({ apiKey: DUMMY_KEY, fetchImpl }).complete(req);

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.system,
      messages: req.messages,
    });
    // cache_control 境界が body に残っていること（prompt cache の前提）
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('anthropicVersion / endpoint を上書きできる', async () => {
    const fetchImpl = okFetch('ok');
    await new AnthropicProvider({
      apiKey: DUMMY_KEY,
      fetchImpl,
      anthropicVersion: '2099-01-01',
      endpoint: 'https://example.test/v1/messages',
    }).complete(sampleRequest());

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://example.test/v1/messages');
    expect(init.headers['anthropic-version']).toBe('2099-01-01');
  });
});

describe('AnthropicProvider.complete — 成功', () => {
  it('content[0].text を返す', async () => {
    const fetchImpl = okFetch('[{"messageId":"m1","labels":["safe"]}]');
    const res = await new AnthropicProvider({ apiKey: DUMMY_KEY, fetchImpl }).complete(
      sampleRequest(),
    );
    expect(res).toEqual({ text: '[{"messageId":"m1","labels":["safe"]}]' });
  });

  it('content が空配列なら text は空文字（?? "" 経路）', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ content: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const res = await new AnthropicProvider({ apiKey: DUMMY_KEY, fetchImpl }).complete(
      sampleRequest(),
    );
    expect(res).toEqual({ text: '' });
  });
});

describe('AnthropicProvider.complete — 失敗（旧 null/throw 分岐の維持）', () => {
  it('HTTP 非 2xx は null（throw しない）+ console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () =>
      new Response('rate limited', { status: 429 }),
    ) as unknown as typeof fetch;

    const res = await new AnthropicProvider({ apiKey: DUMMY_KEY, fetchImpl }).complete(
      sampleRequest(),
    );
    expect(res).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('429');
    errSpy.mockRestore();
  });

  it('ネットワーク失敗（fetch throw）は呼び出し側へ伝播する', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(
      new AnthropicProvider({ apiKey: DUMMY_KEY, fetchImpl }).complete(sampleRequest()),
    ).rejects.toThrow('Failed to fetch');
  });

  it('レスポンスが JSON でない（2xx）と throw する', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('not json', { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      new AnthropicProvider({ apiKey: DUMMY_KEY, fetchImpl }).complete(sampleRequest()),
    ).rejects.toBeInstanceOf(Error);
  });
});
