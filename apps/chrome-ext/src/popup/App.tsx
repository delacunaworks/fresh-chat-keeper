import { useEffect, useState, type KeyboardEvent } from 'react';
import {
  DEFAULT_SETTINGS,
  STORAGE_KEY,
  FILTER_COUNT_KEY,
  STAGE2_USAGE_KEY,
  STAGE2_MONTHLY_LIMIT,
  getOrCreateAnonToken,
  type FilterMode,
  type DisplayMode,
  type TriggerVisibility,
  type GameProgress,
  type Settings,
  type Stage2Usage,
  type CustomNGWord,
} from '../shared/settings.js';
import { saveSettings } from '../shared/settings-loader.js';
import {
  getCollectionConsent,
  saveCollectionConsent,
  clearCollectionConsent,
  type CollectionConsentState,
} from '../shared/collection-state.js';
import {
  notifyConsent,
  notifyRevoke,
  ConsentApiError,
  type ConsentRefreshMessage,
} from '../content/collection-client.js';
import { CollectionConsentModal } from './CollectionConsentModal.js';
import { CollectionRevokeConfirmModal } from './CollectionRevokeConfirmModal.js';
import { CategoryFilters } from './tabs/CategoryFilters.js';
import { UserBlocklist } from './tabs/UserBlocklist.js';
import { FirstTimeV3Notice } from './FirstTimeV3Notice.js';
import type { CategorySettings } from '../shared/settings.js';
import type { KBGame } from '@fresh-chat-keeper/knowledge-base';
import { getAllGenreTemplates } from '@fresh-chat-keeper/knowledge-base';
import aceAttorney1 from '@kb-data/ace-attorney-1.json';

const GAMES: KBGame[] = [aceAttorney1 as unknown as KBGame];

// ─── アイコン ──────────────────────────────────────────────────────────

function AppIcon({ size = 20 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width={size} height={size} style={{ flexShrink: 0 }}>
      <rect x="6" y="6" width="116" height="86" rx="20" fill="#10B981" />
      <polygon points="14,88 46,88 10,116" fill="#10B981" />
      <path d="M 64 20 C 62 38 57 43 28 49 C 57 55 62 60 64 78 C 66 60 71 55 100 49 C 71 43 66 38 64 20 Z" fill="white" />
      <path d="M 97 18 C 96.4 22 95.5 23 91 24 C 95.5 25 96.4 26 97 30 C 97.6 26 98.5 25 103 24 C 98.5 23 97.6 22 97 18 Z" fill="white" opacity="0.85" />
    </svg>
  );
}

// ─── 小コンポーネント ─────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      aria-checked={checked}
      role="switch"
      className={`relative w-11 h-6 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-white focus:outline-none ${
        checked ? 'bg-white' : 'bg-indigo-400'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full shadow transition-transform ${
          checked ? 'translate-x-5 bg-indigo-600' : 'translate-x-0 bg-white'
        }`}
      />
    </button>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-gray-100 last:border-b-0">
      <div className="text-xs font-medium text-gray-500 mb-1.5">{label}</div>
      {children}
    </div>
  );
}

