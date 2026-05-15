/**
 * judgment-parser.ts の単体テスト（Phase 3 / P3-STAGE2-02）。
 *
 * 検証観点:
 * - 正常な LLM レスポンスを ParsedJudgment[] に変換できる
 * - 不正な JSON / 配列でない応答 / 部分欠落でも crash しない
 * - 全件 safe fallback（rawText が空、JSON parse 失敗 等）
 * - labels の VALID_LABELS 外を silently 除外
 * - primary が labels に含まれない場合 derivePrimary で再導出
 * - confidence の範囲外 / NaN / 型不正 → 0.5 fallback
 * - ```json フェンス、前後の説明文を取り除ける
 * - 入力 messageIds 順を維持して返す
 */

import { describe, it, expect } from 'vitest';
import {
  parseMultiLabelResponse,
  parseMultiLabelResponseText,
  parseMultiLabelResponseDetailed,
  classifyParse,
  validateJudgmentEntry,
  __test__,
} from '../src/judgment-parser.js';

const { validateLabels, validateConfidence, isJudgmentLabel, VALID_LABELS } = __test__;

describe('parseMultiLabelResponseText', () => {
  it('正常な JSON 配列をパースする', () => {
    const text = `[{"messageId":"m1","labels":["safe"],"primary":"safe","confidence":0.95}]`;
    const result = parseMultiLabelResponseText(text);
    expect(result).toHaveLength(1);
    expect(result[0]?.messageId).toBe('m1');
  });

  it('\\`\\`\\`json フェンスに包まれた配列を抽出する', () => {
    const text =
      '```json\n[{"messageId":"m1","labels":["spoiler"],"primary":"spoiler","confidence":0.9}]\n```';
    const result = parseMultiLabelResponseText(text);
    expect(result).toHaveLength(1);
    expect(result[0]?.messageId).toBe('m1');
  });

  it('前後の説明文があっても配列だけ抽出する', () => {
    const text =
      'はい、判定結果です:\n[{"messageId":"m1","labels":["safe"],"primary":"safe","confidence":0.5}]\n以上です。';
    const result = parseMultiLabelResponseText(text);
    expect(result).toHaveLength(1);
  });

  it('JSON 不正なら空配列', () => {
    expect(parseMultiLabelResponseText('[not valid json]')).toEqual([]);
  });

  it('text に配列が含まれていなければ空配列', () => {
    expect(parseMultiLabelResponseText('ごめんなさい、判定できませんでした')).toEqual([]);
  });

  it('配列でなくオブジェクトを返したら空配列', () => {
    // `\[[\s\S]*\]` で match しないので空配列扱い
    expect(parseMultiLabelResponseText('{"messageId":"m1","labels":["safe"]}')).toEqual([]);
  });

  it('配列要素にオブジェクトでない値が混じる → 除外', () => {
    const text = `[{"messageId":"m1","labels":["safe"]}, "string", 42, null]`;
    const result = parseMultiLabelResponseText(text);
    expect(result).toHaveLength(1);
  });

  it('空配列はそのまま空', () => {
    expect(parseMultiLabelResponseText('[]')).toEqual([]);
  });
});

