/**
 * yt-dlp / ffmpeg の子プロセス薄ラッパ（AR-2・不純）。
 *
 * 単体テストはしない（Tommy の手動オペで実行）。エラーは明確な案内付きで throw する。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

/** yt-dlp バイナリ（PATH → ~/.local/bin → env override）。 */
function ytDlpBin(): string {
  if (process.env.YT_DLP_BIN) return process.env.YT_DLP_BIN;
  const local = join(homedir(), '.local', 'bin', 'yt-dlp');
  if (existsSync(local)) return local;
  return 'yt-dlp';
}

/** コマンドが実行可能かを `--version` で確認。 */
async function commandExists(bin: string, versionFlag = '--version'): Promise<boolean> {
  try {
    await execFileAsync(bin, [versionFlag]);
    return true;
  } catch {
    return false;
  }
}

/** ffmpeg 未導入なら apt install を案内して throw。 */
export async function ensureFfmpeg(): Promise<void> {
  if (!(await commandExists('ffmpeg', '-version'))) {
    throw new Error('ffmpeg が見つかりません。`sudo apt install ffmpeg` で導入してください。');
  }
}

/** yt-dlp 未導入なら案内して throw。 */
export async function ensureYtDlp(): Promise<void> {
  if (!(await commandExists(ytDlpBin()))) {
    throw new Error(
      'yt-dlp が見つかりません。~/.local/bin/yt-dlp に導入するか YT_DLP_BIN を設定してください。',
    );
  }
}

/** yt-dlp で動画長（秒）を取得する（メタデータのみ・ダウンロードなし）。 */
export async function getVideoDurationSeconds(url: string): Promise<number> {
  const { stdout } = await execFileAsync(ytDlpBin(), ['--no-warnings', '--print', 'duration', url]);
  const sec = Number(stdout.trim());
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new Error(`yt-dlp から動画長を取得できませんでした（出力: "${stdout.trim()}"）`);
  }
  return sec;
}

/** yt-dlp で bestaudio をダウンロードして outPath に保存する。 */
export async function downloadAudio(url: string, outPath: string): Promise<void> {
  await execFileAsync(
    ytDlpBin(),
    ['--no-warnings', '-f', 'bestaudio', '-o', outPath, url],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * ffmpeg で音声を chunkSeconds ごとの 16kHz mono wav に分割する。
 * 生成した chunk-000.wav ... を index 昇順のパス配列で返す。
 */
export async function splitIntoChunks(
  audioPath: string,
  chunkSeconds: number,
  outDir: string,
): Promise<string[]> {
  const pattern = join(outDir, 'chunk-%03d.wav');
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    audioPath,
    '-f',
    'segment',
    '-segment_time',
    String(chunkSeconds),
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    pattern,
  ]);
  return readdirSync(outDir)
    .filter((f) => /^chunk-\d+\.wav$/.test(f))
    .sort()
    .map((f) => join(outDir, f));
}
