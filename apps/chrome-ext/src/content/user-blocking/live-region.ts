/**
 * SR ライブリージョン（キュー化、polite/assertive 使い分け）。
 *
 * Hover-Safe a11y 原則 A-3 補強（architecture.md §2.1.4.1、B4a レビュー）:
 * - 連続告知（コメント流去 + ブロック完了 + 報告完了が近接発火）を取りこぼさない
 *   よう、メッセージをキュー化し前メッセージの読み上げ猶予を確保する
 * - 通常通知は `role="status"`（polite）、エラー/必須通知（WCAG 3.3.1）は
 *   `role="alert"`（assertive）と別リージョンで使い分ける
 * - 各リージョンは「空挿入 → 次フレームでテキスト投入」を直列化する
 *
 * 単一リージョン使い回しによる読み上げ取りこぼしを防ぐのが要点。
 */

const POLITE_REGION_ID = 'fck-live-region-polite';
const ASSERTIVE_REGION_ID = 'fck-live-region-assertive';

/** 同一メッセージを連続投入する間隔の下限（読み上げ猶予、1 フレーム + α） */
const DRAIN_INTERVAL_MS = 350;

interface RegionState {
  el: HTMLElement;
  queue: string[];
  draining: boolean;
}

const states = new Map<'polite' | 'assertive', RegionState>();

function ensureRegion(kind: 'polite' | 'assertive'): RegionState {
  const existing = states.get(kind);
  if (existing && document.contains(existing.el)) return existing;

  const id = kind === 'polite' ? POLITE_REGION_ID : ASSERTIVE_REGION_ID;
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.setAttribute('role', kind === 'polite' ? 'status' : 'alert');
    el.setAttribute('aria-live', kind === 'polite' ? 'polite' : 'assertive');
    el.setAttribute('aria-atomic', 'true');
    // 視覚的に隠す（SR からは読める）
    el.style.cssText =
      'position:fixed;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;';
    document.body.appendChild(el);
  }
  const state: RegionState = { el, queue: [], draining: false };
  states.set(kind, state);
  return state;
}

function drain(kind: 'polite' | 'assertive'): void {
  const state = ensureRegion(kind);
  if (state.draining) return;
  const next = state.queue.shift();
  if (next === undefined) return;
  state.draining = true;
  // 空にしてから次フレームで投入（DOM 変化を SR に確実に検知させる）
  state.el.textContent = '';
  requestAnimationFrame(() => {
    state.el.textContent = next;
    setTimeout(() => {
      state.draining = false;
      drain(kind);
    }, DRAIN_INTERVAL_MS);
  });
}

/**
 * SR へ告知する。
 * @param message 読み上げ文（textContent 経由、XSS なし）
 * @param opts.assertive true で `role="alert"`（エラー/必須通知）。既定 polite。
 */
export function announce(
  message: string,
  opts?: { assertive?: boolean },
): void {
  if (!message) return;
  const kind = opts?.assertive ? 'assertive' : 'polite';
  const state = ensureRegion(kind);
  state.queue.push(message);
  drain(kind);
}

/** テスト用: キュー長を返す。 */
export function __getQueueLength(kind: 'polite' | 'assertive'): number {
  return states.get(kind)?.queue.length ?? 0;
}
