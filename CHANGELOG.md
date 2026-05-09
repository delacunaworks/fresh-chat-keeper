# Changelog

All notable changes to Fresh Chat Keeper will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.5] - 2026-05-XX

### Added
- **データ収集機能（任意・opt-in）** — ネタバレ判定の改善にご協力いただける方向け
  - ポップアップに「データ収集（任意）」セクションを追加。デフォルトはオフ
  - ON にすると同意モーダルが表示され、明示的な同意で初めて有効化される
  - 収集対象は判定対象のチャットメッセージ本文・配信メタデータ・直前 10 件のコメントのみ
  - 投稿者識別子はサーバー側で SHA-1 ハッシュ化し、平文では保存されない
  - いつでもポップアップから取り消せる。取り消し時は過去 90 日のサーバー側ログも削除される
- 同意モーダルおよび取り消し確認モーダルに focus trap / Esc キー / 復帰 focus 等の
  WCAG 2.2 AA 準拠アクセシビリティ機能を実装
- 誤判定報告（既存機能）が opt-in 中はサーバーにも並行送信されるように

### Changed
- 投稿者識別子: 2026 年 5 月時点の YouTube DOM 仕様変更（チャンネル ID の DOM 削除）に
  対応するため、ハンドル名（`@xxx`）を識別子として採用。SHA-1 + サーバー独自 salt で
  ハッシュ化される動作は変わらない
- 内部設計: データ収集 API への通信を background service worker 経由に統一
  （Chrome 147 の MV3 仕様により content-script からの fetch が CORS reject されるため、
  すべての fetch を chrome-extension:// origin から発火させる本番安全構成に変更）

### Security
- データ収集 API URL のホワイトリスト検証を追加
  （ユーザーが設定を改ざんしても、許可リスト外の origin にはリクエストを送らない）
- 同意状態のフェイルクローズ検証を強化

### Fixed
- フィルタ非表示時の disabled ボタンのコントラスト比を WCAG 1.4.11（3:1）以上に
- 同意モーダルのエラー表示位置をスクロール領域末尾からボタン直上に移動
  （API エラー時にユーザーが気付けないケースを修正）
- ポップアップの言語属性（`<html lang="ja">`）の整合性を再確認

### Internal
- apps/api（Cloudflare Workers + D1 + KV）を新設、データ収集インフラとして稼働開始
- 90 日 / 30 日のレコード retention cron を D1 に対して毎日 03:00 UTC で実行
- chrome-ext / shared / api / proxy / judgment-engine 全体のテストを 41 → 66 件に拡充

## [0.3.1] - 2026-05-07

### Changed
- 進行状況の意味を「クリア済みのチャプター」から「視聴中のチャプター」に変更
  - 視聴中のチャプター内のネタバレもブロック対象になります
  - 既存の進行状況設定はそのまま引き継がれます（ほとんどのユーザーは「視聴中」のつもりで設定していたため、実害はほぼありません）
  - UI ラベルとヘルプテキストを「視聴中のチャプター」に統一
  - LLM プロンプトの文言を「現在チャプター『○○』を視聴中（未通過）」に変更

### Fixed
- proxy: Cloudflare KV が一時障害時にレート制限で 500 エラーになる問題を修正（fail-open + warn ログに変更）
- proxy: LLM が想定外の `spoiler_category` を返した場合のフォールバック追加（`uncertainVerdict` 経由で安全側に倒す）
- proxy: 新形式リクエストの `context.settings` 構造を実行時検証、不正な data に 400 で応答するように
- chrome-ext: Stage 2 月間上限到達時に判定待ち中のコメントが 5 秒間非表示のままになる問題を修正
- chrome-ext: 設定マイグレーションで不正な data が来た場合に warn ログを出力するように

### Internal
- shared / chrome-ext: `UserProgress` / `GameProgress` の JSDoc を「視聴中」セマンティクスに更新
- judgment-engine: keyword-matcher の境界条件を境界値テスト 7 件で凍結
- proxy: テストカバレッジを 32 件 → 48 件に拡張（rate limiter / category fallback / settings validation）

### Behavior Changes for Users
- 進行状況の解釈が明確化されたが、**既存ユーザーの実体験はほぼ変わらない**（実コードは v0.2.0 から既に「視聴中」セマンティクスで動作していた）

## [0.3.0] - 2026-04-29

### Changed (Internal Refactoring)

- **判定エンジンの分離**: Stage 1 / Stage 2 のフィルタロジックを `@fresh-chat-keeper/judgment-engine` パッケージに分離。DOM / `chrome.*` 非依存の純粋ロジックとして再構築し、Chrome 拡張・Cloudflare Workers の両方で再利用可能に
- **proxy のバッチ判定 + プロンプトキャッシング対応**: 1 リクエストで全メッセージを Anthropic API に送る形に変更（旧: 5 並列の単一メッセージ送信）。システムプロンプトに `cache_control: ephemeral` を付与し、API コストを大幅削減
- **proxy の新形式リクエスト対応**: `context` オブジェクト + `tier` フィールドの新形式を受け付け。**v0.2.0 拡張からの旧形式リクエストは引き続きサポート**（後方互換）
- **設定スキーマ v2 マイグレーション**: 既存設定に `version: 2` を付与、旧データを `fck_settings_v1_backup` キーにバックアップ。`progressByGame` / `customNgWords` 等のユーザーデータは完全保持
- **旧 `flc_*` プレフィックスキーの自動クリーンアップ**: 拡張機能名リネーム（"Fresh Live Chat" → "Fresh Chat Keeper"）以前のキーが残っているユーザーで、起動時に自動削除

### Fixed

- 進行状況・フィルタ強度を変更したとき、ユーザーがクリックして展開済みのコメントが新基準で再フィルタされない bug を修正
- 設定保存時に `version: 2` フィールドが剥がれてマイグレーションが繰り返し実行される bug を修正
- 複数ジャンルテンプレートを選択した状態で、新エンジン経由では最初の 1 つしか proxy に送られない bug を修正
- proxy のリクエストサイズを 20 メッセージで上限化し、トークン予算超過 / DOS を防止
- chrome-ext 起動時の Promise 連鎖に `.catch()` ハンドラを追加（`chrome.storage` 失敗時のサイレント停止を防止）

### Internal

- `filter-orchestrator.ts` から dead な `verdictFromCache` import を削除

### Behavior Changes for Users

- **なし**（内部リファクタリング。フィルタの精度・UI・操作はすべて v0.2.0 と同等）

## [0.2.0] - 2026-04 (rename release)

- 拡張機能名を "Fresh Live Chat" から "Fresh Chat Keeper" に変更
- ストレージキー / DOM 属性のプレフィックスを `flc_` / `data-flc-` から `fck_` / `data-fck-` に統一
- proxy URL を `fresh-live-chat-proxy.playnicelab.workers.dev` から `fresh-chat-keeper-proxy.playnicelab.workers.dev` に変更
- Chrome Web Store 公開（再審査）

## [0.1.0] - 2026-04 (initial release)

- 初回リリース（旧名 "Fresh Live Chat"）
- 2 段階フィルタ（Stage 1 キーワードマッチ + Stage 2 Claude AI 判定）
- アーカイブモード + ライブモード対応
- カスタム NG ワード / ジャンルテンプレート / 進行状況連動フィルタ
- 動画タイトルからのゲーム自動推測
- 表示方式選択（プレースホルダー / 完全非表示）
- 3 段階フィルタ強度（厳格 / 標準 / 緩め）
