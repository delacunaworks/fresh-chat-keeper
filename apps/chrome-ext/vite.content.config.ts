import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * Content Script ビルド設定
 *
 * format: 'iife' を使用することで、全依存が1ファイルにインライン化される。
 * Chrome の content_scripts は ES モジュールの import 文を解釈できないため、
 * IIFE 形式（即時実行関数）にバンドルする必要がある。
 */
export default defineConfig({
  /**
   * B6-hotfix: React / ReactDOM が `process.env.NODE_ENV` を実行時参照するため
   * ビルド時にリテラル置換する。popup 用 vite.config.ts は @vitejs/plugin-react が
   * 自動で同等の処理を行うので不要だが、content script はプラグイン無しの素 IIFE
   * バンドルなので明示的に define する必要がある（無いと content script 起動時に
   * `process is not defined` で ReferenceError → 拡張全機能停止）。
   *
   * 'production' を選ぶ理由:
   * - 出荷用拡張なので React dev 警告は不要
   * - production React は dev-only コード（PropTypes / DevTools フック等）を
   *   除去するため bundle サイズが縮む（B6 で 1.49 MB に膨らんだ content.js が
   *   200〜400 KB 程度縮む見込み、G-6 対応も兼ねる）
   */
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'FreshChatKeeperContent',
      fileName: () => 'content.js',
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
      // NOTE: '/stage1_5' は '/stage1' より **必ず前** に置くこと。
      // @rollup/plugin-alias の string find は prefix 一致なので、
      // '/stage1' を先に書くと '/stage1_5' のインポートが
      // '/stage1' に誤って解決される（B1/B2 引き継ぎ事項）。
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
