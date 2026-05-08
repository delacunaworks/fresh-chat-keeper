/**
 * Phase 2.5 データ収集 opt-in 状態の永続化。
 *
 * 設計 ground truth: dev-docs/phase-2-5-data-collection.md §6
 *
 * **プライバシー設計の必達条件**:
 * - デフォルト OFF（getCollectionConsent が null を返す = 未 opt-in）
 * - 取り消しの即時性（clearCollectionConsent はストレージから完全削除、
 *   次回起動時の復元なし）
 * - chrome.storage.local キー命名規則（CLAUDE.md §内部識別子）に準拠:
 *   `fck_collection_consent`
 */

/**
 * オプトイン状態。
 *
 * 同意していないユーザーはこの値が chrome.storage に存在しない（null）。
 * 取り消したユーザーも `clearCollectionConsent` で完全に削除されるため、
 * 「同意していたが取り消した」という中間状態は **保持しない**（B3 の API 側
 * `consent_records.revoked_at` がその記録を保持する）。
 */
export interface CollectionConsentState {
  /** 必ず true（false の状態は保存しない、ストレージから削除して表現する） */
  optedIn: true;
  /** 同意したポリシーバージョン（例: "2026-05-01"） */
  consentVersion: string;
  /** 同意した時刻（Unix ms） */
  recordedAt: number;
}

export const COLLECTION_CONSENT_KEY = 'fck_collection_consent';

/**
 * 現在の opt-in 状態を取得。
 *
 * @returns 同意済みなら state、未同意 / 取り消し済みなら null
 */
export async function getCollectionConsent(): Promise<CollectionConsentState | null> {
  const result = await chrome.storage.local.get(COLLECTION_CONSENT_KEY);
  const raw = result[COLLECTION_CONSENT_KEY];
  if (!isValidConsentState(raw)) return null;
  return raw;
}

/**
 * opt-in 状態を保存。
 * 既存値があれば上書きする（再同意時に最新の consentVersion / recordedAt に更新）。
 */
export async function saveCollectionConsent(
  state: CollectionConsentState,
): Promise<void> {
  await chrome.storage.local.set({ [COLLECTION_CONSENT_KEY]: state });
}

/**
 * opt-in 状態を完全に削除。
 *
 * 「OFF にしたが復元できる中間状態」を作らないため、`{ optedIn: false }` を
 * 保存するのではなく chrome.storage から削除する。これにより
 * `getCollectionConsent()` が null を返し、ingest クライアントが即座に停止する。
 */
export async function clearCollectionConsent(): Promise<void> {
  await chrome.storage.local.remove(COLLECTION_CONSENT_KEY);
}

/**
 * chrome.storage に保存された値が CollectionConsentState の形に一致するか確認。
 *
 * 過去のストレージ汚染や手動編集に対する防御。一つでも欠けていたら null 扱い
 * （未同意）に倒すことで「同意状態が壊れていたら fail-closed」を保証する。
 *
 * collection-emit からも import して使う（B5 で重複定義を一本化）。
 */
export function isValidConsentState(raw: unknown): raw is CollectionConsentState {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    r.optedIn === true &&
    typeof r.consentVersion === 'string' &&
    r.consentVersion.length > 0 &&
    typeof r.recordedAt === 'number' &&
    Number.isFinite(r.recordedAt)
  );
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = { isValidConsentState };
