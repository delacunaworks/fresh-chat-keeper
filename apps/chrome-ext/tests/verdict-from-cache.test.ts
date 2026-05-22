/**
 * B7: verdictFromCache の出口バグ修正テスト。
 *
 * 真因: proxy は context.settings（カテゴリ ON/OFF・強度）を見て
 * primaryToVerdict で正しい verdict を計算済みなのに、chrome-ext が
 * result.verdict を捨て primary から再計算し harassment/spam/off_topic/
 * backseat を無条件 allow に倒していた。B7 で entry.verdict を最優先化。
 *
 * verdictFromCache / normalizeVerdict は DOM・chrome.* 非依存の純関数
 * （chrome-cache.ts の他関数は import 時に副作用なし）。
 */

import { describe, it, expect } from 'vitest';
import {
  verdictFromCache,
  normalizeVerdict,
  type JudgeCacheEntry,
} from '../src/content/chrome-cache.js';
import type { FilterMode } from '../src/shared/settings.js';

const STD: FilterMode = 'standard';

describe('B7: entry.verdict 最優先（proxy が settings 反映済み）', () => {
  it('backseat ON+strict 相当: proxy verdict=block → block', () => {
    const e: JudgeCacheEntry = {
      verdict: 'block',
      primary: 'backseat',
      labels: ['backseat'],
      confidence: 0.85,
    };
    expect(verdictFromCache(e, STD)).toBe('block');
  });

  it('backseat OFF 相当: proxy verdict=allow → allow', () => {
    const e: JudgeCacheEntry = { verdict: 'allow', primary: 'backseat' };
    expect(verdictFromCache(e, STD)).toBe('allow');
  });

  it('harassment/spam/off_topic も proxy verdict 経由で ON→block / OFF→allow', () => {
    for (const primary of ['harassment', 'spam', 'off_topic'] as const) {
      expect(
        verdictFromCache({ verdict: 'block', primary }, STD),
      ).toBe('block');
      expect(
        verdictFromCache({ verdict: 'allow', primary }, STD),
      ).toBe('allow');
    }
  });

  it('entry.verdict は filterMode より優先（再評価で proxy 同等）', () => {
    // filterMode を変えても proxy 計算済み verdict が勝つ
    expect(
      verdictFromCache({ verdict: 'block', primary: 'backseat' }, 'lenient'),
    ).toBe('block');
  });

  it('キャッシュ再評価: storage 復元相当の verdict 付き entry で block 維持', () => {
    const restored: JudgeCacheEntry = JSON.parse(
      JSON.stringify({ verdict: 'block', primary: 'backseat', labels: ['backseat'] }),
    );
    expect(verdictFromCache(restored, STD)).toBe('block');
  });
});

describe('B7: 後方互換（entry.verdict 無し＝B7 以前の旧キャッシュ）', () => {
  it('旧キャッシュ primary=backseat（verdict 無し）→ 従来どおり allow', () => {
    expect(verdictFromCache({ primary: 'backseat' }, STD)).toBe('allow');
  });

  it('旧キャッシュ primary=harassment/spam/off_topic（verdict 無し）→ allow', () => {
    for (const primary of ['harassment', 'spam', 'off_topic'] as const) {
      expect(verdictFromCache({ primary }, STD)).toBe('allow');
    }
  });

  it('spoiler 既存挙動の回帰なし（verdict 有無どちらでも block）', () => {
    expect(verdictFromCache({ primary: 'spoiler' }, STD)).toBe('block');
    expect(
      verdictFromCache({ verdict: 'block', primary: 'spoiler' }, 'lenient'),
    ).toBe('block');
  });

  it('safe 既存挙動の回帰なし（verdict 有無どちらでも allow）', () => {
    expect(verdictFromCache({ primary: 'safe' }, STD)).toBe('allow');
    expect(verdictFromCache({ verdict: 'allow', primary: 'safe' }, STD)).toBe(
      'allow',
    );
  });

  it('primary 無し: spoilerCategory フォールバック維持', () => {
    expect(
      verdictFromCache({ spoilerCategory: 'direct_spoiler' }, STD),
    ).toBe('block');
    expect(verdictFromCache({ spoilerCategory: 'safe' }, STD)).toBe('allow');
    expect(
      verdictFromCache({ spoilerCategory: 'gameplay_hint' }, 'strict'),
    ).toBe('block');
    expect(
      verdictFromCache({ spoilerCategory: 'gameplay_hint' }, 'standard'),
    ).toBe('allow');
    // 判定失敗（null）は lenient→allow / その他→block
    expect(verdictFromCache({ spoilerCategory: null }, 'lenient')).toBe(
      'allow',
    );
    expect(verdictFromCache({ spoilerCategory: null }, STD)).toBe('block');
  });
});

describe('B7: normalizeVerdict', () => {
  it('block / allow はそのまま', () => {
    expect(normalizeVerdict('block')).toBe('block');
    expect(normalizeVerdict('allow')).toBe('allow');
  });

  it('uncertain / 未知 / null / undefined / 大文字は undefined', () => {
    expect(normalizeVerdict('uncertain')).toBeUndefined();
    expect(normalizeVerdict('BLOCK')).toBeUndefined();
    expect(normalizeVerdict('')).toBeUndefined();
    expect(normalizeVerdict(null)).toBeUndefined();
    expect(normalizeVerdict(undefined)).toBeUndefined();
    expect(normalizeVerdict(1)).toBeUndefined();
  });
});
