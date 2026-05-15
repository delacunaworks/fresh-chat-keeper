/**
 * ユーザーブロックの保存スキーマ・キー・正規化（DOM 非依存）。
 *
 * P3-UI-04: content（blocking.ts）と popup（UserBlocklist.tsx）の双方が
 * `fck_user_blocks` を読み書きする。popup に content の DOM ロジックを
 * 巻き込まないよう、型・キー・正規化だけをこの DOM 非依存モジュールに置く。
 *
 * 保存構造は shared `FilterSettings.userBlocks` と同型（将来 B4b/Phase 3.5 で
 * 設定統合する際の移行を容易にするため）。
 */

/** chrome.storage.local キー（CLAUDE.md 命名規則 `fck_<category>`） */
export const USER_BLOCKS_KEY = 'fck_user_blocks';

/** 1 ユーザー分のブロックメタ情報 */
export interface UserBlockMetadata {
  displayNameAtBlock: string;
  blockedAt: number;
  reason?: string;
}

/** `fck_user_blocks` の保存構造 */
export interface UserBlockStore {
  channelIds: string[];
  metadata: Record<string, UserBlockMetadata>;
}

export function emptyUserBlockStore(): UserBlockStore {
  return { channelIds: [], metadata: {} };
}

/**
 * 不正な保存値に強い正規化（型不一致は空構造 / per-entry ドロップで fail-safe）。
 * 別拡張・手動編集・旧バグでの型崩れに耐える。
 */
export function normalizeUserBlockStore(raw: unknown): UserBlockStore {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return emptyUserBlockStore();
  }
  const r = raw as Record<string, unknown>;
  const channelIds = Array.isArray(r.channelIds)
    ? r.channelIds.filter((v): v is string => typeof v === 'string')
    : [];
  const metadata: Record<string, UserBlockMetadata> = {};
  if (
    typeof r.metadata === 'object' &&
    r.metadata !== null &&
    !Array.isArray(r.metadata)
  ) {
    for (const [id, m] of Object.entries(r.metadata as Record<string, unknown>)) {
      if (typeof m !== 'object' || m === null) continue;
      const mm = m as Record<string, unknown>;
      if (
        typeof mm.displayNameAtBlock === 'string' &&
        typeof mm.blockedAt === 'number' &&
        !Number.isNaN(mm.blockedAt)
      ) {
        metadata[id] = {
          displayNameAtBlock: mm.displayNameAtBlock,
          blockedAt: mm.blockedAt,
          ...(typeof mm.reason === 'string' ? { reason: mm.reason } : {}),
        };
      }
    }
  }
  return { channelIds, metadata };
}