describe('validateJudgmentEntry', () => {
  it('完全に有効なエントリをそのまま返す', () => {
    const result = validateJudgmentEntry(
      {
        messageId: 'm1',
        labels: ['spoiler', 'backseat'],
        primary: 'spoiler',
        confidence: 0.85,
        reason_ja: 'ネタバレ + 指示厨',
      },
      'fallback',
    );
    expect(result).toEqual({
      messageId: 'm1',
      labels: ['spoiler', 'backseat'],
      primary: 'spoiler',
      confidence: 0.85,
      reasonJa: 'ネタバレ + 指示厨',
    });
  });

  it('messageId が欠落 → fallback ID を使う', () => {
    const result = validateJudgmentEntry(
      { labels: ['safe'], primary: 'safe', confidence: 0.99 },
      'fb_id',
    );
    expect(result.messageId).toBe('fb_id');
  });

  it('messageId が空文字 → fallback ID を使う', () => {
    const result = validateJudgmentEntry(
      { messageId: '', labels: ['safe'], primary: 'safe', confidence: 0.99 },
      'fb_id',
    );
    expect(result.messageId).toBe('fb_id');
  });

  it('messageId が文字列でない → fallback ID', () => {
    const result = validateJudgmentEntry(
      { messageId: 42, labels: ['safe'], primary: 'safe', confidence: 0.5 },
      'fb_id',
    );
    expect(result.messageId).toBe('fb_id');
  });

  it('labels に不正ラベル混在 → 既知ラベルのみ採用', () => {
    const result = validateJudgmentEntry(
      {
        messageId: 'm1',
        labels: ['spoiler', 'unknown_label', 'harassment'],
        primary: 'spoiler',
        confidence: 0.8,
      },
      'fb',
    );
    expect(result.labels).toEqual(['spoiler', 'harassment']);
  });

  it('labels が全て不正 → safe にフォールバック', () => {
    const result = validateJudgmentEntry(
      {
        messageId: 'm1',
        labels: ['foo', 'bar'],
        primary: 'baz',
        confidence: 0.8,
      },
      'fb',
    );
    expect(result.labels).toEqual(['safe']);
    expect(result.primary).toBe('safe');
  });

  it('labels が配列でない → safe フォールバック', () => {
    const result = validateJudgmentEntry(
      { messageId: 'm1', labels: 'spoiler', primary: 'spoiler', confidence: 0.5 },
      'fb',
    );
    expect(result.labels).toEqual(['safe']);
  });

  it('labels が undefined → safe フォールバック', () => {
    const result = validateJudgmentEntry(
      { messageId: 'm1', primary: 'safe', confidence: 0.5 },
      'fb',
    );
    expect(result.labels).toEqual(['safe']);
  });

  it('primary が labels に含まれない → derivePrimary で再導出', () => {
    const result = validateJudgmentEntry(
      {
        messageId: 'm1',
        labels: ['harassment', 'backseat'],
        primary: 'safe', // labels に safe はないので不整合
        confidence: 0.9,
      },
      'fb',
    );
    // derivePrimary で harassment（最高優先度）が選ばれる
    expect(result.primary).toBe('harassment');
  });

  it('primary が不正ラベル → derivePrimary で再導出', () => {
    const result = validateJudgmentEntry(
      {
        messageId: 'm1',
        labels: ['spoiler'],
        primary: 'garbage',
        confidence: 0.9,
      },
      'fb',
    );
    expect(result.primary).toBe('spoiler');
  });

  it('primary が欠落 → derivePrimary で導出', () => {
    const result = validateJudgmentEntry(
      { messageId: 'm1', labels: ['backseat'], confidence: 0.7 },
      'fb',
    );
    expect(result.primary).toBe('backseat');
  });

  it('confidence の範囲外 (1.5) → 1 にクランプ', () => {
    const result = validateJudgmentEntry(
      { messageId: 'm1', labels: ['safe'], primary: 'safe', confidence: 1.5 },
      'fb',
    );
    expect(result.confidence).toBe(1);
  });

  it('confidence の負値 (-0.2) → 0 にクランプ', () => {
    const result = validateJudgmentEntry(
      { messageId: 'm1', labels: ['safe'], primary: 'safe', confidence: -0.2 },
      'fb',
    );
    expect(result.confidence).toBe(0);
  });

  it('confidence が NaN → 0.5 fallback', () => {
    const result = validateJudgmentEntry(
      { messageId: 'm1', labels: ['safe'], primary: 'safe', confidence: Number.NaN },
      'fb',
    );
    expect(result.confidence).toBe(0.5);
  });

  it('confidence が文字列 → 0.5 fallback', () => {
    const result = validateJudgmentEntry(
      { messageId: 'm1', labels: ['safe'], primary: 'safe', confidence: '0.9' },
      'fb',
    );
    expect(result.confidence).toBe(0.5);
  });

  it('reason_ja が文字列でない → reasonJa は undefined', () => {
    const result = validateJudgmentEntry(
      { messageId: 'm1', labels: ['safe'], primary: 'safe', confidence: 0.5, reason_ja: 42 },
      'fb',
    );
    expect(result.reasonJa).toBeUndefined();
  });

  it('labels に重複 → 重複除去', () => {
    const result = validateJudgmentEntry(
      {
        messageId: 'm1',
        labels: ['spoiler', 'spoiler', 'safe'],
        primary: 'spoiler',
        confidence: 0.9,
      },
      'fb',
    );
    expect(result.labels).toEqual(['spoiler', 'safe']);
  });
});

