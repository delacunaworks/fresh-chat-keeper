/**
 * computeActionBarPosition の単体テスト。
 *
 * ActionBarManager 本体は DOM 依存が強く（jsdom 非導入方針）手動テストで
 * 担保するが、配置座標の算出だけは純粋関数に切り出しているのでここで保護する。
 */

import { describe, it, expect } from 'vitest';
import {
  computeActionBarPosition,
  type RectLike,
} from '../src/content/user-blocking/hover-manager.js';

const VW = 1280;
const VH = 720;
// テストで使う既定バーサイズ（hover-manager の BAR_WIDTH_EST/HEIGHT_EST と一致）
const BAR_W = 160;
const BAR_H = 32;

function rect(partial: Partial<RectLike>): RectLike {
  return { left: 100, right: 300, top: 200, height: 24, ...partial };
}

describe('computeActionBarPosition', () => {
  it('既定はコメント右隣（right + 8）の垂直中央', () => {
    const r = rect({ right: 300, top: 200, height: 24 });
    const { left, top } = computeActionBarPosition(r, VW, VH, BAR_W, BAR_H);
    expect(left).toBe(308); // 300 + 8
    expect(top).toBe(200 + 24 / 2 - BAR_H / 2); // 200 + 12 - 16 = 196
  });

  it('右にはみ出す場合は左側へ回す（left - barWidth - 8）', () => {
    // right = 1200, 1200+8+160 = 1368 > 1280 → 左へ
    const r = rect({ left: 1100, right: 1200 });
    const { left } = computeActionBarPosition(r, VW, VH, BAR_W, BAR_H);
    expect(left).toBe(1100 - BAR_W - 8); // 932
  });

  it('左へ回しても画面外なら 8px でクリップ', () => {
    // 画面右端ぎりぎり & コメントが極端に左 → left - barWidth - 8 が負
    const r = rect({ left: 10, right: 1270 });
    const { left } = computeActionBarPosition(r, VW, VH, BAR_W, BAR_H);
    expect(left).toBe(8);
  });

  it('上方向にはみ出す場合は top を 8 にクリップ', () => {
    const r = rect({ top: -50, height: 24, right: 300 });
    const { top } = computeActionBarPosition(r, VW, VH, BAR_W, BAR_H);
    expect(top).toBe(8);
  });

  it('下方向にはみ出す場合は viewportHeight - barHeight - 8 にクリップ', () => {
    const r = rect({ top: 1000, height: 24, right: 300 });
    const { top } = computeActionBarPosition(r, VW, VH, BAR_W, BAR_H);
    expect(top).toBe(VH - BAR_H - 8); // 680
  });

  it('ビューポート内に収まる通常ケースはクリップされない', () => {
    const r = rect({ left: 400, right: 600, top: 360, height: 20 });
    const { left, top } = computeActionBarPosition(r, VW, VH, BAR_W, BAR_H);
    expect(left).toBe(608);
    expect(top).toBe(360 + 10 - 16); // 354
  });

  it('barWidth/barHeight 既定引数でも動作（hover-manager 内部既定と一致）', () => {
    const r = rect({ right: 300, top: 200, height: 24 });
    const { left, top } = computeActionBarPosition(r, VW, VH);
    expect(left).toBe(308);
    expect(top).toBe(196);
  });
});
