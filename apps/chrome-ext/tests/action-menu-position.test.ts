/**
 * computeMenuPosition の単体テスト（B5: 行内アンカー + クリックメニュー）。
 *
 * ActionMenuManager 本体は DOM 依存が強く（jsdom 非導入方針）手動テストで
 * 担保するが、配置座標の算出だけは純粋関数に切り出しているのでここで保護する。
 * 基準矩形は B5 で「コメント矩形」→「行内トリガ矩形」に変わったが、
 * アルゴリズム（右隣→左回し→クリップ）は同一。
 */

import { describe, it, expect } from 'vitest';
import {
  computeMenuPosition,
  type RectLike,
} from '../src/content/user-blocking/menu-manager.js';

const VW = 1280;
const VH = 720;
// テストで使う明示バーサイズ（純粋関数なので任意値で検証可能）
const MENU_W = 160;
const MENU_H = 32;
// menu-manager 内部既定（MENU_WIDTH_EST / MENU_HEIGHT_EST と一致させる）
const DEFAULT_W = 160;
const DEFAULT_H = 40;

/** 行内トリガの矩形を模す（右端/上端/高さ） */
function rect(partial: Partial<RectLike>): RectLike {
  return { left: 100, right: 300, top: 200, height: 24, ...partial };
}

describe('computeMenuPosition', () => {
  it('既定はトリガ右隣（right + 8）の垂直中央', () => {
    const r = rect({ right: 300, top: 200, height: 24 });
    const { left, top } = computeMenuPosition(r, VW, VH, MENU_W, MENU_H);
    expect(left).toBe(308); // 300 + 8
    expect(top).toBe(200 + 24 / 2 - MENU_H / 2); // 200 + 12 - 16 = 196
  });

  it('右にはみ出す場合は左側へ回す（left - menuWidth - 8）', () => {
    // right = 1200, 1200+8+160 = 1368 > 1280 → 左へ
    const r = rect({ left: 1100, right: 1200 });
    const { left } = computeMenuPosition(r, VW, VH, MENU_W, MENU_H);
    expect(left).toBe(1100 - MENU_W - 8); // 932
  });

  it('左へ回しても画面外なら 8px でクリップ', () => {
    const r = rect({ left: 10, right: 1270 });
    const { left } = computeMenuPosition(r, VW, VH, MENU_W, MENU_H);
    expect(left).toBe(8);
  });

  it('上方向にはみ出す場合は top を 8 にクリップ', () => {
    const r = rect({ top: -50, height: 24, right: 300 });
    const { top } = computeMenuPosition(r, VW, VH, MENU_W, MENU_H);
    expect(top).toBe(8);
  });

  it('下方向にはみ出す場合は viewportHeight - menuHeight - 8 にクリップ', () => {
    const r = rect({ top: 1000, height: 24, right: 300 });
    const { top } = computeMenuPosition(r, VW, VH, MENU_W, MENU_H);
    expect(top).toBe(VH - MENU_H - 8); // 680
  });

  it('ビューポート内に収まる通常ケースはクリップされない', () => {
    const r = rect({ left: 400, right: 600, top: 360, height: 20 });
    const { left, top } = computeMenuPosition(r, VW, VH, MENU_W, MENU_H);
    expect(left).toBe(608);
    expect(top).toBe(360 + 10 - 16); // 354
  });

  it('menuWidth/menuHeight 既定引数でも動作（menu-manager 内部既定と一致）', () => {
    const r = rect({ right: 300, top: 200, height: 24 });
    const { left, top } = computeMenuPosition(r, VW, VH);
    expect(left).toBe(308);
    expect(top).toBe(200 + 24 / 2 - DEFAULT_H / 2); // 200 + 12 - 20 = 192
    // 既定幅は左回し判定にのみ影響（ここでは右に収まるので left は変わらない）
    expect(DEFAULT_W).toBe(160);
  });
});
