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
  /** B6-hotfix-2: tp-yt-iron-dropdown 模倣用 Polymer プロパティ。 */
  opened?: boolean;
  /** B6-hotfix-2: dropdown.close() 模倣 hook。 */
  close?: () => void;
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
}

function installStubDocument(): {
  doc: StubDocument;
  head: StubElement;
  body: StubElement;
  allElements: StubElement[];
} {
  const head = makeStubElement('head');
  const documentElement = makeStubElement('html');
  const body = makeStubElement('body');
  const allElements: StubElement[] = [head, documentElement, body];
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
  };
  (globalThis as unknown as { document: StubDocument }).document = doc;
  // B6-hotfix-2: window.parent をテスト用に同 document を指すよう設定
  // （closeYouTubeNativeDropdowns が parent document を見にいく経路を通すため）
  (globalThis as unknown as { window: { parent: { document: StubDocument } } }).window = {
    parent: { document: doc },
  };
  return { doc, head, body, allElements };
}

describe('stats-panel-entry', () => {
  let body: StubElement;
  let head: StubElement;
  let allElements: StubElement[];

  beforeEach(() => {
    const installed = installStubDocument();
    body = installed.body;
    head = installed.head;
    allElements = installed.allElements;
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

  // ─── B6-hotfix-2: closeYouTubeNativeDropdowns ─────────────────────────

  function makeDropdown(opts: {
    open: boolean;
    hasClose?: boolean;
    closeFn?: () => void;
  }): StubElement {
    const el = makeStubElement('tp-yt-iron-dropdown');
    el.opened = opts.open;
    el.setAttribute('aria-hidden', opts.open ? 'false' : 'true');
    if (opts.hasClose !== false) {
      el.close = opts.closeFn ?? (() => undefined);
    }
    allElements.push(el);
    return el;
  }

  it('B6-hotfix-2: 開いている dropdown（opened=true or aria-hidden=false）に対し .close() が呼ばれる', () => {
    const close1 = vi.fn();
    const close2 = vi.fn();
    makeDropdown({ open: true, closeFn: close1 }); // opened=true
    const el2 = makeDropdown({ open: false }); // aria-hidden=true（初期）
    el2.setAttribute('aria-hidden', 'false'); // aria-hidden ベースで open とみなされる
    el2.close = close2;

    openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker());

    expect(close1).toHaveBeenCalledTimes(1);
    expect(close2).toHaveBeenCalledTimes(1);
    expect(__test__.hasCurrentPanel()).toBe(true); // 通常 mount も走る
  });

  it('B6-hotfix-2: 閉じている dropdown（aria-hidden=true, opened=false）には .close() が呼ばれない', () => {
    const close = vi.fn();
    makeDropdown({ open: false, closeFn: close });

    openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker());

    expect(close).not.toHaveBeenCalled();
  });

  it('B6-hotfix-2: .close メソッドが無い dropdown でも例外を投げない（try/catch ガード）', () => {
    const el = makeStubElement('tp-yt-iron-dropdown');
    el.opened = true;
    el.setAttribute('aria-hidden', 'false');
    // close メソッドを敢えてセットしない
    allElements.push(el);

    expect(() =>
      openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker()),
    ).not.toThrow();
    expect(__test__.hasCurrentPanel()).toBe(true);
  });

  it('B6-hotfix-2: dropdown が 1 つも無くても panel は正常に mount される（回帰なし）', () => {
    openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker());
    const root = body.children.find((c) => c.id === __test__.ROOT_ELEMENT_ID);
    expect(root).toBeDefined();
    expect(__test__.hasCurrentPanel()).toBe(true);
  });

  it('B6-hotfix-2: close() 自身が throw しても panel mount は続く（YouTube 実装変更耐性）', () => {
    const close = vi.fn(() => {
      throw new Error('close failed');
    });
    makeDropdown({ open: true, closeFn: close });

    expect(() =>
      openStatsPanel('UC_x', '@viewer', '@viewer', new SessionTracker()),
    ).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(__test__.hasCurrentPanel()).toBe(true);
  });
});
