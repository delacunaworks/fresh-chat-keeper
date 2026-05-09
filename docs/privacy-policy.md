# プライバシーポリシー / Privacy Policy

**Fresh Chat Keeper Chrome Extension**
最終更新 / Last updated: 2026-05-XX

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

### opt-in 同意に基づくデータ収集（v0.3.5 以降）

ネタバレ判定の精度改善およびドメイン特化モデルの研究目的で、ユーザーの**明示的な同意**があった場合に限り、判定ログを当社サーバー（Cloudflare Workers + D1）に蓄積します。

**重要な特性:**
- **デフォルトは OFF** です。ポップアップで明示的にトグルをオンにし、同意モーダルでチェックボックスにチェックを入れて「同意して有効化」を押した場合のみ有効化されます。
- **いつでもオフにできます。** ポップアップから「データ削除を申請」を選択すると、サーバー側に蓄積された過去のログ（90 日以内）も削除されます。
- 同意はバージョン管理されており、ポリシー改定時には再同意を求めます。

**収集する項目:**
| 項目 | 用途 |
|------|------|
| チャットメッセージ本文 | 判定モデル教育用テキスト |
| 配信メタデータ（動画 ID、配信者チャンネル ID、推定ゲーム名） | データセットの分類・分析 |
| 直前 10 件のチャットコメント本文 | 文脈情報（投稿者情報なし） |
| 判定結果（spoiler / safe / harassment 等のラベル）と AI 信頼度 | 判定品質の評価 |
| 投稿者識別子（YouTube ハンドル名）の **SHA-1 ハッシュ値** | 同一投稿者の行動パターン分析（平文は保存されません） |
| 拡張バージョン、判定モード（live / archive_replay） | バグ追跡・分析用 |

**収集しない項目:**
- ユーザーご自身の YouTube アカウント情報（メールアドレス、表示名等）
- ユーザーご自身が投稿したコメント
- 視聴履歴・動画再生位置

**ハッシュ化について:**
投稿者の識別子（ハンドル名）は、サーバー側で固有の salt を用いた SHA-1 ハッシュ値に変換され、平文では一切保存されません。salt は当社内で機密情報として管理されており、第三者がハッシュ値から元のハンドル名を逆引きすることは困難です。

**保管期間（自動削除）:**
- 判定ログ: 受信から **90 日**
- 同意取り消し済みのレコード: 取り消しから **30 日**（GDPR 等の要請への対応猶予）
- 上記いずれも、毎日 03:00 UTC に Cloudflare Workers の cron で自動削除されます。

**第三者提供:**
- 収集したデータは Fresh Chat Keeper の判定モデル改善および学術研究目的でのみ使用されます。
- 個人を特定可能な形で第三者に提供することはありません。
- 将来、匿名化されたデータセットを公開する場合があります（その際はプライバシーポリシーで事前にお知らせします）。

**通信の安全性:**
- 全通信は HTTPS で暗号化されます。
- 拡張機能内の API URL はホワイトリストで固定されており、第三者の悪意あるサーバーに送信されることはありません。

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

### Opt-in Data Collection (v0.3.5 and later)

For the purpose of improving spoiler detection accuracy and conducting research toward a domain-specific model, we store judgment logs on our servers (Cloudflare Workers + D1) **only when the user has explicitly consented**.

**Key properties:**
- **Disabled by default.** This feature is activated only after you explicitly toggle it on in the popup, check the consent checkbox, and click "Agree and enable" in the consent dialog.
- **Revocable at any time.** Selecting "Request data deletion" in the popup also deletes any past logs accumulated on our servers (within the last 90 days).
- Consent is version-controlled. If the policy is updated, we will request renewed consent.

**Items collected:**
| Item | Purpose |
|------|---------|
| Chat message body | Training text for the judgment model |
| Stream metadata (video ID, streamer channel ID, inferred game title) | Dataset classification and analysis |
| Last 10 preceding chat messages (body only) | Contextual information (no author info) |
| Judgment result (labels: spoiler / safe / harassment, etc.) and AI confidence | Evaluating judgment quality |
| **SHA-1 hash** of author identifier (YouTube handle) | Same-author behavior analysis (plaintext is not stored) |
| Extension version, judgment mode (live / archive_replay) | Bug tracking and analysis |

**Items NOT collected:**
- Your own YouTube account information (email, display name, etc.)
- Comments you have posted
- Viewing history or video playback position

**About hashing:**
Author identifiers (handle names) are converted to SHA-1 hash values on the server using a unique salt, and plaintext values are never stored. The salt is managed as confidential information internally, making it impractical for third parties to reverse-engineer the original handle name from a hash.

**Retention (automatic deletion):**
- Judgment logs: **90 days** from receipt
- Records of revoked consent: **30 days** from revocation (grace period for GDPR-style requests)
- All deletions are performed automatically via a Cloudflare Workers cron job daily at 03:00 UTC.

**Third-party sharing:**
- Collected data is used solely for improving Fresh Chat Keeper's judgment model and for academic research.
- We do not share data with third parties in personally identifiable form.
- We may publish anonymized datasets in the future (in which case we will notify users in advance via this Privacy Policy).

**Communication security:**
- All communication is encrypted with HTTPS.
- The API URL within the extension is fixed via a whitelist, so requests cannot be sent to unknown malicious servers.

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
