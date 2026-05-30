/**
 * Phase 3.5 B6: StatsPanel の mount / unmount ライフサイクル。
 *
 * `openStatsPanel(...)` で React モーダルを document.body 直下にマウントする。
 * singleton: 既にパネルが開いていれば閉じてから開き直す。`closeCurrent` は
 * `<StatsPanel onClose={...}>` から呼ばれる。
 *
 * CSS は `ensureStylesInjected()` で 1 度だけ `<style>` を `document.head` に
 * inject する（ui-overlay と同パターン）。
 */

import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { StatsPanel } from './StatsPanel.js';
import type { SessionTracker } from './session-tracker.js';

const ROOT_ELEMENT_ID = 'fck-stats-panel-root';
const STYLE_ELEMENT_ID = 'fck-stats-panel-styles';

interface MountedPanel {
  root: Root;
  el: HTMLElement;
}

let currentPanel: MountedPanel | null = null;

/**
 * YouTube ネイティブの 3 点メニュー（`tp-yt-iron-dropdown`）が開いていると
 * Polymer iron-overlay の scroll lock が document に capture フェーズで効き、
 * FCK パネル内の wheel/touchmove スクロールが奪われる（スクロールバーのみ可）。
 * パネルを開く前に開いている dropdown を閉じてロックを解放する。
 *
 * content script は live_chat_replay iframe で動くため、まず自 document を見る。
 * 念のため parent document（watch ページ側、同一 origin）も走査する。
 */
function closeYouTubeNativeDropdowns(): void {
  const docs: Document[] = [];
  if (typeof document !== 'undefined') docs.push(document);
  try {
    const parentDoc =
      typeof window !== 'undefined' && window.parent !== window
        ? window.parent.document
        : null;
    if (parentDoc && !docs.includes(parentDoc)) docs.push(parentDoc);
  } catch {
    // cross-origin 例外ガード（YouTube は同一 origin なので通常到達しない）
  }

  for (const doc of docs) {
    let dropdowns: NodeListOf<Element>;
    try {
      dropdowns = doc.querySelectorAll('tp-yt-iron-dropdown');
    } catch {
      continue;
    }
    dropdowns.forEach((d) => {
      const el = d as Element & { opened?: boolean; close?: () => void };
      const isOpen =
        el.opened === true || d.getAttribute('aria-hidden') === 'false';
      if (isOpen && typeof el.close === 'function') {
        try {
          el.close();
        } catch {
          // close 失敗は無視（YouTube 実装変更耐性）
        }
      }
    });
  }
}

/**
 * StatsPanel を開く。archive.ts の menu-manager.onStats から呼ばれる。
 * userFlagging.enabled の gating は archive.ts 側で行う（本関数は無条件 open）。
 */
export function openStatsPanel(
  streamerChannelId: string,
  userChannelId: string,
  userDisplayName: string,
  sessionTracker: SessionTracker,
): void {
  try {
    // YouTube ネイティブメニューが開いていると scroll lock で StatsPanel 内
    // スクロールが効かなくなるので、最初にロックを解放する。
    closeYouTubeNativeDropdowns();

    ensureStylesInjected();

    // singleton: 既存パネルがあれば閉じてから開き直す
    if (currentPanel) {
      closeCurrent();
    }

    const el = document.createElement('div');
    el.id = ROOT_ELEMENT_ID;
    document.body.appendChild(el);

    const root = createRoot(el);
    currentPanel = { root, el };

    root.render(
      createElement(StatsPanel, {
        streamerChannelId,
        userChannelId,
        userDisplayName,
        sessionTracker,
        onClose: closeCurrent,
      }),
    );
  } catch (err) {
    console.error('[FreshChatKeeper] openStatsPanel failed:', err);
  }
}

/** 開いているパネルを閉じる（StatsPanel onClose / open 直前のクリア / dispose）。 */
export function closeCurrent(): void {
  if (!currentPanel) return;
  const { root, el } = currentPanel;
  currentPanel = null;
  try {
    root.unmount();
  } catch {
    // unmount は冪等にはならないことがあるが、片付けを止めない
  }
  el.remove();
}

