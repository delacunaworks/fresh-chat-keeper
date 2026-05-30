/**
 * Phase 3.5 B9: FlaggingIntroduction の純関数 + markup テスト。
 *
 * jsdom 非導入のため、useEffect/click は renderToStaticMarkup では発火しない。
 * 表示判定・アクションのロジックは純関数（shouldShowNotice / buildNoticeActions）に
 * 切り出してモックで検証し、バナーの見た目は presentational コンポーネントを
 * renderToStaticMarkup で検証する（collection-consent-modal.test.tsx と同方針）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  shouldShowNotice,
  buildNoticeActions,
  FlaggingIntroductionBanner,
  NOTICE_DISMISSED_KEY,
} from './FlaggingIntroduction.js';

interface FakeStorage {
  setArgs: Array<Record<string, unknown>>;
}

function installFakeChrome(): FakeStorage {
  const state: FakeStorage = { setArgs: [] };
  const fake = {
    storage: {
      local: {
        set: (entries: Record<string, unknown>) => {
          state.setArgs.push(entries);
          return Promise.resolve();
        },
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return state;
}

describe('shouldShowNotice', () => {
  it('dismissed 未設定（undefined）→ 表示', () => {
    expect(shouldShowNotice(undefined)).toBe(true);
  });
  it('dismissed === false / null / 0 → 表示（true 以外はすべて表示）', () => {
    expect(shouldShowNotice(false)).toBe(true);
    expect(shouldShowNotice(null)).toBe(true);
    expect(shouldShowNotice(0)).toBe(true);
  });
  it('dismissed === true → 非表示', () => {
    expect(shouldShowNotice(true)).toBe(false);
  });
});

describe('NOTICE_DISMISSED_KEY', () => {
  it('CLAUDE.md 命名規約 fck_notice_v5_dismissed', () => {
    expect(NOTICE_DISMISSED_KEY).toBe('fck_notice_v5_dismissed');
  });
});

describe('buildNoticeActions', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('dismiss: fck_notice_v5_dismissed=true 保存 + setHidden 呼ばれる', () => {
    const setHidden = vi.fn();
    const onGoToFlagging = vi.fn();
    const { dismiss } = buildNoticeActions(setHidden, onGoToFlagging);
    dismiss();
    expect(fake.setArgs).toEqual([{ [NOTICE_DISMISSED_KEY]: true }]);
    expect(setHidden).toHaveBeenCalledTimes(1);
    expect(onGoToFlagging).not.toHaveBeenCalled();
  });

  it('goFlagging: dismiss（保存 + setHidden）してから onGoToFlagging 呼ばれる', () => {
    const setHidden = vi.fn();
    const onGoToFlagging = vi.fn();
    const { goFlagging } = buildNoticeActions(setHidden, onGoToFlagging);
    goFlagging();
    expect(fake.setArgs).toEqual([{ [NOTICE_DISMISSED_KEY]: true }]);
    expect(setHidden).toHaveBeenCalledTimes(1);
    expect(onGoToFlagging).toHaveBeenCalledTimes(1);
  });

  it('goFlagging は enabled を変更しない（storage 書き込みは dismissed キーのみ）', () => {
    const { goFlagging } = buildNoticeActions(vi.fn(), vi.fn());
    goFlagging();
    // 書き込みは dismissed キー 1 件のみ（userFlagging.enabled には触れない）
    expect(fake.setArgs).toHaveLength(1);
    expect(Object.keys(fake.setArgs[0])).toEqual([NOTICE_DISMISSED_KEY]);
  });
});

describe('FlaggingIntroductionBanner: markup', () => {
  it('見出し / プライバシー注記 / 2 ボタン / role=region が描画される', () => {
    const html = renderToStaticMarkup(
      <FlaggingIntroductionBanner onGoToFlagging={() => undefined} onDismiss={() => undefined} />,
    );
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="新機能のお知らせ"');
    expect(html).toContain('🎉 新機能: 視聴者フラグ');
    // プライバシー強調（外部送信なし）
    expect(html).toContain('外部送信はありません');
    expect(html).toContain('初期状態は OFF');
    // dismiss ボタン + タブ誘導ボタン
    expect(html).toContain('aria-label="お知らせを閉じる"');
    expect(html).toContain('フラグ視聴者タブを見る');
  });
});
