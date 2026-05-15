import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import type { Plugin } from 'vite';

/**
 * manifest.json と _locales/ をルートから dist/ にコピーするプラグイン。
 *
 * - manifest.json: 拡張のメタデータ。__MSG_*__ プレースホルダで i18n される
 *   ため、対応する _locales/<locale>/messages.json と一緒に配置する必要が
 *   ある（Chrome Web Store の localized listing にも必須）。
 * - _locales/: chrome.i18n が参照する翻訳辞書。各言語の messages.json を
 *   ディレクトリごと再帰コピー。
 */
function copyManifest(): Plugin {
  return {
    name: 'copy-manifest',
    closeBundle() {
      const distDir = resolve(__dirname, 'dist');
      mkdirSync(distDir, { recursive: true });
      copyFileSync(
        resolve(__dirname, 'manifest.json'),
        resolve(distDir, 'manifest.json'),
      );
      // _locales/ を再帰コピー
      copyDirRecursive(
        resolve(__dirname, '_locales'),
        resolve(distDir, '_locales'),
      );
    },
  };
}

/**
 * dir を再帰的にコピーする。Node 16+ なら fs.cpSync で代替可能だが、
 * Windows / 古い Node でも動くよう手書きで実装。
 */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = resolve(src, entry);
    const destPath = resolve(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ポップアップ用ビルド設定
export default defineConfig({
  plugins: [react(), copyManifest()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
  resolve: {
    alias: [
      {
        find: '@fresh-chat-keeper/shared',
        replacement: resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
      {
        find: '@fresh-chat-keeper/knowledge-base',
        replacement: resolve(__dirname, '../../packages/knowledge-base/src/index.ts'),
      },
      // NOTE: '/stage1_5' は '/stage1' より **必ず前**（prefix 一致対策、B1/B2 引き継ぎ）
      {
        find: '@fresh-chat-keeper/judgment-engine/stage1_5',
        replacement: resolve(__dirname, '../../packages/judgment-engine/src/stage1_5/index.ts'),
      },
      {
        find: '@fresh-chat-keeper/judgment-engine/stage1',
        replacement: resolve(__dirname, '../../packages/judgment-engine/src/stage1/index.ts'),
      },
      {
        find: '@fresh-chat-keeper/judgment-engine',
        replacement: resolve(__dirname, '../../packages/judgment-engine/src/index.ts'),
      },
      {
        find: '@kb-data',
        replacement: resolve(__dirname, '../../packages/knowledge-base/data'),
      },
    ],
  },
});
