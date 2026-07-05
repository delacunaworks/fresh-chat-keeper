import { describe, it, expect } from 'vitest';
import { parseEnv, resolveConfig } from '../src/config.js';

describe('parseEnv', () => {
  it('KEY=VALUE をパースし、# 行・空行を無視', () => {
    const env = parseEnv('# comment\n\nA=1\nB = two \n');
    expect(env).toEqual({ A: '1', B: 'two' });
  });

  it('クォートを剥がす', () => {
    const env = parseEnv('A="quoted"\nB=\'single\'');
    expect(env).toEqual({ A: 'quoted', B: 'single' });
  });

  it('= を含む値（トークン等）を保持', () => {
    const env = parseEnv('TOKEN=abc=def==');
    expect(env.TOKEN).toBe('abc=def==');
  });

  it('先頭が = の不正行は無視', () => {
    expect(parseEnv('=bad\nOK=1')).toEqual({ OK: '1' });
  });
});

describe('resolveConfig', () => {
  const full = {
    ELEVENLABS_API_KEY: 'el-key',
    ADMIN_INGEST_TOKEN: 'admin-token',
    FCK_API_BASE: 'https://api.example.test/',
  };

  it('全て揃えば解決（末尾スラッシュを除去）', () => {
    const cfg = resolveConfig(full);
    expect(cfg).toEqual({
      elevenLabsApiKey: 'el-key',
      adminIngestToken: 'admin-token',
      apiBase: 'https://api.example.test',
    });
  });

  it('--api で FCK_API_BASE を上書き', () => {
    const cfg = resolveConfig(full, 'http://localhost:8788');
    expect(cfg.apiBase).toBe('http://localhost:8788');
  });

  it('欠けている必須値を列挙して throw', () => {
    expect(() => resolveConfig({})).toThrow(/ELEVENLABS_API_KEY/);
    expect(() => resolveConfig({})).toThrow(/ADMIN_INGEST_TOKEN/);
    expect(() => resolveConfig({ ELEVENLABS_API_KEY: 'x', ADMIN_INGEST_TOKEN: 'y' })).toThrow(
      /FCK_API_BASE/,
    );
  });
});
