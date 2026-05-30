/**
 * Phase 3.5 B6: stats-panel-entry のテスト。
 *
 * mount / unmount のライフサイクル動作のみ検証する。React の本物 createRoot
 * は jsdom 完全 DOM を要求するため vi.mock で 'react-dom/client' を no-op
 * モックに置換し、DOM 要素の追加・除去と singleton 切替だけを検証する。
 * React 内部の描画は手動テストで担保。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// stats-panel-entry が createRoot を呼ぶが、その先の render / unmount は no-op で問題ない。
// 静的 import の前に vi.mock を hoist する（vitest が自動で先頭へ持ち上げる）。
vi.mock('react-dom/client', () => ({
  createRoot: () => ({
    render: vi.fn(),
    unmount: vi.fn(),
  }),
}));

import { openStatsPanel, closeCurrent, __test__ } from './stats-panel-entry.js';
import { SessionTracker } from './session-tracker.js';

interface StubElement {
  id: string;
  tagName: string;
  textContent: string;
  attributes: Map<string, string>;
  children: StubElement[];
  parent: StubElement | null;
  /**
   * B6-hotfix-3: HTMLElement.offsetParent 模倣。visible なら任意 truthy 値、
   * 非表示なら null。closeYouTubeNativeDropdowns の visibility 判定で使用。
   */
  offsetParent?: unknown;
  appendChild(child: StubElement): StubElement;
  remove(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
}

function makeStubElement(tagName = 'div'): StubElement {
  const el: StubElement = {
    id: '',
    tagName: tagName.toUpperCase(),
    textContent: '',
    attributes: new Map<string, string>(),
    children: [],
    parent: null,
    appendChild(child: StubElement) {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (el.parent) {
        const idx = el.parent.children.indexOf(el);
        if (idx >= 0) el.parent.children.splice(idx, 1);
        el.parent = null;
      }
    },
    setAttribute(k, v) {
      el.attributes.set(k, v);
    },
    getAttribute(k) {
      return el.attributes.get(k) ?? null;
    },
  };
  return el;
}

interface StubDocument {
  head: StubElement;
  documentElement: StubElement;
  body: StubElement;
  createElement(tag?: string): StubElement;
  getElementById(id: string): StubElement | null;
  querySelectorAll(selector: string): StubElement[];
  /** B6-hotfix-3: Escape dispatch を観測するための spy フック。 */
  dispatchEvent(ev: { type: string; key?: string }): boolean;
}