describe('parseMultiLabelResponse (full pipeline)', () => {
  it('元の messageIds 順を維持して結果を返す', () => {
    const text = `[
      {"messageId":"m2","labels":["spoiler"],"primary":"spoiler","confidence":0.9},
      {"messageId":"m1","labels":["safe"],"primary":"safe","confidence":0.99},
      {"messageId":"m3","labels":["harassment"],"primary":"harassment","confidence":0.85}
    ]`;
    const result = parseMultiLabelResponse(text, ['m1', 'm2', 'm3']);
    expect(result.map((r) => r.messageId)).toEqual(['m1', 'm2', 'm3']);
    expect(result[0]?.primary).toBe('safe');
    expect(result[1]?.primary).toBe('spoiler');
    expect(result[2]?.primary).toBe('harassment');
  });

  it('LLM が一部メッセージを返し損ねた → 欠けた分は safe fallback', () => {
    const text = `[{"messageId":"m1","labels":["spoiler"],"primary":"spoiler","confidence":0.9}]`;
    const result = parseMultiLabelResponse(text, ['m1', 'm2', 'm3']);
    expect(result).toHaveLength(3);
    expect(result[0]?.primary).toBe('spoiler');
    expect(result[1]?.primary).toBe('safe');
    expect(result[1]?.confidence).toBe(0);
    expect(result[2]?.primary).toBe('safe');
  });

  it('rawText が空 → 全件 safe fallback', () => {
    const result = parseMultiLabelResponse('', ['m1', 'm2']);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.primary === 'safe')).toBe(true);
  });

  it('rawText が JSON 不正 → 全件 safe fallback', () => {
    const result = parseMultiLabelResponse('[not json', ['m1', 'm2']);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.primary === 'safe')).toBe(true);
  });

  it('rawText が配列でないオブジェクト → 全件 safe fallback', () => {
    const result = parseMultiLabelResponse('{"foo": "bar"}', ['m1']);
    expect(result).toHaveLength(1);
    expect(result[0]?.primary).toBe('safe');
  });

  it('LLM が同一 messageId を複数回返した → 後勝ち', () => {
    const text = `[
      {"messageId":"m1","labels":["spoiler"],"primary":"spoiler","confidence":0.5},
      {"messageId":"m1","labels":["harassment"],"primary":"harassment","confidence":0.9}
    ]`;
    const result = parseMultiLabelResponse(text, ['m1']);
    expect(result).toHaveLength(1);
    // Map.set による後勝ち
    expect(result[0]?.primary).toBe('harassment');
  });

  it('messageIds が空 → 空配列', () => {
    const result = parseMultiLabelResponse(
      `[{"messageId":"m1","labels":["safe"],"primary":"safe","confidence":0.5}]`,
      [],
    );
    expect(result).toEqual([]);
  });

  it('マルチラベル（複数ラベル付与）を正しく扱う', () => {
    const text = `[{
      "messageId":"m1",
      "labels":["harassment","backseat"],
      "primary":"harassment",
      "confidence":0.92,
      "reason_ja":"暴言 + 攻略指示の重複"
    }]`;
    const result = parseMultiLabelResponse(text, ['m1']);
    expect(result[0]?.labels).toEqual(['harassment', 'backseat']);
    expect(result[0]?.primary).toBe('harassment');
    expect(result[0]?.reasonJa).toContain('暴言');
  });

  it('messageId が ID として渡されていない要素は黙って捨てる', () => {
    const text = `[
      {"messageId":"m1","labels":["spoiler"],"primary":"spoiler","confidence":0.9},
      {"messageId":"m_unknown","labels":["harassment"],"primary":"harassment","confidence":0.9}
    ]`;
    const result = parseMultiLabelResponse(text, ['m1']);
    expect(result).toHaveLength(1);
    expect(result[0]?.primary).toBe('spoiler');
  });
});

