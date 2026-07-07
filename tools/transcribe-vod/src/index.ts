#!/usr/bin/env -S npx tsx
/**
 * transcribe-vod（AR-2）: アーカイブ VOD を yt-dlp → Scribe v2 で転写し、AR-1 の
 * transcript endpoint に投入する運営用 CLI。Tommy がローカル（WSL2）で手動実行する。
 *
 * 使い方:
 *   pnpm --filter @fresh-chat-keeper/transcribe-vod transcribe <URL> [--dry-run] [--yes] [--api <base>] [--duration <秒>]
 *
 * フロー: 引数 → .env → 動画長 → 10分チャンク計画 → コスト確認 → 音声DL → ffmpeg分割 →
 *   未転写チャンクのみ Scribe（レジューム）→ word→segment 整形 → transcript endpoint へ POST。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { transcribe } from '@fresh-chat-keeper/api/lib/scribe';
import { parseArgs } from './args.js';
import { parseEnv, resolveConfig } from './config.js';
import { extractVideoId } from './video-id.js';
import { planChunks, CHUNK_SECONDS } from './plan.js';
import { renderPlanSummary } from './render.js';
import { buildSegmentsForChunk, type Segment } from './segments.js';
import { chunkCacheFileName, parseCachedChunkIndices, chunksNeedingTranscription } from './resume.js';
import { postTranscript } from './ingest.js';
import {
  ensureFfmpeg,
  ensureYtDlp,
  getVideoDurationSeconds,
  downloadAudio,
  splitIntoChunks,
} from './exec.js';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function usage(): void {
  console.error(
    'usage: transcribe-vod <YouTube URL|ID> [--dry-run] [--yes] [--api <base>] [--duration <秒>]',
  );
}

/** package ルートの .env を読む（無ければ空）。 */
function loadDotEnv(): Record<string, string> {
  const p = join(PACKAGE_DIR, '.env');
  return existsSync(p) ? parseEnv(readFileSync(p, 'utf8')) : {};
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(question)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    usage();
    process.exitCode = 1;
    return;
  }
  const videoId = extractVideoId(args.url);
  if (!videoId) {
    console.error(`videoId を抽出できませんでした: ${args.url}`);
    process.exitCode = 1;
    return;
  }

  // ── --dry-run: 外部呼び出しゼロ（yt-dlp/Scribe/POST なし）─────────
  if (args.dryRun) {
    if (args.duration === undefined) {
      console.error('--dry-run は動画長不明のため --duration <秒> を指定してください。');
      process.exitCode = 1;
      return;
    }
    console.log(renderPlanSummary({ videoId, durationSeconds: args.duration }));
    console.log('(--dry-run: yt-dlp / Scribe / POST は呼びません)');
    return;
  }

  // ── 実行: 設定解決 + 前提コマンド確認 ──────────────────────────
  const config = resolveConfig({ ...process.env, ...loadDotEnv() }, args.apiBase);
  await ensureYtDlp();
  await ensureFfmpeg();

  const duration = args.duration ?? (await getVideoDurationSeconds(args.url));
  const chunks = planChunks(duration);
  console.log(renderPlanSummary({ videoId, durationSeconds: duration, chunks }));

  if (!args.yes) {
    const ok = await confirm('この見積りで転写を実行しますか？ [y/N] ');
    if (!ok) {
      console.log('中止しました。');
      return;
    }
  }

  // ── 作業ディレクトリ（音声・チャンク・転写キャッシュ）────────────
  const workDir = join(PACKAGE_DIR, '.transcribe-work', videoId);
  const chunksDir = join(workDir, 'chunks');
  const cacheDir = join(workDir, 'cache');
  mkdirSync(chunksDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  // 音声取得 + 分割（既にチャンクがあればレジュームでスキップ）。
  let chunkFiles = listChunkFiles(chunksDir);
  if (chunkFiles.length === 0) {
    console.log('音声を取得中（yt-dlp bestaudio）...');
    const audioPath = join(workDir, 'audio.bestaudio');
    await downloadAudio(args.url, audioPath);
    console.log('10 分チャンクに分割中（ffmpeg）...');
    chunkFiles = await splitIntoChunks(audioPath, CHUNK_SECONDS, chunksDir);
  }

  // レジューム: 既に転写済みのチャンクを除いて Scribe を呼ぶ。
  const cached = parseCachedChunkIndices(readdirSync(cacheDir));
  const todo = chunksNeedingTranscription(chunks, cached);
  console.log(`転写対象: ${todo.length}/${chunks.length} チャンク（${cached.size} 件はキャッシュ済み）`);

  for (const c of todo) {
    const wav = chunkFiles[c.index];
    if (!wav || !existsSync(wav)) {
      console.warn(`チャンク ${c.index} の wav が見つかりません。スキップ。`);
      continue;
    }
    const buf = readFileSync(wav);
    const res = await transcribe(new Blob([buf], { type: 'audio/wav' }), {
      apiKey: config.elevenLabsApiKey,
    });
    if (!res.ok) {
      // best-effort: 失敗チャンクはキャッシュせず次回に委ねる（レジューム）。
      console.error(`チャンク ${c.index} の転写失敗（${res.kind}）: ${res.message}`);
      continue;
    }
    writeFileSync(
      join(cacheDir, chunkCacheFileName(c.index)),
      JSON.stringify({ text: res.text, words: res.words ?? [] }),
      'utf8',
    );
    console.log(`チャンク ${c.index} 転写完了（${res.words?.length ?? 0} words）`);
  }

  // 全チャンクのキャッシュから segment を組み立て（VOD 絶対秒）。
  const segments: Segment[] = [];
  let missing = 0;
  for (const c of chunks) {
    const p = join(cacheDir, chunkCacheFileName(c.index));
    if (!existsSync(p)) {
      missing++;
      continue;
    }
    const cachedRes = JSON.parse(readFileSync(p, 'utf8')) as {
      text: string;
      words?: import('@fresh-chat-keeper/api/lib/scribe').TranscribeWord[];
    };
    segments.push(...buildSegmentsForChunk(cachedRes, c.startSec));
  }
  if (missing > 0) {
    console.warn(`${missing} チャンクが未転写のままです。再実行で残りを転写できます（レジューム）。`);
  }
  if (segments.length === 0) {
    console.error('投入できる segment がありません。中止。');
    process.exitCode = 1;
    return;
  }

  console.log(`${segments.length} segment を transcript endpoint に投入中...`);
  const result = await postTranscript({
    apiBase: config.apiBase,
    adminToken: config.adminIngestToken,
    videoId,
    segments,
  });
  console.log(`完了: accepted=${result.accepted} buckets=${result.buckets}`);
  console.log(
    `確認: curl "${config.apiBase}/v1/stream-context/summary?videoId=${videoId}&t=3600"`,
  );
}

/** チャンク wav を index 昇順のパス配列で返す。 */
function listChunkFiles(chunksDir: string): string[] {
  if (!existsSync(chunksDir)) return [];
  return readdirSync(chunksDir)
    .filter((f) => /^chunk-\d+\.wav$/.test(f))
    .sort()
    .map((f) => join(chunksDir, f));
}

main().catch((err: unknown) => {
  console.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