function installStubDocument(): {
  doc: StubDocument;
  head: StubElement;
  body: StubElement;
  allElements: StubElement[];
  /** B6-hotfix-3: dispatchEvent 呼び出しを観測する spy。 */
  dispatchSpy: ReturnType<typeof vi.fn>;
} {
  const head = makeStubElement('head');
  const documentElement = makeStubElement('html');
  const body = makeStubElement('body');
  const allElements: StubElement[] = [head, documentElement, body];
  const dispatchSpy = vi.fn((_ev: unknown) => true);
  const doc: StubDocument = {
    head,
    documentElement,
    body,
    createElement(tag = 'div') {
      const el = makeStubElement(tag);
      allElements.push(el);
      return el;
    },
    getElementById(id: string) {
      const walk = (start: StubElement[]): StubElement | null => {
        for (const e of start) {
          if (e.id === id) return e;
          const found = walk(e.children);
          if (found) return found;
        }
        return null;
      };
      return walk([head, body]);
    },
    // B6-hotfix-2: tag name 一致のみサポート（closeYouTubeNativeDropdowns の用途で十分）
    querySelectorAll(selector: string): StubElement[] {
      const target = selector.toUpperCase();
      return allElements.filter((el) => el.tagName === target);
    },
    // B6-hotfix-3: Escape dispatch を観測する spy
    dispatchEvent(ev) {
      return dispatchSpy(ev) as boolean;
    },
  };
  (globalThis as unknown as { document: StubDocument }).document = doc;
  // B6-hotfix-2/3: window.parent をテスト用に同 document を指すよう設定
  // （closeYouTubeNativeDropdowns が parent document を見にいく経路を通すため）。
  // self-parent（window.parent === window）状態を作るため window と parent を
  // 別オブジェクトにする（!== 比較が真になり parent document も走査される）。
  (globalThis as unknown as {
    window: { parent: { document: StubDocument } };
  }).window = {
    parent: { document: doc },
  };
  // B6-hotfix-3: KeyboardEvent コンストラクタを globalThis に注入（node 既定では未定義）
  (globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent =
    class KeyboardEventStub {
      type: string;
      key: string;
      constructor(type: string, init?: { key?: string }) {
        this.type = type;
        this.key = init?.key ?? '';
      }
    } as unknown as typeof KeyboardEvent;
  return { doc, head, body, allElements, dispatchSpy };
}

describe('stats-panel-entry', () => {
  let body: StubElement;
  let head: StubElement;
  let allElements: StubElement[];
  let dispatchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const installed = installStubDocument();
    body = installed.body;
    head = installed.head;
    allElements = installed.allElements;
    dispatchSpy = installed.dispatchSpy;
    __test__.reset();
  });

  afterEach(() => {
    __test__.reset();
  });

  it('openStatsPanel で #fck-stats-panel-root が document.body に追加される', () => {
    openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker());
    const root = body.children.find((c) => c.id === __test__.ROOT_ELEMENT_ID);
    expect(root).toBeDefined();
    expect(__test__.hasCurrentPanel()).toBe(true);
  });

  it('2 回連続 open で前の panel が closed されて、新 panel が単独になる（singleton）', () => {
    openStatsPanel('UC_x', '@a', '@a', new SessionTracker());
    openStatsPanel('UC_x', '@b', '@b', new SessionTracker());
    const roots = body.children.filter((c) => c.id === __test__.ROOT_ELEMENT_ID);
    expect(roots.length).toBe(1);
    expect(__test__.hasCurrentPanel()).toBe(true);
  });

  it('closeCurrent で root が DOM から消える + currentPanel が null になる', () => {
    openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker());
    expect(__test__.hasCurrentPanel()).toBe(true);
    closeCurrent();
    expect(__test__.hasCurrentPanel()).toBe(false);
    expect(body.children.find((c) => c.id === __test__.ROOT_ELEMENT_ID)).toBeUndefined();
  });

  it('closeCurrent: 開いていなくても例外を投げない（冪等）', () => {
    expect(() => closeCurrent()).not.toThrow();
    expect(__test__.hasCurrentPanel()).toBe(false);
  });

  it('openStatsPanel 1 回目で <style id="fck-stats-panel-styles"> が head に inject される', () => {
    openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker());
    const styleEl = head.children.find((c) => c.id === __test__.STYLE_ELEMENT_ID);
    expect(styleEl).toBeDefined();
    expect(styleEl?.textContent).toContain('fck-stats-overlay');
  });

  // ─── B6-hotfix-3: closeYouTubeNativeDropdowns（Escape dispatch 方式） ───

  function makePopup(opts: { visible: boolean }): StubElement {
    const el = makeStubElement('ytd-menu-popup-renderer');
    // offsetParent は HTMLElement の可視性プロキシ。truthy なら visible、null なら hidden。
    el.offsetParent = opts.visible ? ({} as unknown) : null;
    allElements.push(el);
    return el;
  }

  it('B6-hotfix-3: visible な ytd-menu-popup-renderer 存在 → Escape を dispatch', () => {
    makePopup({ visible: true });

    openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker());

    expect(dispatchSpy).toHaveBeenCalled();
    const ev = dispatchSpy.mock.calls[0][0] as { type: string; key: string };
    expect(ev.type).toBe('keydown');
    expect(ev.key).toBe('Escape');
    expect(__test__.hasCurrentPanel()).toBe(true); // 通常 mount も走る
  });

  it('B6-hotfix-3: popup 存在するが offsetParent=null（hidden） → dispatch 呼ばれない', () => {
    makePopup({ visible: false });

    openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker());

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(__test__.hasCurrentPanel()).toBe(true);
  });

  it('B6-hotfix-3: popup が 1 つも無い → dispatch 呼ばれない、panel は正常 mount（回帰なし）', () => {
    openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker());

    expect(dispatchSpy).not.toHaveBeenCalled();
    const root = body.children.find((c) => c.id === __test__.ROOT_ELEMENT_ID);
    expect(root).toBeDefined();
    expect(__test__.hasCurrentPanel()).toBe(true);
  });

  it('B6-hotfix-3: dispatchEvent が throw しても panel mount は続く（try/catch ガード）', () => {
    makePopup({ visible: true });
    dispatchSpy.mockImplementation(() => {
      throw new Error('dispatch failed');
    });

    expect(() =>
      openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker()),
    ).not.toThrow();
    expect(dispatchSpy).toHaveBeenCalled();
    expect(__test__.hasCurrentPanel()).toBe(true);
  });

  it('B6-hotfix-3: visible popup と hidden popup 混在 → visible が 1 つでもあれば dispatch', () => {
    makePopup({ visible: false });
    makePopup({ visible: true });
    makePopup({ visible: false });

    openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker());

    // 自 document + parent document の両走査だが同 doc を共有するので 2 回 dispatch される
    expect(dispatchSpy).toHaveBeenCalled();
    const calls = dispatchSpy.mock.calls;
    expect(calls.every((c) => (c[0] as { key: string }).key === 'Escape')).toBe(true);
  });
});
