import { defineConfig } from 'vitest/config';

/**
 * knowledge-base はジャンルテンプレート + ゲームデータの JSON コンテナで、
 * 現状テストを書く前提のないパッケージ。`pnpm test`（モノレポ集約）で
 * "No test files found, exiting with code 1" にならないよう
 * `passWithNoTests: true` を設定する。
 *
 * 規約は judgment-engine / shared の vitest.config.ts と同一。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    passWithNoTests: true,
  },
});
