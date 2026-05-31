# プライバシーポリシー / Privacy Policy

**Fresh Chat Keeper Chrome Extension**
最終更新 / Last updated: 2026-05-30

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
| ユーザーブロックリスト（YouTube チャンネルID / ハンドル名・ブロック時点の表示名・ブロック日時） | ブロックしたユーザーのコメント非表示（端末内のみ。外部送信なし） |
| 誤判定レポート（最大 100 件。報告種別 FP/FN・選択カテゴリを含む） | モデル改善のため端末内に蓄積。opt-in 同意中のみ後述の収集 API にも並行送信 |
| 月間利用カウント | 月間上限の管理 |

### Anthropic API へのデータ送信

ネタバレ判定（Stage 2）を行う際に、YouTube チャットのコメントテキストを Anthropic の Claude API に送信します。

- 送信するデータはコメントテキストと動画タイトルのみです。ユーザー名・アカウント情報・視聴履歴は送信しません。
- v0.4.0 以降、ネタバレに加え **暴言・誹謗中傷 / スパム・連投 / 無関係な話題・他配信者言及 / 指示厨・攻略押し付け** のマルチラベル判定を行いますが、送信するデータは同じくコメントテキストと動画タイトルのみで、判定結果はブラウザ内にのみキャッシュされます。
- 動画タイトルは、プレイ中のゲームを推測してネタバレ判定の精度を向上させるために使用します。
- API リクエストは Fresh Chat Keeper が管理する軽量プロキシ経由で行われます。
- **プロキシはチャットメッセージおよび動画タイトルをログ保存しません。** 判定処理後に破棄されます。
- Anthropic のデータ取り扱いについては [Anthropic Privacy Policy](https://www.anthropic.com/privacy) を参照してください。

### ブロック機能・誤判定報告について（v0.4.0 以降）

**ブロック機能**

特定のユーザーのコメントを非表示にする「ブロック機能」を提供しています。ブロック対象の YouTube チャンネルID（または 2026-05 以降の YouTube 仕様変更によりハンドル名）・ブロック時点の表示名・ブロック日時が `chrome.storage.local` にのみ保存されます。

- ブロック情報は外部サーバーに送信されません。
- いつでもブロック解除・全削除が可能です（ポップアップの「ブロックリスト」タブ）。
- ブロックされたユーザーには通知されません（シャドウミュート）。

**誤判定報告（フィルタ済み＝False Positive / 見逃し＝False Negative）**

コメントのフィルタが誤っていた場合に、種別（誤フィルタ / 見逃し）と本来のカテゴリ（ネタバレ・暴言・スパム・無関係・指示厨・わからない・スキップ）を選んで報告できます。報告は端末内（最大 100 件）に蓄積されます。**opt-in 同意中の場合のみ**、後述の収集 API にも並行送信されます（同意していない場合は端末内のみ）。報告に含まれるのは対象コメント本文・選択カテゴリ・報告種別で、報告者ご自身の情報は含まれません。

### 視聴者フラグ機能について（v0.5.0 以降）

繰り返しフィルタに引っかかる視聴者を 4 段階（問題なし / 軽微 / 注意 / 要注意）で
可視化し、ブロック判断を支援する「視聴者フラグ機能」を提供しています。

**重要な特性:**
- **デフォルトは OFF（オプトイン）** です。ポップアップの「フラグ視聴者」タブで
  明示的に有効化した場合のみ動作します。
- **完全にブラウザ内（`chrome.storage.local`）のみで動作し、集計データの外部送信は
  一切ありません。** これは v0.3.5 の opt-in データ収集（サーバー送信あり）とは
  **別物**です。
- 配信者単位で独立して保存され、他のコミュニティに共有されることはありません。

**端末内に保存する情報:**
- 配信者のチャンネル ID
- 視聴者の YouTube ハンドル名（2026-05 以降の YouTube 仕様変更により、UC ID では
  なくハンドル名 `@xxx`）
- 視聴者の表示名
- 日別の総コメント数・カテゴリ別フィルタ該当数

**保存しない情報:**
- コメント本文（フラグ判定後に破棄。本文は保存しません）
- 視聴者の個人情報（メールアドレス等）
- 他の配信での視聴者の活動履歴（配信者スコープで独立、横断追跡なし）

**自動削除・無効化:**
- 追跡期間（7 日 / 30 日）を超えたデータは 1 日 1 回バックグラウンドで自動削除されます。
- 「フラグ視聴者」タブからいつでも全データを削除できます。
- 機能を無効化すると以降の集計は停止します。

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
| User block list (YouTube channel ID / handle, display name at block time, block timestamp) | Hiding comments from blocked users (local only; never transmitted) |
| Misjudgment reports (up to 100 entries; includes report kind FP/FN and selected category) | Stored locally for model improvement; also sent in parallel to the collection API only while opt-in consent is active |
| Monthly usage count | Managing the monthly usage limit |

### Data Sent to Anthropic API

When performing spoiler detection (Stage 2), Fresh Chat Keeper sends YouTube chat comment text to the Anthropic Claude API.

- Only comment text and the video title are sent. Usernames, account information, and viewing history are never sent.
- Since v0.4.0, in addition to spoilers, multi-label classification is performed for **harassment, spam/flooding, off-topic / other-streamer mentions, and backseat gaming**. The data sent is still only comment text and video title, and verdicts are cached only in the browser.
- The video title is used to infer the game being played, improving the accuracy of spoiler detection.
- API requests are made through a lightweight proxy managed by Fresh Chat Keeper.
- **The proxy does not log chat messages or video titles.** They are discarded after processing.
- For Anthropic's data handling practices, please refer to the [Anthropic Privacy Policy](https://www.anthropic.com/privacy).

### Block Feature & Misjudgment Reports (v0.4.0 and later)

**Block feature**

A "block" feature lets you hide comments from specific users. The blocked user's YouTube channel ID (or handle, due to YouTube's 2026-05 DOM changes), display name at block time, and block timestamp are stored only in `chrome.storage.local`.

