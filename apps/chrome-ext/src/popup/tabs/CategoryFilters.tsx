/**
 * 「カテゴリ」タブ（P3-UI-04）。
 *
 * Phase 3 マルチラベルの新カテゴリ（暴言 / スパム / 無関係 / 指示厨）の
 * ON/OFF + 強度を制御する。spoiler は従来どおり「基本」タブの
 * フィルタ強度で設定するため、ここには出さず注記で誘導する
 * （既存ユーザーの設定移行不要・UX 混乱回避。settings.ts の設計判断参照）。
 *
 * 設計方針: 新カテゴリはすべてデフォルト OFF（phase-3-multilabel.md リスク6）。
 * a11y（architecture.md §2.1.4.1）: Toggle は role=switch + focus-visible、
 * 強度は SegmentedControl（focus-visible ring）。タブ自体の roving は App.tsx 側。
 */

import type {
  CategorySettings,
  CategoryStrength,
} from '../../shared/settings.js';

interface CategoryFiltersProps {
  categories: CategorySettings;
  onChange: (next: CategorySettings) => void;
}

// B6a UI: 基本タブ（ネタバレ強度）の表示順「厳格(左) / 標準 / 緩め(右)」に
// 統一する。保存される値（CategoryStrength: 'loose'|'standard'|'strict'）と
// マッピングは不変、UI の並び順のみ。既存設定の互換に影響なし。
const STRENGTH_OPTIONS: { value: CategoryStrength; label: string }[] = [
  { value: 'strict', label: '厳格' },
  { value: 'standard', label: '標準' },
  { value: 'loose', label: '緩め' },
];

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-checked={checked}
      role="switch"
      aria-label={label}
      className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-indigo-500 focus:outline-none ${
        checked ? 'bg-indigo-600' : 'bg-gray-300'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function StrengthControl({
  value,
  onChange,
  groupLabel,
}: {
  value: CategoryStrength;
  onChange: (v: CategoryStrength) => void;
  groupLabel: string;
}) {
  return (
    <div
      className="flex rounded-md border border-gray-200 overflow-hidden text-xs mt-1.5"
      role="group"
      aria-label={`${groupLabel}の強度`}
    >
      {STRENGTH_OPTIONS.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex-1 py-1 transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 focus:outline-none ${
            i > 0 ? 'border-l border-gray-200' : ''
          } ${
            value === opt.value
              ? 'bg-indigo-600 text-white font-medium'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function CategoryRow({
  title,
  description,
  enabled,
  onToggle,
  strength,
  onStrengthChange,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  strength?: CategoryStrength;
  onStrengthChange?: (v: CategoryStrength) => void;
}) {
  return (
    <div className="px-4 py-3 border-b border-gray-100 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm text-gray-800">{title}</div>
          <div className="text-[11px] text-gray-400 leading-snug">{description}</div>
        </div>
        <Toggle checked={enabled} onChange={onToggle} label={`${title}フィルタ`} />
      </div>
      {enabled && strength !== undefined && onStrengthChange && (
        <StrengthControl value={strength} onChange={onStrengthChange} groupLabel={title} />
      )}
    </div>
  );
}

export function CategoryFilters({ categories, onChange }: CategoryFiltersProps) {
  const set = <K extends keyof CategorySettings>(
    key: K,
    partial: Partial<CategorySettings[K]>,
  ) => {
    onChange({
      ...categories,
      [key]: { ...categories[key], ...partial },
    });
  };

  return (
    <div>
      <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 text-[11px] text-amber-700 leading-snug">
        💡 これらの機能は初期状態では OFF です。必要なものだけ ON にしてください。
        <br />
        ネタバレフィルタは「基本」タブのフィルタ強度で設定します。
      </div>

      <CategoryRow
        title="暴言・誹謗中傷"
        description="配信者・他視聴者への攻撃的コメント"
        enabled={categories.harassment.enabled}
        onToggle={(v) => set('harassment', { enabled: v })}
        strength={categories.harassment.strength}
        onStrengthChange={(s) => set('harassment', { strength: s })}
      />
      <CategoryRow
        title="スパム・連投"
        description="連投・コピペ・文字/絵文字連打・URL羅列（強度設定なし）"
        enabled={categories.spam.enabled}
        onToggle={(v) => set('spam', { enabled: v })}
      />
      <CategoryRow
        title="無関係・他配信者"
        description="配信内容と無関係な話題、他配信者への言及"
        enabled={categories.offTopic.enabled}
        onToggle={(v) => set('offTopic', { enabled: v })}
        strength={categories.offTopic.strength}
        onStrengthChange={(s) => set('offTopic', { strength: s })}
      />
      <CategoryRow
        title="指示厨・攻略押付"
        description="頼まれていない攻略指示・プレイ批判"
        enabled={categories.backseat.enabled}
        onToggle={(v) => set('backseat', { enabled: v })}
        strength={categories.backseat.strength}
        onStrengthChange={(s) => set('backseat', { strength: s })}
      />
    </div>
  );
}
