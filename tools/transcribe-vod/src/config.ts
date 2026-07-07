/**
 * .env の読み込み（AR-2）。dotenv 依存を避けた最小パーサ + 必須値の解決。
 */

/** .env テキストを KEY=VALUE の Record にパースする（純ロジック）。 */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 前後のクォートを剥がす（"..." / '...'）。
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 解決済みの実行設定。 */
export interface ResolvedConfig {
  elevenLabsApiKey: string;
  adminIngestToken: string;
  apiBase: string;
}

/**
 * env マップ（+ CLI の --api 上書き）から設定を解決する（純ロジック）。
 * 必須値が欠けていれば理由付きで throw する。
 */
export function resolveConfig(
  env: Record<string, string | undefined>,
  apiOverride?: string,
): ResolvedConfig {
  const elevenLabsApiKey = (env.ELEVENLABS_API_KEY ?? '').trim();
  const adminIngestToken = (env.ADMIN_INGEST_TOKEN ?? '').trim();
  const apiBase = (apiOverride ?? env.FCK_API_BASE ?? '').trim().replace(/\/+$/, '');

  const missing: string[] = [];
  if (!elevenLabsApiKey) missing.push('ELEVENLABS_API_KEY');
  if (!adminIngestToken) missing.push('ADMIN_INGEST_TOKEN');
  if (!apiBase) missing.push('FCK_API_BASE (or --api)');
  if (missing.length > 0) {
    throw new Error(`設定不足: ${missing.join(', ')} を .env に記入してください（.env.example 参照）`);
  }
  return { elevenLabsApiKey, adminIngestToken, apiBase };
}