describe('内部ヘルパー (__test__)', () => {
  describe('VALID_LABELS', () => {
    it('JudgmentLabel の 6 値と集合一致（順序は LABEL_PRECEDENCE 由来なので不問）', () => {
      // B3 hardening: VALID_LABELS は LABEL_PRECEDENCE から導出されるため
      // 配列順は深刻度順（harassment 先頭）。membership 判定にしか使わないので
      // 集合として 6 値を過不足なく含むことだけ検証する。
      expect([...VALID_LABELS].sort()).toEqual(
        ['backseat', 'harassment', 'off_topic', 'safe', 'spam', 'spoiler'],
      );
    });
  });

  describe('isJudgmentLabel', () => {
    it('valid ラベルで true', () => {
      expect(isJudgmentLabel('spoiler')).toBe(true);
      expect(isJudgmentLabel('safe')).toBe(true);
    });

    it('不正値で false', () => {
      expect(isJudgmentLabel('unknown')).toBe(false);
      expect(isJudgmentLabel(42)).toBe(false);
      expect(isJudgmentLabel(null)).toBe(false);
      expect(isJudgmentLabel(undefined)).toBe(false);
    });
  });

  describe('validateLabels', () => {
    it('valid labels をそのまま', () => {
      expect(validateLabels(['safe'])).toEqual(['safe']);
      expect(validateLabels(['harassment', 'backseat'])).toEqual(['harassment', 'backseat']);
    });

    it('配列でない入力 → safe', () => {
      expect(validateLabels('spoiler')).toEqual(['safe']);
      expect(validateLabels(null)).toEqual(['safe']);
      expect(validateLabels(undefined)).toEqual(['safe']);
    });

    it('全て不正 → safe', () => {
      expect(validateLabels(['x', 'y'])).toEqual(['safe']);
    });

    it('重複除去', () => {
      expect(validateLabels(['safe', 'safe', 'spoiler'])).toEqual(['safe', 'spoiler']);
    });
  });

  describe('validateConfidence', () => {
    it('0.0〜1.0 をそのまま', () => {
      expect(validateConfidence(0)).toBe(0);
      expect(validateConfidence(0.5)).toBe(0.5);
      expect(validateConfidence(1)).toBe(1);
    });

    it('範囲外をクランプ', () => {
      expect(validateConfidence(-0.5)).toBe(0);
      expect(validateConfidence(1.5)).toBe(1);
    });

    it('NaN → 0.5', () => {
      expect(validateConfidence(Number.NaN)).toBe(0.5);
    });

    it('型不正 → 0.5', () => {
      expect(validateConfidence('0.9')).toBe(0.5);
      expect(validateConfidence(null)).toBe(0.5);
      expect(validateConfidence(undefined)).toBe(0.5);
    });
  });
});

describe('classifyParse (B4a degraded 判定)', () => {
  it('正常な JSON 配列 → ok', () => {
    expect(classifyParse('[{"messageId":"m1","labels":["safe"]}]').status).toBe('ok');
  });

  it('空配列 [] も ok（LLM が空回答しただけ、壊れていない）', () => {
    expect(classifyParse('[]').status).toBe('ok');
  });

  it('配列が見つからない（空文字）→ no_array', () => {
    expect(classifyParse('').status).toBe('no_array');
  });

  it('説明文のみで配列なし → no_array', () => {
    expect(classifyParse('判定できませんでした').status).toBe('no_array');
  });

  it('配列断片はあるが JSON 不正 → json_error（error を保持）', () => {
    const r = classifyParse('[{bad json,,}]');
    expect(r.status).toBe('json_error');
    expect(r.error).toBeInstanceOf(Error);
  });
});

describe('parseMultiLabelResponseDetailed (degraded 伝播)', () => {
  it('正常応答 → degraded:false、judgments は通常パース', () => {
    const r = parseMultiLabelResponseDetailed(
      '[{"messageId":"m1","labels":["spoiler"],"primary":"spoiler","confidence":0.9}]',
      ['m1'],
    );
    expect(r.degraded).toBe(false);
    expect(r.judgments[0]?.primary).toBe('spoiler');
  });

  it('パース失敗 → degraded:true、judgments は全件 safe fallback', () => {
    const r = parseMultiLabelResponseDetailed('壊れた応答', ['m1', 'm2']);
    expect(r.degraded).toBe(true);
    expect(r.judgments).toHaveLength(2);
    expect(r.judgments.every((j) => j.primary === 'safe')).toBe(true);
  });

  it('JSON 例外 → degraded:true', () => {
    const r = parseMultiLabelResponseDetailed('[{bad,,}]', ['m1']);
    expect(r.degraded).toBe(true);
    expect(r.judgments[0]?.primary).toBe('safe');
  });

  it('空配列 [] は degraded:false（LLM 空回答、全件 safeFallback だが再判定不要）', () => {
    const r = parseMultiLabelResponseDetailed('[]', ['m1']);
    expect(r.degraded).toBe(false);
    expect(r.judgments[0]?.primary).toBe('safe');
  });
});
