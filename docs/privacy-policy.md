# プライバシーポリシー / Privacy Policy

**Fresh Chat Keeper Chrome Extension**
最終更新 / Last updated: 2026-04-20

---

## 日本語

### 収集するデータ

Fresh Chat Keeper は個人を特定できる情報を一切収集しません。

### ローカルに保存する情報

以下の情報はお使いのブラウザの `chrome.storage.local` にのみ保存され、外部サーバーには送信されません。

| 項目 | 用途 |
|------|------|
| フィルタ設定（有効/無効、フィルタモード、ジャンルテンプレート選択等） | 設定の永続化 |
| ゲーム進行状況 | ネタバレ判定の基準として使用 |
| カスタム NG ワード | ユーザーが設定したフィルタキーワードの保存 |
| Stage 2 判定キャッシュ（テキストのハッシュ → 判定結果） | 同一コメントへの重複リクエスト防止 |
| 匿名トークン（UUID） | レート制限のためにプロキシへ送信（ユーザーとは紐付かない） |
| 誤判定レポート（最大 100 件） | 将来のモデル改善のため端末内に蓄積（現時点で外部送信はしない） |
| 月間利用カウント | 月間上限の管理 |

### Anthropic API へのデータ送信

ネタバレ判定（Stage 2）を行う際に、YouTube チャットのコメントテキストを Anthropic の Claude API に送信します。

- 送信するデータはコメントテキストと動画タイトルのみです。ユーザー名・アカウント情報・視聴履歴は送信しません。
- 動画タイトルは、プレイ中のゲームを推測してネタバレ判定の精度を向上させるために使用します。
- API リクエストは Fresh Chat Keeper が管理する軽量プロキシ経由で行われます。
- **プロキシはチャットメッセージおよび動画タイトルをログ保存しません。** 判定処理後に破棄されます。
- Anthropic のデータ取り扱いについては [Anthropic Privacy Policy](https://www.anthropic.com/privacy) を参照してください。

### Chrome Web Store ストアページのアクセス解析について

Chrome Web Store 上の本拡張機能のストアページには、Google Analytics 4 によるアクセス解析が導入されています。これは Chrome Web Store が提供する機能であり、**ストアページの訪問状況**を把握することを目的としています。

- **対象**: Chrome Web Store のストアページを訪問したユーザー
- **収集される情報**: 訪問元URL、大まかな地域情報、ブラウザ・デバイス情報、ストアページ内の操作等
- **収集主体**: Google LLC（Chrome Web Store 経由）
- **目的**: ストアページの改善および流入経路の把握

**この解析は、本拡張機能をインストールしたユーザーの YouTube 上での行動や、拡張機能の動作を追跡するものではありません。** 拡張機能自体は、本ポリシーに記載のとおり、ユーザーの個人情報や視聴履歴を収集・送信することはありません。

Google Analytics のデータ取り扱いについては [Google プライバシーポリシー](https://policies.google.com/privacy) を参照してください。

### 第三者へのデータの販売・共有

Fresh Chat Keeper はユーザーデータを第三者に販売・共有することは一切ありません。

### 問い合わせ

ご質問は [GitHub リポジトリの Issues](https://github.com/delacunaworks/fresh-chat-keeper/issues) または [delacunaworks@gmail.com](mailto:delacunaworks@gmail.com) までお問い合わせください。

---

## English

### Data Collection

Fresh Chat Keeper does not collect any personally identifiable information.

### Information Stored Locally

The following information is stored only in your browser's `chrome.storage.local` and is never transmitted to external servers.

| Item | Purpose |
|------|---------|
| Filter settings (enabled/disabled, filter mode, genre template selection, etc.) | Persisting user preferences |
| Game progress | Used as reference point for spoiler detection |
| Custom block words | Storing user-defined filter keywords |
| Stage 2 judgment cache (text hash → verdict) | Avoiding duplicate requests for the same comment |
| Anonymous token (UUID) | Sent to the proxy for rate-limiting purposes only; not linked to any user identity |
| False-positive reports (up to 100 entries) | Stored locally for future model improvement; not transmitted externally at this time |
| Monthly usage count | Managing the monthly usage limit |

### Data Sent to Anthropic API

When performing spoiler detection (Stage 2), Fresh Chat Keeper sends YouTube chat comment text to the Anthropic Claude API.

- Only comment text and the video title are sent. Usernames, account information, and viewing history are never sent.
- The video title is used to infer the game being played, improving the accuracy of spoiler detection.
- API requests are made through a lightweight proxy managed by Fresh Chat Keeper.
- **The proxy does not log chat messages or video titles.** They are discarded after processing.
- For Anthropic's data handling practices, please refer to the [Anthropic Privacy Policy](https://www.anthropic.com/privacy).

### Analytics on the Chrome Web Store Listing Page

The Chrome Web Store listing page for this extension has Google Analytics 4 enabled. This is a feature provided by the Chrome Web Store and is used to understand **how visitors interact with the listing page itself**.

- **Scope**: Visitors to the Chrome Web Store listing page
- **Information collected**: Referrer URL, approximate geographic region, browser and device information, interactions on the listing page, etc.
- **Data controller**: Google LLC (via Chrome Web Store)
- **Purpose**: Improving the listing page and understanding traffic sources

**This analytics does not track installed users' activity on YouTube or the behavior of the extension itself.** As stated elsewhere in this policy, the extension does not collect or transmit personal information or viewing history.

For Google Analytics' data handling practices, please refer to [Google's Privacy Policy](https://policies.google.com/privacy).

### Data Sharing

Fresh Chat Keeper does not sell or share user data with any third parties.

### Contact

For questions, please open an issue on the [GitHub repository](https://github.com/delacunaworks/fresh-chat-keeper/issues) or contact us at [delacunaworks@gmail.com](mailto:delacunaworks@gmail.com).