// B6a a11y: 単一選択なので aria-pressed のトグル群ではなく
// role="radiogroup" + role="radio"。roving tabindex（選択中のみ Tab 到達）+
// 矢印キー移動＝選択（radiogroup 規約）。WCAG 4.1.2 / 2.1.1。
function SegmentedControl({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
}) {
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = options.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = idx >= last ? 0 : idx + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = idx <= 0 ? last : idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    onChange(options[next].value);
    const btns = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    btns[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="flex rounded-md border border-gray-200 overflow-hidden text-xs"
    >
      {options.map((opt, i) => {
        const checked = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(opt.value)}
            className={`flex-1 py-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 focus:outline-none ${
              i > 0 ? 'border-l border-gray-200' : ''
            } ${
              checked
                ? 'bg-indigo-600 text-white font-medium'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── タブバー（a11y: role=tablist + roving tabindex + 矢印キー）──────────

type TabId = 'basic' | 'category' | 'blocklist';

const TABS: { id: TabId; label: string }[] = [
  { id: 'basic', label: '基本' },
  { id: 'category', label: 'カテゴリ' },
  { id: 'blocklist', label: 'ブロック' },
];

function TabBar({
  active,
  onChange,
}: {
  active: TabId;
  onChange: (id: TabId) => void;
}) {
  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = TABS.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const next = TABS[nextIdx];
    onChange(next.id);
    // roving: 移動先タブへフォーカス
    document.getElementById(`fck-tab-${next.id}`)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="設定カテゴリ"
      className="flex border-b border-gray-200 bg-gray-50"
    >
      {TABS.map((t, i) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            id={`fck-tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={`fck-tabpanel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`flex-1 py-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 focus:outline-none ${
              selected
                ? 'text-indigo-600 border-b-2 border-indigo-600 bg-white'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── カスタムNGワードセクション ────────────────────────────────────────

const CUSTOM_NG_WORD_LIMIT = 200;

function CustomNGWordSection({
  words,
  onChange,
}: {
  words: CustomNGWord[];
  onChange: (words: CustomNGWord[]) => void;
}) {
  const [input, setInput] = useState('');
  const atLimit = words.length >= CUSTOM_NG_WORD_LIMIT;

  const addWord = () => {
    const trimmed = input.trim();
    if (!trimmed || atLimit) return;
    if (words.some((w) => w.word === trimmed)) return;
    onChange([...words, { id: crypto.randomUUID(), word: trimmed, enabled: true }]);
    setInput('');
  };

  const removeWord = (id: string) => onChange(words.filter((w) => w.id !== id));

  const toggleWord = (id: string) =>
    onChange(words.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w)));

  return (
    <div>
      <div className="flex gap-1.5 mb-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addWord()}
          placeholder="フィルタするワードを入力"
          disabled={atLimit}
          className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm bg-white min-w-0 disabled:bg-gray-50 disabled:text-gray-400"
        />
        <button
          onClick={addWord}
          disabled={!input.trim() || atLimit}
          className="px-2.5 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >
          追加
        </button>
      </div>
      <div className={`text-xs mb-1.5 ${atLimit ? 'text-red-500 font-medium' : 'text-gray-400'}`}>
        {atLimit
          ? `上限に達しました（${words.length} / ${CUSTOM_NG_WORD_LIMIT}）`
          : `登録済み: ${words.length} / ${CUSTOM_NG_WORD_LIMIT}`}
      </div>
      {words.length === 0 ? (
        <p className="text-xs text-gray-400">登録済みのワードはありません</p>
      ) : (
        <ul className="space-y-1 max-h-36 overflow-y-auto">
          {words.map((w) => (
            <li
              key={w.id}
              className={`flex items-center gap-1.5 text-xs rounded px-2 py-1 bg-gray-50 ${!w.enabled ? 'opacity-40' : ''}`}
            >
              <span className="flex-1 truncate font-mono">{w.word}</span>
              <button
                onClick={() => toggleWord(w.id)}
                className={`px-1.5 py-0.5 rounded text-xs font-medium border transition-colors ${
                  w.enabled
                    ? 'border-indigo-300 text-indigo-600 bg-indigo-50 hover:bg-indigo-100'
                    : 'border-gray-300 text-gray-400 bg-white hover:bg-gray-100'
                }`}
              >
                {w.enabled ? 'ON' : 'OFF'}
              </button>
              <button
                onClick={() => removeWord(w.id)}
                className="text-gray-400 hover:text-red-500 transition-colors px-1 leading-none"
                aria-label="削除"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── ジャンルテンプレートセクション ────────────────────────────────────

function GenreTemplateSection({
  selectedIds,
  onChange,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const templates = getAllGenreTemplates();
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((i) => i !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div className="space-y-1.5">
      {templates.map((t) => (
        <label key={t.id} className="flex items-start gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={selectedIds.includes(t.id)}
            onChange={() => toggle(t.id)}
            className="rounded border-gray-300 text-indigo-600 mt-0.5 shrink-0"
          />
          <div className="min-w-0">
            <span className="font-medium">{t.name}</span>
            <span className="text-xs text-gray-400 ml-1.5">{t.description}</span>
          </div>
        </label>
      ))}
    </div>
  );
}

// ─── 進行状況セレクター ────────────────────────────────────────────────

function ProgressSettings({
  game,
  progress,
  onChange,
}: {
  game: KBGame;
  progress: GameProgress;
  onChange: (p: GameProgress) => void;
}) {
  if (game.progress_type === 'chapter') {
    const chapters = game.chapters ?? [];
    return (
      <>
        <select
          className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm bg-white"
          value={progress.currentChapterId ?? ''}
          onChange={(e) =>
            onChange({ ...progress, progressModel: 'chapter', currentChapterId: e.target.value })
          }
        >
          <option value="">-- 視聴中のチャプターを選択 --</option>
          {chapters.map((ch) => (
            <option key={ch.id} value={ch.id}>
              {ch.title}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-400 mt-1.5">
          いま視聴中のチャプターを選んでください。そのチャプター内のネタバレも自動でブロックされます。
        </p>
      </>
    );
  }

  // event モデル
  const events = game.events ?? [];
  const completed = new Set(progress.completedEventIds ?? []);
  const toggleEvent = (id: string) => {
    const next = new Set(completed);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange({ ...progress, progressModel: 'event', completedEventIds: [...next] });
  };

  return (
    <div className="space-y-1 max-h-36 overflow-y-auto">
      {events.map((ev) => (
        <label key={ev.id} className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={completed.has(ev.id)}
            onChange={() => toggleEvent(ev.id)}
            className="rounded border-gray-300 text-indigo-600"
          />
          <span>{ev.title}</span>
        </label>
      ))}
    </div>
  );
}

// ─── データ収集セクション（Phase 2.5、opt-in） ────────────────────────

/**
 * データ収集 opt-in トグル + revoke UI。
 *
 * **プライバシー UX 要件**:
 * - スイッチを ON にした瞬間にモーダル表示。モーダル承諾完了で初めて実反映
 * - OFF にする前に確認ダイアログ。確認後 revoke API を呼ぶ
 * - 同意中は consentVersion / 同意日時を表示
 *
 * 設定パネル本体（既存セクション群）の **下** に配置することで、
 * 能動的に探した人だけが ON にする UX を実現する。
 */
function CollectionSection({
  apiUrl,
}: {
  apiUrl: string;
}) {
  const [consent, setConsent] = useState<CollectionConsentState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 起動時に opt-in 状態を読み込む
  useEffect(() => {
    void getCollectionConsent().then((state) => {
      setConsent(state);
      setLoaded(true);
    });
  }, []);

  // chrome.storage.onChanged で opt-in 状態の変化に追従（content script 側
  // からの変更や別タブでの変更を popup に反映）
  useEffect(() => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (!changes['fck_collection_consent']) return;
      const next = changes['fck_collection_consent'].newValue as CollectionConsentState | undefined;
      setConsent(next ?? null);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // chrome.runtime.onMessage で content script からの通知を受信。
  // IngestClient が 410 (consent_version_mismatch) を受け取ると本通知を発火するため、
  // popup を開いている間に再同意モーダルを自動で表示する（Phase 2.5 B5 / C-1）。
  useEffect(() => {
    const listener = (msg: unknown): void => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as Partial<ConsentRefreshMessage>;
      if (m.type !== 'fck:consent-refresh-required') return;
      // 表示のみ更新。consent state はサーバー側で revoked 扱いではないので
      // クライアント側で勝手に消さず、ユーザーに再同意 UI を見せる。
      setErrorMessage(
        'サーバーで同意ポリシーが更新されました。再度同意してください。',
      );
      setModalOpen(true);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const optedIn = consent !== null;

  const onToggle = (next: boolean) => {
    if (next) {
      // OFF → ON: モーダル表示。実反映はモーダル承諾完了で行う
      setErrorMessage(null);
      setModalOpen(true);
    } else {
      // ON → OFF: 確認モーダル表示（window.confirm は a11y / focus を破壊するため
      // CollectionRevokeConfirmModal に置き換え、B5 review C-4）
      setRevokeConfirmOpen(true);
    }
  };

  const handleRevokeConfirm = async (): Promise<void> => {
    setRevokeConfirmOpen(false);
    await handleRevoke();
  };

  const handleConsent = async (consentVersion: string) => {
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = await getOrCreateAnonToken();
      await notifyConsent({ apiUrl, token }, consentVersion);
      const state: CollectionConsentState = {
        optedIn: true,
        consentVersion,
        recordedAt: Date.now(),
      };
      await saveCollectionConsent(state);
      setConsent(state);
      setModalOpen(false);
    } catch (err) {
      if (err instanceof ConsentApiError && err.status === 422) {
        setErrorMessage(
          'ポリシーバージョンが古い可能性があります。拡張を最新版に更新してから再度お試しください。',
        );
      } else if (err instanceof ConsentApiError) {
        setErrorMessage(`サーバーエラー (HTTP ${err.status})。時間を置いて再度お試しください。`);
      } else {
        setErrorMessage('ネットワークエラーが発生しました。接続を確認してから再度お試しください。');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    setModalOpen(false);
    setErrorMessage(null);
  };

  const handleRevoke = async () => {
    setRevoking(true);
    try {
      const token = await getOrCreateAnonToken();
      const result = await notifyRevoke({ apiUrl, token });
      await clearCollectionConsent();
      setConsent(null);
      const count = result.deletedLogCount ?? 0;
      setToast(
        count > 0
          ? `データ収集を停止しました（${count} 件のログを削除）`
          : 'データ収集を停止しました',
      );
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      // revoke 失敗時はローカル状態だけクリア（サーバー側は次回 retention で削除される）
      // → ユーザーから見て「OFF にできた」状態にする方がプライバシー優位
      await clearCollectionConsent();
      setConsent(null);
      const msg =
        err instanceof Error ? err.message : String(err);
      setToast(`データ削除のサーバー通知に失敗（ローカルは停止済み）: ${msg}`);
      setTimeout(() => setToast(null), 5000);
    } finally {
      setRevoking(false);
    }
  };

  if (!loaded) return null;

  return (
    <Section label="データ収集（任意）">
      <div className="flex items-center justify-between">
        <div className="flex-1 pr-2">
          <div className="text-xs text-gray-700">
            ネタバレ判定の改善に協力する
          </div>
          <p className="text-[10px] text-gray-400 mt-0.5 leading-snug">
            匿名化したログを送信します。デフォルトはオフです。
          </p>
        </div>
        <button
          onClick={() => onToggle(!optedIn)}
          aria-checked={optedIn}
          aria-label="データ収集に協力"
          role="switch"
          disabled={submitting || revoking}
          className={`relative w-11 h-6 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500 focus:outline-none ${
            // 未 opt-in 時は bg-gray-300（WCAG 1.4.11 で 3:1 を満たすコントラスト）
            optedIn ? 'bg-indigo-600' : 'bg-gray-300'
          } ${submitting || revoking ? 'opacity-50 cursor-wait' : ''}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full shadow transition-transform bg-white ${
              optedIn ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {optedIn && consent && (
        <div className="mt-2 text-[10px] text-gray-500 leading-snug space-y-0.5">
          <div>同意バージョン: {consent.consentVersion}</div>
          <div>
            同意日時: {new Date(consent.recordedAt).toLocaleString('ja-JP', { hour12: false })}
          </div>
          <button
            onClick={() => setRevokeConfirmOpen(true)}
            disabled={revoking}
            className="mt-1 text-rose-600 underline disabled:text-gray-500 rounded focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-1 focus:outline-none"
          >
            {revoking ? '削除中...' : 'データ削除を申請'}
          </button>
        </div>
      )}

      {toast && (
        <div className="mt-2 text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
          {toast}
        </div>
      )}

      <CollectionConsentModal
        open={modalOpen}
        submitting={submitting}
        errorMessage={errorMessage}
        onConsent={handleConsent}
        onCancel={handleCancel}
      />

      <CollectionRevokeConfirmModal
        open={revokeConfirmOpen}
        submitting={revoking}
        onConfirm={handleRevokeConfirm}
        onCancel={() => setRevokeConfirmOpen(false)}
      />
    </Section>
  );
}

// ─── メインApp ────────────────────────────────────────────────────────

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [filterCount, setFilterCount] = useState(0);
  const [stage2Count, setStage2Count] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // 起動時に設定・フィルタカウント・Stage 2 利用量を読み込む
  useEffect(() => {
    chrome.storage.local.get([STORAGE_KEY, FILTER_COUNT_KEY, STAGE2_USAGE_KEY], (result) => {
      setSettings({ ...DEFAULT_SETTINGS, ...(result[STORAGE_KEY] as Partial<Settings>) });
      setFilterCount((result[FILTER_COUNT_KEY] as number | undefined) ?? 0);
      const usage = result[STAGE2_USAGE_KEY] as Stage2Usage | undefined;
      const currentMonth = new Date().toISOString().slice(0, 7);
      setStage2Count(usage?.month === currentMonth ? (usage.messageCount ?? 0) : 0);
      setLoaded(true);
    });
  }, []);

  // ポップアップが開いている間も変化を反映する
  useEffect(() => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes[FILTER_COUNT_KEY]) {
        setFilterCount((changes[FILTER_COUNT_KEY].newValue as number | undefined) ?? 0);
      }
      if (changes[STAGE2_USAGE_KEY]) {
        const usage = changes[STAGE2_USAGE_KEY].newValue as Stage2Usage | undefined;
        const currentMonth = new Date().toISOString().slice(0, 7);
        setStage2Count(usage?.month === currentMonth ? (usage.messageCount ?? 0) : 0);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const update = (partial: Partial<Settings>) => {
    const next = { ...settings, ...partial };
    setSettings(next);
    // saveSettings が最新世代 version (v3) を確実に付与する（直接 set すると剥がれる）
    void saveSettings(next);
  };

  const activeGame = GAMES.find((g) => g.id === settings.gameId) ?? GAMES[0];
  const activeProgress: GameProgress = settings.progressByGame[settings.gameId] ?? {
    progressModel: activeGame.progress_type,
  };

  const [activeTab, setActiveTab] = useState<TabId>('basic');

  // 旧ユーザーの保存値に categories が無い場合は全 OFF デフォルトで補完
  const categories: CategorySettings = settings.categories ?? {
    harassment: { enabled: false, strength: 'standard' },
    spam: { enabled: false },
    offTopic: { enabled: false, strength: 'standard' },
    backseat: { enabled: false, strength: 'standard' },
  };

  if (!loaded) {
    return <div className="p-4 text-sm text-gray-400">読み込み中...</div>;
  }

  return (
    <div className="w-[300px] text-sm font-sans bg-white select-none">
      {/* ヘッダー */}
      <div className="flex items-center justify-between px-4 py-3 bg-indigo-600 text-white">
        <div>
          <div className="flex items-center gap-2 font-semibold text-base leading-tight">
            <AppIcon size={22} />
            Fresh Chat Keeper
          </div>
          <div className="text-xs text-indigo-200 mt-1">
            {filterCount}件のコメントをフィルタしました
          </div>
          <div className={`text-xs mt-0.5 ${stage2Count >= STAGE2_MONTHLY_LIMIT ? 'text-red-300' : 'text-indigo-300'}`}>
            今月のフィルタ判定件数: {stage2Count} / {STAGE2_MONTHLY_LIMIT}件
            {stage2Count >= STAGE2_MONTHLY_LIMIT && ' (上限到達)'}
          </div>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <Toggle checked={settings.enabled} onChange={(v) => update({ enabled: v })} />
          <span className="text-xs text-indigo-200">{settings.enabled ? 'ON' : 'OFF'}</span>
        </div>
      </div>

      <FirstTimeV3Notice onGoToCategory={() => setActiveTab('category')} />

      <TabBar active={activeTab} onChange={setActiveTab} />

      {activeTab === 'category' && (
        <div id="fck-tabpanel-category" role="tabpanel" aria-labelledby="fck-tab-category">
          <CategoryFilters
            categories={categories}
            onChange={(next) => update({ categories: next })}
          />
        </div>
      )}

      {activeTab === 'blocklist' && (
        <div id="fck-tabpanel-blocklist" role="tabpanel" aria-labelledby="fck-tab-blocklist">
          <UserBlocklist />
        </div>
      )}

      <div
        id="fck-tabpanel-basic"
        role="tabpanel"
        aria-labelledby="fck-tab-basic"
        hidden={activeTab !== 'basic'}
      >
      {/* 設定パネル（無効時は薄く表示） */}
      <div className={settings.enabled ? '' : 'opacity-40 pointer-events-none'}>
        {/* ゲーム選択 */}
        <Section label="ゲーム">
          <select
            className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm bg-white"
            value={settings.gameId}
            onChange={(e) => update({ gameId: e.target.value })}
          >
            <option value="none">ゲームを選択しない</option>
            <option value="other">その他のゲーム</option>
            <optgroup label="─── 対応済みタイトル ───">
              {GAMES.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </optgroup>
          </select>
          {settings.gameId === 'other' && (
            <p className="text-xs text-indigo-500 mt-1.5">
              動画タイトルからゲームを自動推測します
            </p>
          )}
        </Section>

        {/* 進行状況（ゲームKB選択時のみ表示） */}
        {settings.gameId !== 'none' && settings.gameId !== 'other' && (
          <Section label="進行状況">
            <ProgressSettings
              game={activeGame}
              progress={activeProgress}
              onChange={(p) =>
                update({
                  progressByGame: { ...settings.progressByGame, [settings.gameId]: p },
                })
              }
            />
          </Section>
        )}

        {/* カスタムNGワード */}
        <Section label="カスタムNGワード">
          <CustomNGWordSection
            words={settings.customNgWords ?? []}
            onChange={(words) => update({ customNgWords: words })}
          />
        </Section>

        {/* ジャンル別テンプレート */}
        <Section label="ジャンル別テンプレート">
          {settings.gameId === 'other' && (settings.selectedGenreTemplates ?? []).length === 0 && (
            <p className="text-xs text-indigo-500 mb-2">
              ジャンルを選択するとフィルタ精度が上がります
            </p>
          )}
          <GenreTemplateSection
            selectedIds={settings.selectedGenreTemplates ?? []}
            onChange={(ids) => update({ selectedGenreTemplates: ids })}
          />
        </Section>

        {/* フィルタ強度 */}
        <Section label="フィルタ強度">
          <SegmentedControl
            options={[
              { value: 'strict', label: '厳格' },
              { value: 'standard', label: '標準' },
              { value: 'lenient', label: '緩め' },
            ]}
            value={settings.filterMode}
            onChange={(v) => update({ filterMode: v as FilterMode })}
            ariaLabel="フィルタ強度"
          />
          <p className="text-xs text-gray-400 mt-1.5">
            {settings.filterMode === 'strict' && 'ネタバレ・匂わせ・攻略ヒントをすべてブロック'}
            {settings.filterMode === 'standard' && 'ネタバレ・匂わせをブロック（デフォルト）'}
            {settings.filterMode === 'lenient' && '明示的なネタバレのみブロック'}
          </p>
        </Section>

        {/* 表示方式 */}
        <Section label="表示方式">
          <SegmentedControl
            options={[
              { value: 'placeholder', label: 'プレースホルダー' },
              { value: 'hidden', label: '非表示' },
            ]}
            value={settings.displayMode}
            onChange={(v) => update({ displayMode: v as DisplayMode })}
            ariaLabel="表示方式"
          />
          <p className="text-xs text-gray-400 mt-1.5">
            {settings.displayMode === 'placeholder'
              ? '「⚠ フィルタされました」に書き換え（クリックで表示）'
              : '完全に非表示（Flow Chat等の他拡張には効かない場合あり）'}
          </p>
        </Section>

        {/* 行内トリガ（ブロック/報告アイコン）の表示（B5-fix） */}
        <Section label="ブロック/報告アイコン">
          <SegmentedControl
            options={[
              { value: 'hover_only', label: 'ホバー時のみ' },
              { value: 'always', label: '常に薄く表示' },
            ]}
            value={settings.triggerVisibility ?? 'hover_only'}
            onChange={(v) =>
              update({ triggerVisibility: v as TriggerVisibility })
            }
            ariaLabel="ブロック/報告アイコンの表示"
          />
          <p className="text-xs text-gray-400 mt-1.5">
            {(settings.triggerVisibility ?? 'hover_only') === 'hover_only'
              ? 'コメントにマウスを乗せた時だけ ⋯ を表示（既定）'
              : '常に薄く ⋯ を表示し、ホバーで濃くなる'}
          </p>
        </Section>
      </div>

      {/*
        Phase 2.5 データ収集 opt-in セクション。
        既存設定パネルの下（フェード対象外）に置くことで、
        - 拡張全体オフでも UI 操作可能（OFF にする道を残す）
        - 能動的に探した人だけが ON にする UX を実現
      */}
      <CollectionSection apiUrl={settings.collectionApiUrl} />
      </div>

    </div>
  );
}
