import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * Background Service Worker ビルド設定
 *
 * Service Worker も IIFE 形式でビルドする。
 * （ES モジュール形式にする場合は manifest.json に "type": "module" が必要）
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/background/service-worker.ts'),
      formats: ['iife'],
      name: 'FreshChatKeeperBackground',
      fileName: () => 'background.js',
    },
  },
  resolve: {
    alias: [
      {
        find: '@fresh-chat-keeper/shared',
        replacement: resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
      // B8: data-cleanup.ts が formatDateKey / addDays（UTC 日付計算の単一の真実）を
      // judgment-engine から import するため alias 追加。content config と同じ解決。
      {
        find: '@fresh-chat-keeper/judgment-engine',
        replacement: resolve(__dirname, '../../packages/judgment-engine/src/index.ts'),
      },
    ],
  },
});