const STYLE_TEXT = `
.fck-stats-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: "Roboto", "Helvetica Neue", Arial, sans-serif;
}
.fck-stats-panel {
  background: #fff;
  color: #202020;
  width: min(420px, 92vw);
  max-height: 88vh;
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  outline: none;
}
.fck-stats-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px 10px;
  border-bottom: 1px solid #ececec;
}
.fck-stats-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #202020;
  word-break: break-all;
}
.fck-stats-close {
  background: transparent;
  border: none;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  color: #666;
  padding: 4px 8px;
  border-radius: 6px;
}
.fck-stats-close:hover { background: #f0f0f0; }
.fck-stats-close:focus-visible {
  outline: 2px solid #1a73e8;
  outline-offset: 2px;
}

.fck-stats-body {
  padding: 14px 18px;
  overflow-y: auto;
  flex: 1;
  font-size: 13px;
  line-height: 1.5;
}
.fck-stats-loading { color: #888; }
.fck-stats-empty { color: #666; }
.fck-stats-section { margin-bottom: 14px; }
.fck-stats-section:last-child { margin-bottom: 0; }
.fck-stats-observed { color: #555; font-size: 12px; margin-bottom: 6px; }
.fck-stats-h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 6px;
  color: #333;
}
.fck-stats-badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.fck-flag-badge-red { background: #fde7e7; color: #c62828; }
.fck-flag-badge-yellow { background: #fff4d6; color: #b8860b; }
.fck-flag-badge-grey { background: #ececec; color: #555; }
.fck-flag-badge-clean { background: #e3f2e8; color: #2e7d32; }

.fck-stats-summary > div { margin-bottom: 2px; }
.fck-stats-breakdown ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.fck-stats-breakdown li {
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  border-bottom: 1px dashed #f0f0f0;
}
.fck-stats-breakdown li:last-child { border-bottom: none; }
.fck-stats-breakdown-zero { opacity: 0.4; }

.fck-stats-footer {
  display: flex;
  gap: 8px;
  padding: 12px 18px 16px;
  border-top: 1px solid #ececec;
}
.fck-stats-action {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  background: #f5f5f5;
  color: #202020;
}
.fck-stats-action:hover { background: #ececec; }
.fck-stats-action:focus-visible {
  outline: 2px solid #1a73e8;
  outline-offset: 2px;
}
.fck-stats-action:disabled { opacity: 0.5; cursor: not-allowed; }
.fck-stats-block {
  background: #fde7e7;
  color: #c62828;
  border-color: #f5c2c2;
}
.fck-stats-block:hover { background: #f9d3d3; }
.fck-stats-reset {
  background: #fff;
  color: #555;
  border-color: #ddd;
}

/* === DailyTimeline === */
.fck-daily-timeline {
  display: grid;
  grid-template-columns: 56px repeat(7, 1fr);
  gap: 4px;
  margin-top: 4px;
}
.fck-daily-header, .fck-daily-row {
  display: contents;
}
.fck-daily-row-label {
  font-size: 11px;
  color: #888;
  display: flex;
  align-items: center;
}
.fck-daily-dow {
  font-size: 11px;
  color: #888;
  text-align: center;
}
.fck-daily-cell {
  aspect-ratio: 1;
  border-radius: 3px;
  border: 1px solid #eee;
  background: #fafafa;
}
.fck-daily-empty { background: #f5f5f5; opacity: 0.45; }
.fck-daily-clean { background: #e8f5ec; border-color: #d4ead9; }
.fck-daily-low { background: #fff4cf; border-color: #f0d57a; }
.fck-daily-high { background: #fbcfcf; border-color: #f0a0a0; }
`;

function ensureStylesInjected(): void {
  try {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = STYLE_TEXT;
    (document.head ?? document.documentElement).appendChild(style);
  } catch {
    // ignore
  }
}

export const __test__ = {
  ROOT_ELEMENT_ID,
  STYLE_ELEMENT_ID,
  hasCurrentPanel(): boolean {
    return currentPanel !== null;
  },
  reset(): void {
    if (currentPanel) {
      try {
        currentPanel.root.unmount();
      } catch {
        // ignore
      }
      currentPanel.el.remove();
      currentPanel = null;
    }
  },
};
