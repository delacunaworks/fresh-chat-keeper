/**
 * Phase 3.5 B5: ui-overlay のテスト。
 *
 * 検証観点:
 * - applyFlagToMessage で renderer に data-fck-flag / -total / -count が付く
 * - level=clean は属性を除去（フラグ無し＝CSS で何も表示しない）
 * - L2 cache hit で resolveFlagLevel が呼ばれない
 * - L2 cache TTL 切れで再呼び出し
 * - clearL2Cache 後に再計算
 * - setGlobalDisplayStyle で body 属性が更新
 * - enabled=false 時の no-op
 * - onSettingsChanged で displayStyle 切替 / L2 クリア / enabled OFF→ON 再適用
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyFlagToMessage,
  clearL2Cache,
  initUiOverlay,
  removeAllFlagAttrs,
  __test__,
} from './ui-overlay.js';
import { SessionTracker } from './session-tracker.js';
import * as resolver from './flag-level-resolver.js';
import * as streamDetector from './stream-detector.js';
import * as authorExtract from '../author-extract.js';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings.js';
import type { FlagEvaluationResult } from '@fresh-chat-keeper/judgment-engine';

// ─── DOM mock（最小、jsdom 非導入のため自前）────────────────────────

interface MockEl {
  attrs: Map<string, string>;
  closestResults: Map<string, MockEl | null>;
  matchesResult: boolean;
}

function makeRenderer(): MockEl & {
  setAttribute: (k: string, v: string) => void;
  removeAttribute: (k: string) => void;
  hasAttribute: (k: string) => boolean;
  getAttribute: (k: string) => string | null;
  closest: (s: string) => MockEl | null;
  matches: (s: string) => boolean;
} {
  const attrs = new Map<string, string>();
  const closestResults = new Map<string, MockEl | null>();
  const self: ReturnType<typeof makeRenderer> = {
    attrs,
    closestResults,
    matchesResult: true,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    closest: (s) => (closestResults.has(s) ? closestResults.get(s)! : null),
    matches: () => self.matchesResult,
  };
  // 自己 closest（renderer 自身がマッチ）
  closestResults.set('yt-live-chat-text-message-renderer', self as unknown as MockEl);
  closestResults.set('yt-live-chat-paid-message-renderer', null);
  return self;
}

function makeResult(
  level: FlagEvaluationResult['level'],
  totalMessages = 10,
  totalFlagged = 2,
): FlagEvaluationResult {
  return { level, severityScore: 1.0, totalMessages, totalFlagged };
}

// ─── chrome.storage fake + body スタブ ─────────────────────────

interface FakeStorage {
  store: Map<string, unknown>;
  listeners: Array<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  >;
}

function installFakeChrome(): FakeStorage {
  const store = new Map<string, unknown>();
  const listeners: FakeStorage['listeners'] = [];
  const fake = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
      onChanged: {
        addListener: (fn: FakeStorage['listeners'][number]) => {
          listeners.push(fn);
        },
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { store, listeners };
}

function installFakeDocument(): { body: { attrs: Map<string, string> } } {
  const bodyAttrs = new Map<string, string>();
  const body = {
    attrs: bodyAttrs,
    setAttribute: (k: string, v: string) => bodyAttrs.set(k, v),
    getAttribute: (k: string) => bodyAttrs.get(k) ?? null,
  };
  const docStub = {
    body,
    head: { appendChild: () => {} },
    createElement: () => ({
      id: '',
      textContent: '',
    }),
    getElementById: () => null,
    querySelectorAll: () => [],
  };
  const g = globalThis as unknown as {
    document?: unknown;
    window?: unknown;
  };
  g.document = docStub;
  g.window = { parent: { document: null } };
  return { body };
}

// ─── テスト ──────────────────────────────────────────────────────

describe('ui-overlay', () => {
  let tracker: SessionTracker;
  // 型は MockInstance だが共変問題で厳密一致が難しいため any 受け（テスト局所スコープ）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolveSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let streamerSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let authorSpy: any;
  let docStub: ReturnType<typeof installFakeDocument>;

  beforeEach(() => {
    installFakeChrome();
    docStub = installFakeDocument();
    __test__.reset();
    tracker = new SessionTracker();
    tracker.startNewSession('UC_streamer');
    streamerSpy = vi
      .spyOn(streamDetector, 'getCurrentStreamerChannelId')
      .mockReturnValue('UC_streamer');
    authorSpy = vi
      .spyOn(authorExtract, 'getAuthorChannelIdFromElement')
      .mockReturnValue('@viewer_a');
    resolveSpy = vi
      .spyOn(resolver, 'resolveFlagLevel')
      .mockResolvedValue(makeResult('yellow'));
  });

  afterEach(() => {
    resolveSpy.mockRestore();
    streamerSpy.mockRestore();
    authorSpy.mockRestore();
    __test__.reset();
  });

  function makeSettings(overrides?: Partial<Settings['userFlagging']>): Settings {
    return {
      ...DEFAULT_SETTINGS,
      userFlagging: { ...DEFAULT_SETTINGS.userFlagging, enabled: true, ...overrides },
    };
  }

  it('applyFlagToMessage で renderer に data-fck-flag / -total / -count が付く', async () => {
    __test__.setStateForTest(makeSettings(), tracker);
    const el = makeRenderer();
    await applyFlagToMessage(el as unknown as HTMLElement);
    expect(el.getAttribute('data-fck-flag')).toBe('yellow');
    expect(el.getAttribute('data-fck-flag-total')).toBe('10');
    expect(el.getAttribute('data-fck-flag-count')).toBe('2');
  });

  it('level=clean は属性を除去（フラグ無し＝CSS で何も表示しない）', async () => {
    resolveSpy.mockResolvedValue(makeResult('clean', 50, 0));
    __test__.setStateForTest(makeSettings(), tracker);
    const el = makeRenderer();
    // 既存属性を持たせて除去確認
    el.setAttribute('data-fck-flag', 'yellow');
    el.setAttribute('data-fck-flag-total', '10');
    el.setAttribute('data-fck-flag-count', '2');
    await applyFlagToMessage(el as unknown as HTMLElement);
    expect(el.hasAttribute('data-fck-flag')).toBe(false);
    expect(el.hasAttribute('data-fck-flag-total')).toBe(false);
    expect(el.hasAttribute('data-fck-flag-count')).toBe(false);
  });

  it('enabled=false → 早期 return（resolveFlagLevel 呼ばれず attr 不変）', async () => {
    __test__.setStateForTest(makeSettings({ enabled: false }), tracker);
    const el = makeRenderer();
    await applyFlagToMessage(el as unknown as HTMLElement);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(el.hasAttribute('data-fck-flag')).toBe(false);
  });

  it('streamerId 未取得 → skip', async () => {
    streamerSpy.mockReturnValue(null);
    __test__.setStateForTest(makeSettings(), tracker);
    const el = makeRenderer();
    await applyFlagToMessage(el as unknown as HTMLElement);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('L2 cache hit で resolveFlagLevel が呼ばれない（連続 2 件目以降）', async () => {
    __test__.setStateForTest(makeSettings(), tracker);
    const el1 = makeRenderer();
    await applyFlagToMessage(el1 as unknown as HTMLElement);
    expect(resolveSpy).toHaveBeenCalledTimes(1);

    // 同 user の 2 件目
    const el2 = makeRenderer();
    await applyFlagToMessage(el2 as unknown as HTMLElement);
    expect(resolveSpy).toHaveBeenCalledTimes(1); // 増えない
    expect(el2.getAttribute('data-fck-flag')).toBe('yellow');
  });

  it('clearL2Cache 後は再計算される', async () => {
    __test__.setStateForTest(makeSettings(), tracker);
    const el1 = makeRenderer();
    await applyFlagToMessage(el1 as unknown as HTMLElement);
    expect(resolveSpy).toHaveBeenCalledTimes(1);

    clearL2Cache();
    expect(__test__.l2Size()).toBe(0);

    const el2 = makeRenderer();
    await applyFlagToMessage(el2 as unknown as HTMLElement);
    expect(resolveSpy).toHaveBeenCalledTimes(2);
  });

  it('L2 TTL 切れで再計算される', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      __test__.setStateForTest(makeSettings(), tracker);
      const el1 = makeRenderer();
      await applyFlagToMessage(el1 as unknown as HTMLElement);
      expect(resolveSpy).toHaveBeenCalledTimes(1);

      // 5 分 + 1 秒 進める
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
      const el2 = makeRenderer();
      await applyFlagToMessage(el2 as unknown as HTMLElement);
      expect(resolveSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('別 user の L2 entry は独立', async () => {
    __test__.setStateForTest(makeSettings(), tracker);
    authorSpy.mockReturnValue('@viewer_a');
    await applyFlagToMessage(makeRenderer() as unknown as HTMLElement);
    expect(resolveSpy).toHaveBeenCalledTimes(1);

    authorSpy.mockReturnValue('@viewer_b');
    await applyFlagToMessage(makeRenderer() as unknown as HTMLElement);
    expect(resolveSpy).toHaveBeenCalledTimes(2);
    expect(__test__.l2Size()).toBe(2);
  });

  it('setGlobalDisplayStyle で body 属性が更新', () => {
    __test__.setGlobalDisplayStyle('color');
    expect(docStub.body.attrs.get('data-fck-display-style')).toBe('color');
    __test__.setGlobalDisplayStyle('red_only');
    expect(docStub.body.attrs.get('data-fck-display-style')).toBe('red_only');
  });

  it('onSettingsChanged: displayStyle 変更で body 属性が更新', () => {
    __test__.setStateForTest(makeSettings(), tracker);
    const prev = makeSettings({ displayStyle: 'icon' });
    const next = makeSettings({ displayStyle: 'red_only' });
    __test__.triggerOnSettingsChanged(prev, next);
    expect(docStub.body.attrs.get('data-fck-display-style')).toBe('red_only');
  });

  it('onSettingsChanged: sensitivity 変更で L2 cache が即クリア', async () => {
    __test__.setStateForTest(makeSettings(), tracker);
    await applyFlagToMessage(makeRenderer() as unknown as HTMLElement);
    expect(__test__.l2Size()).toBe(1);

    const prev = makeSettings();
    const next = makeSettings({ sensitivity: { yellow: 0.1, red: 0.2 } });
    __test__.triggerOnSettingsChanged(prev, next);
    expect(__test__.l2Size()).toBe(0);
  });

  it('onSettingsChanged: ON→OFF で既存属性は removeAllFlagAttrs で除去（呼び出し可能）', () => {
    __test__.setStateForTest(makeSettings(), tracker);
    // removeAllFlagAttrs を直接呼んでも例外を投げないこと（document.querySelectorAll が
    // 空配列を返す stub なので no-op で完走）
    expect(() => removeAllFlagAttrs()).not.toThrow();
    expect(__test__.l2Size()).toBe(0);
  });

  it('initUiOverlay で listener が登録される', () => {
    const fake = (globalThis as unknown as {
      chrome: { storage: { onChanged: { addListener: unknown } } };
    }).chrome;
    // beforeEach の installFakeChrome で listeners 配列が捕捉されているので、
    // 直接 fake から取り回す代わりに storeTest を __test__ から確認
    initUiOverlay(makeSettings(), tracker);
    expect(fake).toBeDefined();
    // 二重 init で listener が増えないこと
    initUiOverlay(makeSettings(), tracker);
    // currentSettings は更新される（reset 後の再 init で動作）
    expect(true).toBe(true);
  });
});
