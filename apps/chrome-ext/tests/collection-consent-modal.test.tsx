/**
 * CollectionConsentModal の DOM 順序テスト。
 *
 * UX-01 で errorMessage の表示位置を scrollable 本体末尾から固定フッター
 * （ボタン直上）に移動した。視認範囲外に出る UX バグを防ぐため、本テストで
 * 「errorMessage の DOM 位置 < 同意ボタンの DOM 位置」を固定する。
 *
 * テスト戦略:
 * - jsdom / @testing-library/react を導入せず、react-dom/server の
 *   renderToStaticMarkup で HTML 文字列を生成して indexOf で順序検証
 * - これにより chrome-ext のテスト依存を最小に保ちながら
 *   コンポーネントの DOM 順序を機械的に保護できる
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CollectionConsentModal } from '../src/popup/CollectionConsentModal.js';

const noop = (): void => undefined;

describe('CollectionConsentModal: errorMessage の DOM 位置（UX-01）', () => {
  it('errorMessage が「同意して有効化」ボタンより前（DOM 順）に出現する', () => {
    const html = renderToStaticMarkup(
      <CollectionConsentModal
        open={true}
        onConsent={noop}
        onCancel={noop}
        errorMessage="サーバーエラーが発生しました。時間を置いて再度お試しください。"
      />,
    );

    const errorIdx = html.indexOf('role="alert"');
    const buttonIdx = html.indexOf('同意して有効化');

    expect(errorIdx).toBeGreaterThan(-1);
    expect(buttonIdx).toBeGreaterThan(-1);
    // UX-01: エラーは ボタン直上 = DOM 順で前 に出る
    expect(errorIdx).toBeLessThan(buttonIdx);
  });

  it('errorMessage は固定フッター（border-t セクション）内に出る', () => {
    const html = renderToStaticMarkup(
      <CollectionConsentModal
        open={true}
        onConsent={noop}
        onCancel={noop}
        errorMessage="ネットワークエラー"
      />,
    );

    // 固定フッターは border-t で始まる div。
    // errorMessage はその中の最初の要素（チェックボックス <label> より前）に出る。
    const footerStart = html.indexOf('border-t');
    const errorIdx = html.indexOf('role="alert"');
    const checkboxLabelIdx = html.indexOf('上記内容を理解し');

    expect(footerStart).toBeGreaterThan(-1);
    expect(errorIdx).toBeGreaterThan(footerStart);
    expect(errorIdx).toBeLessThan(checkboxLabelIdx);
  });

  it('errorMessage が null の場合は role="alert" 要素が出現しない', () => {
    const html = renderToStaticMarkup(
      <CollectionConsentModal
        open={true}
        onConsent={noop}
        onCancel={noop}
        errorMessage={null}
      />,
    );
    expect(html).not.toContain('role="alert"');
  });

  it('open=false の場合は何も render されない（既存挙動の retain）', () => {
    const html = renderToStaticMarkup(
      <CollectionConsentModal
        open={false}
        onConsent={noop}
        onCancel={noop}
        errorMessage="should not be rendered"
      />,
    );
    expect(html).toBe('');
  });
});
