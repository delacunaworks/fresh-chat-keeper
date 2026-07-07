import { describe, it, expect } from 'vitest';
import { renderPlanSummary } from '../src/render.js';

describe('renderPlanSummary', () => {
  it('5 時間 VOD の計画・見積りを整形する（--dry-run 出力）', () => {
    const out = renderPlanSummary({ videoId: 'PHPWFt6d5TM', durationSeconds: 18000 });
    expect(out).toContain('videoId : PHPWFt6d5TM');
    expect(out).toContain('5:00:00');
    expect(out).toContain('30 個'); // 5h / 10min = 30 チャンク
    expect(out).toContain('$1.10');
  });

  it('端数チャンクを含む長さ', () => {
    const out = renderPlanSummary({ videoId: 'x', durationSeconds: 1500 }); // 25 分 → 3 チャンク
    expect(out).toContain('3 個');
  });
});
