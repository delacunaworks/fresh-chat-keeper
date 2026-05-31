import { defineConfig } from 'vitest/config';

/**
 * apps/chrome-ext のテスト戦略（Phase 2.5 / B4 時点）:
 *
 * - Phase 2.5 で追加した collection-state / collection-client / log-builder の
 *   ロジックを単体でカバー
 * - 既存の content / popup ロジックは DOM 依存が強く、unit test では再現困難な
 *   ため対象外（Tommy の手動テストで担保）
 * - jsdom は導入していない。React コンポーネント（CollectionConsentModal,
 *   App.tsx の CollectionSection）は Tommy の手動テストでカバー
 */
export default defineConfig({
  test: {
    include: [
      'tests/**/*.{test,spec}.ts',
      'tests/**/*.{test,spec}.tsx',
      'src/**/*.{test,spec}.ts',
      'src/**/*.{test,spec}.tsx',
    ],
    passWithNoTests: true,
  },
});
