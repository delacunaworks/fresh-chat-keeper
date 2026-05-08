/**
 * SHA-1 ベースのハッシュ実装。
 *
 * VTuber 1B (sigvt/holodata) の vtlc/postprocess.py と等価:
 *
 *   ANONYMIZATION_SALT = os.environ['ANONYMIZATION_SALT']
 *   def anonymize(s):
 *       return hashlib.sha1((s + ANONYMIZATION_SALT).encode()).hexdigest()
 *
 * ⇒ TS 実装: SHA-1((input + salt).encode("utf-8")) を hex で出力。
 *
 * salt は Cloudflare Workers の secret（env.COLLECTION_SALT）として保管し、
 * **絶対にレスポンス・ログ・エラーメッセージに含めない**。
 *
 * 設計 ground truth: dev-docs/phase-2-5-data-collection.md §2.6
 */

/**
 * salt の最小許容長。VTuber 1B は具体長を公開していないが、SHA-1 の出力空間
 * 160bit に対して salt が短いと逆引きの計算量が下がる。Phase 2.5 では運用
 * ミスとして「16 文字未満 / 空文字 / 空白のみ」を弾くポリシー。
 */
const MIN_SALT_LENGTH = 16;

/**
 * COLLECTION_SALT の妥当性をチェックする。
 *
 * 不正なら **値そのものは含めず** 例外を投げる。これは secret 漏洩リスクを
 * 避けるため（エラーメッセージや stack trace に salt 値を載せない）。
 *
 * 呼び出し側（ingest / revoke ハンドラ）はこれを catch して 500 を返す。
 */
export function assertValidSalt(salt: string | undefined | null): asserts salt is string {
  if (typeof salt !== 'string' || salt.trim().length < MIN_SALT_LENGTH) {
    // 値そのものはログに出さない。長さ情報のみ（≒未設定 vs 短すぎ の判別用）。
    const lenInfo = typeof salt === 'string' ? `length=${salt.length}` : 'undefined';
    throw new Error(
      `[fck-api] COLLECTION_SALT is missing or too short (${lenInfo}). ` +
        `Minimum ${MIN_SALT_LENGTH} characters required.`,
    );
  }
}

/**
 * authorChannelId をハッシュ化。
 *
 * 仕様（VTuber 1B 互換）:
 * - 入力: `<authorChannelId> + <salt>` を UTF-8 で encode
 * - SHA-1 ダイジェストを 40 桁の小文字 hex で返す
 *
 * @param authorChannelId 平文の YouTube channel ID
 * @param salt サーバー側 secret（COLLECTION_SALT）
 * @returns 40 桁の hex 文字列
 */
export async function hashAuthorChannelId(
  authorChannelId: string,
  salt: string,
): Promise<string> {
  return sha1Hex(authorChannelId + salt);
}

/**
 * x-fck-token（匿名トークン UUID）をハッシュ化して D1 に保存する。
 *
 * authorChannelId と同じ salt + アルゴリズムを使う。これは「同一ユーザー」を
 * 同一 hash で復元できるようにするため（revoke 時に user_token_hashed で
 * judgment_logs を bulk delete する）。
 *
 * salt 値の漏洩リスクは authorChannelId と同等であり、salt の機密性は同じ
 * 安全管理措置でカバーされる。
 */
export async function hashUserToken(
  token: string,
  salt: string,
): Promise<string> {
  return sha1Hex(token + salt);
}

/**
 * 共通 SHA-1 → hex 実装。
 *
 * 引数を直接ログに出さないこと（呼び出し側で `input + salt` の連結後の文字列が
 * 渡るため、平文の channel id や token を含む）。
 */
async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const bytes = new Uint8Array(hashBuffer);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

// ─── テスト用エクスポート ─────────────────────────────────────

export const __test__ = { sha1Hex, MIN_SALT_LENGTH };
