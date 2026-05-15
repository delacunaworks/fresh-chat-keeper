/**
 * 誤判定報告フォーム（P3-UI-06）。アクションバーの ⚠️ から展開される。
 *
 * 設計正本: phase-3-multilabel.md §実装中の設計改訂 3、architecture.md §2.1.4.1
 * の A-1 補強（roving リング分離）/ A-3 補強（alert/status 使い分け）。
 *
 * 構成（上から）:
 *  1. プレビュー行: 30 字以内は全文、超過は「先頭18字 … 末尾12字」+ ⤢全文トグル
 *     （`aria-expanded`、展開で max-height + 内部スクロール）
 *  2. カテゴリ 7 択: `role="radiogroup"`（ネタバレ/暴言/スパム/無関係/指示厨/
 *     わからない・その他/スキップ）。↑↓/Home/End で移動＝選択（radiogroup 規約）
 *  3. アクション: [送信] [キャンセル]（`role="toolbar"` 等価アクション、←/→）
 *
 * 上記 1/2/3 は **独立した roving リング**。リング間は Tab、リング内は矢印キー。
 * 1 つの toolbar roving に「選択」と「アクション」を混在させない（A-1 補強）。
 */

import { announce } from './live-region.js';
import type { ReportedLabel } from '@fresh-chat-keeper/shared';

/** フィルタ済み→FP / 表示中→FN（呼び出し側が表示状態から自動判定） */
export type ReportKind = 'false_positive' | 'false_negative';

// B5 typescript hardening: ReportedLabel は shared に昇格（'safe' を型排除）。
// 呼び出し側（archive.ts）の import 経路を変えないよう re-export する。
export type { ReportedLabel } from '@fresh-chat-keeper/shared';

interface RadioOption {
  /** ReportedLabel か、スキップ（種別なし報告）を表す特別値 */
  value: ReportedLabel | '__skip__';
  label: string;
}

const RADIO_OPTIONS: RadioOption[] = [
  { value: 'spoiler', label: 'ネタバレ' },
  { value: 'harassment', label: '暴言' },
  { value: 'spam', label: 'スパム' },
  { value: 'off_topic', label: '無関係' },
  { value: 'backseat', label: '指示厨' },
  { value: 'unknown', label: 'わからない・その他' },
  { value: '__skip__', label: 'スキップ（種別なしで報告）' },
];

const PREVIEW_MAX = 30;
const PREVIEW_HEAD = 18;
const PREVIEW_TAIL = 12;

