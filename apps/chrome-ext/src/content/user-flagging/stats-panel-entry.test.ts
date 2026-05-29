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
  textContent: string;
  attributes: Map<string, string>;
  children: StubElement[];
  parent: StubElement | null;
  appendChild(child: StubElement): StubElement;
  remove(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
}

function makeStubElement(): StubElement {
  const el: StubElement = {
    id: '',
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
  createElement(): StubElement;
  getElementById(id: string): StubElement | null;
}

function installStubDocument(): { doc: StubDocument; head: StubElement; body: StubElement } {
  const head = makeStubElement();
  const documentElement = makeStubElement();
  const body = makeStubElement();
  const allElements: StubElement[] = [head, documentElement, body];
  const doc: StubDocument = {
    head,
    documentElement,
    body,
    createElement() {
      const el = makeStubElement();
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
  };
  (globalThis as unknown as { document: StubDocument }).document = doc;
  return { doc, head, body };
}

describe('stats-panel-entry', () => {
  let body: StubElement;
  let head: StubElement;

  beforeEach(() => {
    const installed = installStubDocument();
    body = installed.body;
    head = installed.head;
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
});
