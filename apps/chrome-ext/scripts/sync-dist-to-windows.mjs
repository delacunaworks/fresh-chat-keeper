/**
 * WSL でビルドした dist を、ミラーしている Windows 側 clone の dist へコピーする
 * 開発補助スクリプト（build の最後に実行）。
 *
 * 背景: 開発は WSL（~/dev/delacunaworks/<repo>）で行い、拡張は Windows Chrome に
 * 「パッケージ化されていない拡張機能」として読み込む。WSL の \\wsl$ パスを直接
 * 読み込むと Chrome が変更を検知しづらく毎回「削除→入れ直し」が要る。Windows 側
 * clone（/mnt/c/Users/<user>/Documents/delacunaworks/<repo>）の dist を最新化して
 * そこから読み込めば、以後は拡張の再読み込み（↻）だけで反映される。
 *
 * 安全策: WSL 以外（/mnt/c 無し）・Windows clone が無い環境（CI・他マシン・
 * 他コントリビュータ）では**静かに no-op**。ビルドを失敗させない。
 */
import { existsSync, cpSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(here); // apps/chrome-ext
const dist = join(pkgDir, 'dist');
const repoName = basename(dirname(dirname(pkgDir))); // <repo>

const user = process.env.USER || process.env.USERNAME || '';

function skip(reason) {
  // 静かなスキップ（他環境ではノイズにしない）。
  if (process.env.FCK_SYNC_VERBOSE) console.log(`[sync-dist] skip: ${reason}`);
  process.exit(0);
}

if (!existsSync('/mnt/c')) skip('not WSL (/mnt/c なし)');
if (!user) skip('USER 不明');
if (!existsSync(dist)) skip('dist 未生成');

const winExtDir = `/mnt/c/Users/${user}/Documents/delacunaworks/${repoName}/apps/chrome-ext`;
if (!existsSync(winExtDir)) skip(`Windows clone なし (${winExtDir})`);

const target = join(winExtDir, 'dist');
try {
  cpSync(dist, target, { recursive: true });
  console.log(`[sync-dist] dist → ${target}`);
} catch (e) {
  console.warn(`[sync-dist] コピー失敗（無視）: ${e instanceof Error ? e.message : String(e)}`);
}