const STYLE_ELEMENT_ID = 'fck-report-form-styles';
const STYLE_TEXT = `
.fck-report-form { display: flex; flex-direction: column; gap: 6px; min-width: 240px; max-width: 320px; }
.fck-report-preview {
  font-size: 12px; color: #ddd; background: rgba(255,255,255,0.06);
  border-radius: 4px; padding: 4px 6px; line-height: 1.4;
}
.fck-report-preview.fck-expanded { max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
.fck-report-preview-toggle {
  background: transparent; border: none; color: #8ab4f8; cursor: pointer;
  font-size: 11px; padding: 2px 4px; border-radius: 4px;
}
.fck-report-preview-toggle:focus-visible { outline: 2px solid #3b82f6; outline-offset: 1px; }
.fck-report-radiogroup { display: flex; flex-wrap: wrap; gap: 4px; }
.fck-report-radio {
  background: rgba(255,255,255,0.08); border: 1px solid transparent; color: #fff;
  cursor: pointer; font-size: 12px; padding: 4px 8px; border-radius: 4px;
}
.fck-report-radio[aria-checked="true"] { background: #3b82f6; border-color: #93c5fd; font-weight: 600; }
.fck-report-radio:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
.fck-report-actions { display: flex; gap: 6px; justify-content: flex-end; }
.fck-report-actions button {
  border: none; cursor: pointer; font-size: 12px; padding: 5px 12px; border-radius: 4px;
}
.fck-report-submit { background: #3b82f6; color: #fff; }
.fck-report-submit:hover { background: #2563eb; }
.fck-report-cancel { background: rgba(255,255,255,0.12); color: #ddd; }
.fck-report-actions button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = STYLE_TEXT;
  (document.head ?? document.documentElement).appendChild(style);
}

/** プレビュー短縮（先頭 PREVIEW_HEAD … 末尾 PREVIEW_TAIL）。改行は空白化。 */
export function buildPreviewText(text: string): { short: string; truncated: boolean } {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(oneLine); // コードポイント単位（絵文字安全）
  if (chars.length <= PREVIEW_MAX) return { short: oneLine, truncated: false };
  const head = chars.slice(0, PREVIEW_HEAD).join('');
  const tail = chars.slice(chars.length - PREVIEW_TAIL).join('');
  return { short: `${head} … ${tail}`, truncated: true };
}

export interface BuildReportFormOptions {
  text: string;
  reportKind: ReportKind;
  /** 送信。reportedLabel: ラベル / 'unknown' / undefined（スキップ） */
  onSubmit: (reportedLabel: ReportedLabel | undefined) => void;
  onCancel: () => void;
}

export interface ReportFormHandle {
  element: HTMLElement;
  /** 表示直後にフォーカスすべき要素（キーボード起点時のみ呼ぶ） */
  focusFirst: () => void;
}

/**
 * 誤判定報告フォームを構築する。3 つの独立 roving リングを内包。
 */
export function buildReportForm(opts: BuildReportFormOptions): ReportFormHandle {
  ensureStyles();
  const root = document.createElement('div');
  root.className = 'fck-report-form';
  // B5 B-2: 外側二重 group 解消。フォーム全体の文脈（FP/FN）は呼び出し側
  // （menu-manager がメニューコンテナに付与する aria-label）が担う。ここで
  // root に role="group" を被せると radiogroup と二重グルーピングになり
  // SR でグループ名/件数が読み上げにくくなる（WCAG 1.3.1）。root は
  // 無 role の単なるレイアウトコンテナにする。

  // ── リング1: プレビュー ───────────────────────────────
  const { short, truncated } = buildPreviewText(opts.text);
  const preview = document.createElement('div');
  preview.className = 'fck-report-preview';
  const previewText = document.createElement('span');
  previewText.textContent = short;
  preview.appendChild(previewText);

  let firstFocusable: HTMLElement | null = null;

  if (truncated) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'fck-report-preview-toggle';
    toggle.textContent = '⤢ 全文';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', `コメント全文を表示。プレビュー: ${short}`);
    toggle.tabIndex = 0;
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        previewText.textContent = short;
        preview.classList.remove('fck-expanded');
        toggle.textContent = '⤢ 全文';
        toggle.setAttribute('aria-expanded', 'false');
      } else {
        previewText.textContent = opts.text;
        preview.classList.add('fck-expanded');
        toggle.textContent = '⤡ 折りたたむ';
        toggle.setAttribute('aria-expanded', 'true');
      }
    });
    preview.appendChild(toggle);
    firstFocusable = toggle;
  }
  root.appendChild(preview);

  // ── リング2: カテゴリ radiogroup ───────────────────────
  const radiogroup = document.createElement('div');
  radiogroup.className = 'fck-report-radiogroup';
  radiogroup.setAttribute('role', 'radiogroup');
  radiogroup.setAttribute('aria-label', '誤判定の種別を選択');
  // B5 B-2: 種別選択は送信に必須。SR に必須性を伝える（WCAG 3.3.1 / 4.1.2）。
  radiogroup.setAttribute('aria-required', 'true');
  let selected: number | null = null;
  const radios: HTMLButtonElement[] = [];

  const updateRoving = (focusIdx: number) => {
    radios.forEach((r, i) => {
      r.tabIndex = i === focusIdx ? 0 : -1;
    });
  };
  const select = (idx: number) => {
    selected = idx;
    // B5 B-2: 選択が起きて初めて全件 aria-checked を付与する。未選択のうちは
    // どの radio にも aria-checked を付けない（全件 false だと「選択済みだが
    // 全部 off」と誤認され、必須未選択であることが SR に伝わらない）。
    radios.forEach((r, i) => {
      r.setAttribute('aria-checked', i === idx ? 'true' : 'false');
    });
    updateRoving(idx);
  };

  RADIO_OPTIONS.forEach((opt, i) => {
    const radio = document.createElement('button');
    radio.type = 'button';
    radio.className = 'fck-report-radio';
    radio.setAttribute('role', 'radio');
    // B5 B-2: 初期は aria-checked を付与しない（未選択 = 必須未充足を SR に
    // 正しく伝える）。select() が初回選択時に全件へ true/false を付与する。
    radio.textContent = opt.label;
    radio.tabIndex = i === 0 ? 0 : -1; // 初期は先頭のみ tabstop（未選択）
    radio.addEventListener('click', () => select(i));
    radio.addEventListener('keydown', (e) => {
      const last = RADIO_OPTIONS.length - 1;
      let next: number | null = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = i >= last ? 0 : i + 1;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = i <= 0 ? last : i - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = last;
      else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        select(i);
        return;
      }
      if (next === null) return;
      e.preventDefault();
      // radiogroup 規約: 矢印移動はフォーカス移動＝選択
      select(next);
      radios[next].focus();
    });
    radios.push(radio);
    radiogroup.appendChild(radio);
  });
  root.appendChild(radiogroup);
  if (!firstFocusable) firstFocusable = radios[0];

  // ── リング3: アクション toolbar ───────────────────────
  const actions = document.createElement('div');
  actions.className = 'fck-report-actions';
  actions.setAttribute('role', 'toolbar');
  actions.setAttribute('aria-label', '報告の送信・キャンセル');

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'fck-report-submit';
  submitBtn.textContent = '送信';
  submitBtn.tabIndex = 0;

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'fck-report-cancel';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.tabIndex = -1;

  const actionBtns = [submitBtn, cancelBtn];
  actions.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const idx = actionBtns.findIndex((b) => b === document.activeElement);
    if (idx < 0) return;
    e.preventDefault();
    const nextIdx =
      e.key === 'ArrowRight'
        ? (idx + 1) % actionBtns.length
        : (idx - 1 + actionBtns.length) % actionBtns.length;
    actionBtns.forEach((b, i) => (b.tabIndex = i === nextIdx ? 0 : -1));
    actionBtns[nextIdx].focus();
  });

  submitBtn.addEventListener('click', () => {
    if (selected === null) {
      // A-3 補強: 必須未選択は assertive（WCAG 3.3.1 Error Identification）
      announce('種別が選択されていません。いずれかを選んでください', {
        assertive: true,
      });
      radios[0]?.focus();
      return;
    }
    const opt = RADIO_OPTIONS[selected];
    opts.onSubmit(opt.value === '__skip__' ? undefined : opt.value);
  });
  cancelBtn.addEventListener('click', () => opts.onCancel());

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  root.appendChild(actions);

  return {
    element: root,
    focusFirst: () => firstFocusable?.focus(),
  };
}