- Block information is never sent to external servers.
- You can unblock or clear all blocks at any time (the "Block list" tab in the popup).
- Blocked users are not notified (shadow mute).

**Misjudgment reports (filtered = False Positive / missed = False Negative)**

When a comment was filtered incorrectly, you can report it by choosing the kind (mis-filtered / missed) and the intended category (spoiler / harassment / spam / off-topic / backseat / unknown / skip). Reports are stored locally (up to 100). **Only while opt-in consent is active**, they are also sent in parallel to the collection API described below (local only if you have not consented). A report contains the target comment text, selected category, and report kind — no information about you, the reporter.

### Viewer Flagging Feature (v0.5.0 and later)

A "viewer flagging" feature visualizes viewers who repeatedly trigger filters
across 4 levels (clean / minor / caution / warning) to support your blocking
decisions.

**Key characteristics:**
- **Disabled by default (opt-in).** It works only when you explicitly enable it
  in the "Flagged viewers" tab of the popup.
- **It runs entirely within your browser (`chrome.storage.local`); aggregated
  data is never sent externally.** This is **distinct** from the v0.3.5 opt-in
  data collection (which does send to a server).
- Data is stored per streamer and is never shared across communities.

**Information stored locally:**
- The streamer's channel ID
- The viewer's YouTube handle (due to YouTube's 2026-05 DOM changes, the handle
  `@xxx` rather than a UC ID)
- The viewer's display name
- Per-day total comment counts and per-category filtered counts

**Information NOT stored:**
- Comment text (discarded after flag judgment; bodies are not stored)
- Viewers' personal information (email, etc.)
- Viewers' activity history on other streams (scoped per streamer, no
  cross-stream tracking)

**Auto-deletion / disabling:**
- Data older than the tracking window (7 / 30 days) is auto-deleted once a day
  in the background.
- You can delete all data at any time from the "Flagged viewers" tab.
- Disabling the feature stops further aggregation.

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
