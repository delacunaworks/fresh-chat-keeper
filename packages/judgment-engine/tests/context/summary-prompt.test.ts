/**
 * 要約プロンプトビルダー（L1/L2）の単体テスト（P7-B4）。
 *
 * 純粋関数なので LLM は呼ばない。検証観点:
 * - 返り値が { system: SystemPromptBlock[]; messages: LLMMessage[] } 形
 * - cache_control を付けない（判定経路のキャッシュ設計に影響させない）
 * - 入力テキストが user メッセージに含まれる
 * - L2 は existingL2=null（初回）でも壊れない
 */

import { describe, it, expect } from 'vitest';
import {
  buildL1Prompt,
  buildL2Prompt,
  L1_TARGET_CHARS,
  L2_MAX_CHARS,
} from '../../src/context/summary-prompt.js';

describe('buildL1Prompt', () => {
  it('system + user 1 件で、user に窓テキストを含む', () => {
    const parts = buildL1Prompt('ボスが出てきた、これは強い');
    expect(parts.system).toHaveLength(1);
    expect(parts.system[0].type).toBe('text');
    expect(parts.messages).toHaveLength(1);
    expect(parts.messages[0].role).toBe('user');
    expect(parts.messages[0].content).toContain('ボスが出てきた、これは強い');
  });

  it('cache_control を付けない', () => {
    const parts = buildL1Prompt('x');
    expect(parts.system[0].cache_control).toBeUndefined();
  });

  it('目安文字数（80〜150）が指示に含まれる', () => {
    const parts = buildL1Prompt('x');
    expect(parts.system[0].text).toContain(String(L1_TARGET_CHARS.min));
    expect(parts.system[0].text).toContain(String(L1_TARGET_CHARS.max));
  });
});

describe('buildL2Prompt', () => {
  it('既存 L2 と新 L1 の両方を user に含む', () => {
    const parts = buildL2Prompt('これまでの累積', '最新の近傍');
    expect(parts.messages[0].content).toContain('これまでの累積');
    expect(parts.messages[0].content).toContain('最新の近傍');
  });

  it('初回（existingL2=null）でも壊れず、新 L1 を含む', () => {
    const parts = buildL2Prompt(null, '最初の要約');
    expect(parts.messages[0].content).toContain('最初の要約');
    expect(parts.messages[0].content.length).toBeGreaterThan(0);
  });

  it('空文字 existingL2 はプレースホルダ扱い', () => {
    const parts = buildL2Prompt('   ', '新L1');
    expect(parts.messages[0].content).toContain('まだ累積要約はありません');
  });

  it('上限文字数（L2_MAX_CHARS）が指示に含まれる / cache_control なし', () => {
    const parts = buildL2Prompt(null, 'x');
    expect(parts.system[0].text).toContain(String(L2_MAX_CHARS));
    expect(parts.system[0].cache_control).toBeUndefined();
  });
});
