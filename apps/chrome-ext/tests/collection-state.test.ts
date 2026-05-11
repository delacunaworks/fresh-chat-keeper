/**
 * collection-state.ts の単体テスト。
 *
 * chrome.storage.local をインメモリの fake で置き換えて CRUD の
 * 期待挙動を固定する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCollectionConsent,
  saveCollectionConsent,
  clearCollectionConsent,
  COLLECTION_CONSENT_KEY,
  type CollectionConsentState,
  __test__,
} from '../src/shared/collection-state.js';

const { isValidConsentState } = __test__;

// ─── chrome.storage.local の fake ────────────────────────────

interface FakeStorage {
  store: Map<string, unknown>;
}

function installFakeChrome(): FakeStorage {
  const store = new Map<string, unknown>();
  const fake = {
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (store.has(k)) out[k] = store.get(k);
          }
          return out;
        },
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) {
            store.set(k, v);
          }
        },
        remove: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) store.delete(k);
        },
      },
    },
  };
  // @types/chrome の型に完全準拠させると runtime/i18n/etc も埋める必要があるが、
  // 本テストは storage.local しか触らないので最小モックに double cast で代入。
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { store };
}

describe('collection-state', () => {
  let fake: FakeStorage;

  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('未保存時は getCollectionConsent が null を返す（デフォルト OFF）', async () => {
    const result = await getCollectionConsent();
    expect(result).toBeNull();
  });

  it('saveCollectionConsent 後は同じ値が読み出せる', async () => {
    const state: CollectionConsentState = {
      optedIn: true,
      consentVersion: '2026-05-01',
      recordedAt: 1714521600000,
    };
    await saveCollectionConsent(state);
    const result = await getCollectionConsent();
    expect(result).toEqual(state);
    // 内部表現も期待どおり
    expect(fake.store.get(COLLECTION_CONSENT_KEY)).toEqual(state);
  });

  it('clearCollectionConsent はストレージから完全削除する（中間状態を保持しない）', async () => {
    const state: CollectionConsentState = {
      optedIn: true,
      consentVersion: '2026-05-01',
      recordedAt: 1,
    };
    await saveCollectionConsent(state);
    expect(fake.store.has(COLLECTION_CONSENT_KEY)).toBe(true);

    await clearCollectionConsent();
    expect(fake.store.has(COLLECTION_CONSENT_KEY)).toBe(false);
    expect(await getCollectionConsent()).toBeNull();
  });

  it('saveCollectionConsent は既存値を上書きする（再同意時の更新）', async () => {
    await saveCollectionConsent({
      optedIn: true,
      consentVersion: '2026-05-01',
      recordedAt: 100,
    });
    await saveCollectionConsent({
      optedIn: true,
      consentVersion: '2026-06-01',
      recordedAt: 200,
    });
    const result = await getCollectionConsent();
    expect(result?.consentVersion).toBe('2026-06-01');
    expect(result?.recordedAt).toBe(200);
  });

  it('壊れた値（手動編集 / 別拡張競合）は null として扱う（fail-closed）', async () => {
    // optedIn: false（中間状態のはずがない）
    fake.store.set(COLLECTION_CONSENT_KEY, { optedIn: false });
    expect(await getCollectionConsent()).toBeNull();

    // 文字列
    fake.store.set(COLLECTION_CONSENT_KEY, 'corrupted');
    expect(await getCollectionConsent()).toBeNull();

    // null
    fake.store.set(COLLECTION_CONSENT_KEY, null);
    expect(await getCollectionConsent()).toBeNull();

    // 一部欠落
    fake.store.set(COLLECTION_CONSENT_KEY, { optedIn: true, consentVersion: 'v1' });
    expect(await getCollectionConsent()).toBeNull();

    // recordedAt が NaN
    fake.store.set(COLLECTION_CONSENT_KEY, {
      optedIn: true,
      consentVersion: 'v1',
      recordedAt: NaN,
    });
    expect(await getCollectionConsent()).toBeNull();
  });
});

describe('isValidConsentState（純粋関数）', () => {
  it('正しい形は true', () => {
    expect(
      isValidConsentState({ optedIn: true, consentVersion: '2026-05-01', recordedAt: 1 }),
    ).toBe(true);
  });

  it('optedIn が false は無効（中間状態を表現しない）', () => {
    expect(
      isValidConsentState({ optedIn: false, consentVersion: '2026-05-01', recordedAt: 1 }),
    ).toBe(false);
  });

  it('consentVersion が空文字は無効', () => {
    expect(
      isValidConsentState({ optedIn: true, consentVersion: '', recordedAt: 1 }),
    ).toBe(false);
  });
});
