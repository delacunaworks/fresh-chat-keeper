import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('URL のみ', () => {
    expect(parseArgs(['https://youtu.be/x'])).toEqual({
      url: 'https://youtu.be/x',
      dryRun: false,
      yes: false,
    });
  });

  it('フラグ一式', () => {
    const a = parseArgs(['URL', '--dry-run', '--yes', '--api', 'http://localhost:8788']);
    expect(a.url).toBe('URL');
    expect(a.dryRun).toBe(true);
    expect(a.yes).toBe(true);
    expect(a.apiBase).toBe('http://localhost:8788');
  });

  it('--api=inline / -y', () => {
    const a = parseArgs(['URL', '-y', '--api=https://x.test']);
    expect(a.yes).toBe(true);
    expect(a.apiBase).toBe('https://x.test');
  });

  it('--duration <秒> / --duration=inline', () => {
    expect(parseArgs(['URL', '--duration', '18000']).duration).toBe(18000);
    expect(parseArgs(['URL', '--duration=1200']).duration).toBe(1200);
  });

  it('不正な --duration は無視', () => {
    expect(parseArgs(['URL', '--duration', 'abc']).duration).toBeUndefined();
    expect(parseArgs(['URL', '--duration', '-5']).duration).toBeUndefined();
  });

  it('URL 未指定は null', () => {
    expect(parseArgs(['--dry-run']).url).toBeNull();
  });
});
