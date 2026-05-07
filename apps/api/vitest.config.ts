import { defineConfig } from 'vitest/config';

/**
 * apps/api のテスト戦略（Phase 2.5 雛形時点）:
 *
 * - Phase 2.5 B1（雛形）ではテストファイルなし。`passWithNoTests: true` で
 *   `pnpm test` モノレポ集約に組み込めるようにする
 * - B2（ingestion endpoint 実装）以降、`tests/` 配下に統合テストを追加する
 * - apps/proxy と同じ規約（include / coverage 設定）に揃える
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.ts'],
    passWithNoTests: true,
  },
});
