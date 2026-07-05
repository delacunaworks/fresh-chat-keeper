/**
 * CLI 引数パース（AR-2・純ロジック）。
 *
 * 使い方: transcribe-vod <YouTube URL> [--dry-run] [--yes] [--api <base>]
 */

export interface CliArgs {
  /** 位置引数（YouTube URL または ID）。未指定なら null。 */
  url: string | null;
  /** 外部呼び出しをせず計画・見積りだけ表示。 */
  dryRun: boolean;
  /** コスト確認プロンプトをスキップ。 */
  yes: boolean;
  /** apps/api ベース URL の上書き（--api）。未指定なら undefined。 */
  apiBase?: string;
  /**
   * 動画長（秒）の明示指定（--duration）。--dry-run は yt-dlp を呼ばないため
   * これでチャンク計画・見積りを計算する。通常実行では yt-dlp の値を上書きする。
   */
  duration?: number;
}

/** argv（node/tsx の実行ファイルを除いた分）をパースする。 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { url: null, dryRun: false, yes: false };
  const takeValue = (inline: string | undefined, next: string | undefined): string | undefined =>
    inline !== undefined ? inline : next;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--api' || a.startsWith('--api=')) {
      const inline = a.startsWith('--api=') ? a.slice('--api='.length) : undefined;
      args.apiBase = takeValue(inline, argv[i + 1]);
      if (inline === undefined) i++;
    } else if (a === '--duration' || a.startsWith('--duration=')) {
      const inline = a.startsWith('--duration=') ? a.slice('--duration='.length) : undefined;
      const raw = takeValue(inline, argv[i + 1]);
      if (inline === undefined) i++;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) args.duration = n;
    } else if (!a.startsWith('-') && args.url === null) {
      args.url = a;
    }
  }
  return args;
}
