# v0.3.5 デプロイ手順（DEPLOY-01）

Phase 2.5（opt-in データ収集）のリリース手順書。本番 Cloudflare リソース作成 + Chrome Web Store 提出までの手動オペレーションをまとめる。

> このドキュメントは v0.3.5 リリース時の **一回限りの手順** を含む（D1 / KV の初回作成等）。リリース後は内容を簡潔化または `docs/development.md` に統合する想定。

---

## 前提

- `feature/v0.3.5` ブランチがマージ可能な状態（テスト・ビルド緑、レビュー済み）
- Cloudflare アカウント（playnicelab）にアクセス可能
- Chrome Web Store Developer Console にアクセス可能
- ローカルで `wrangler` CLI が動作（`wrangler whoami` で確認）

---

## Step 1: 本番 Cloudflare リソースを作成

### 1.1 D1 データベース作成

```bash
cd apps/api
wrangler d1 create fck-collection-db
```

出力される `database_id` をメモする（例: `9f8c6e2a-...`）。

`wrangler.toml` の以下行を本番 ID に差し替え:
```toml
[[d1_databases]]
binding = "COLLECTION_DB"
database_name = "fck-collection-db"
database_id = "<本番 ID>"  # ← ここ
migrations_dir = "migrations"
```

### 1.2 KV namespace 作成

```bash
wrangler kv namespace create RATE_LIMIT_KV
wrangler kv namespace create CONSENT_KV
```

各々の出力 `id` を `wrangler.toml` に反映:
```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "<RATE_LIMIT_KV の本番 ID>"

[[kv_namespaces]]
binding = "CONSENT_KV"
id = "<CONSENT_KV の本番 ID>"
```

### 1.3 COLLECTION_SALT を secret に設定

salt は長期固定の機密情報。一度設定したら変更しない（変更すると過去ハッシュとの紐付けが切れ、ユーザー一貫性分析が壊れる）。

```bash
# 32 バイトのランダム salt を生成（出力をメモ、ローカルに保管しない）
openssl rand -hex 32

# wrangler secret に登録（プロンプトで上記値を貼り付け）
wrangler secret put COLLECTION_SALT
```

設定確認:
```bash
wrangler secret list
# COLLECTION_SALT が表示されていればOK
```

### 1.4 ALLOWED_ORIGINS の暫定設定

Chrome Web Store の **公開 extension ID は提出後に発行される** ため、初回 deploy では暫定値を入れる:

```toml
[vars]
ALLOWED_ORIGINS = "chrome-extension://placeholder-replace-after-publish"
```

公開後に正しい ID で再 deploy する（Step 5）。

---

## Step 2: 本番 D1 にマイグレーション + seed 投入

### 2.1 マイグレーション適用

```bash
cd apps/api
wrangler d1 migrations apply COLLECTION_DB --remote
```

`0001_initial_collection.sql` が本番 D1 に適用される。

### 2.2 consent_versions テーブルに seed 投入

migration には seed が含まれていないため、初回のみ手動投入:

```bash
wrangler d1 execute COLLECTION_DB --remote --command "INSERT INTO consent_versions (version, policy_url, effective_from) VALUES ('2026-05-01', 'https://github.com/delacunaworks/fresh-chat-keeper/blob/main/docs/privacy-policy.md', 1714521600);"
```

確認:
```bash
wrangler d1 execute COLLECTION_DB --remote --command "SELECT * FROM consent_versions;"
```
1 行返れば OK。

### 2.3 テーブル構造確認

```bash
wrangler d1 execute COLLECTION_DB --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```
`judgment_logs`、`consent_versions`、`consent_records` の 3 テーブルが返れば OK。

---

## Step 3: apps/api を本番デプロイ

```bash
cd apps/api
wrangler deploy
```

`https://fresh-chat-keeper-api.playnicelab.workers.dev` で稼働開始。

ヘルスチェック:
```bash
curl https://fresh-chat-keeper-api.playnicelab.workers.dev/
# {"name":"fresh-chat-keeper-api","status":"ok","phase":"2.5"}
```

---

## Step 4: chrome-ext のビルドと zip 化

### 4.1 ビルド

```bash
cd apps/chrome-ext
pnpm build
```

`dist/` に最新の build artifacts が生成される（vite plugin が manifest.json も自動同期）。

### 4.2 manifest 確認

```bash
cat dist/manifest.json | grep version
# "version": "0.3.5"
```

### 4.3 zip 化

```bash
cd dist
zip -r ../fresh-chat-keeper-v0.3.5.zip .
cd ..
ls -lh fresh-chat-keeper-v0.3.5.zip
```

---

## Step 5: Chrome Web Store に提出

### 5.1 アップロードと審査依頼

1. Chrome Web Store Developer Console（https://chrome.google.com/webstore/devconsole/）にログイン
2. Fresh Chat Keeper のアイテムを開く
3. 「ストア掲載情報」→「パッケージ」セクションで `fresh-chat-keeper-v0.3.5.zip` をアップロード
4. 「ストア掲載情報」のフィールドを更新:
   - 説明文: `docs/store-description-ja.md` / `docs/store-description-en.md` の内容で差し替え
   - プライバシーポリシー URL: `https://delacunaworks.com/fresh-chat-keeper/privacy/` （変更なし、本番 site は事前更新済み）
5. 「変更を保存して審査に出す」

### 5.2 審査中に並行作業

審査中（数時間〜数日）に以下を進める:

#### 5.2.1 brand site の privacy-policy 更新

別リポ `delacunaworks/website` で `privacy-policy.md` を本リポの最新版で同期:

```bash
cd ~/Documents/PersonalProjects/delacunaworks-website  # ※実パスに合わせる
git pull
# privacy-policy.md を docs/privacy-policy.md の内容で更新
git add . && git commit -m "docs: sync privacy-policy with fresh-chat-keeper v0.3.5"
git push
# Cloudflare Pages 自動デプロイで反映
```

#### 5.2.2 PR 作成 → main マージ

```bash
cd ~/Documents/PersonalProjects/fresh-chat-keeper
git checkout feature/v0.3.5
git push origin feature/v0.3.5
gh pr create --base main --head feature/v0.3.5 --title "v0.3.5: Phase 2.5 opt-in data collection" --body "..."
```

GitHub UI で「Create a merge commit」でマージ（squash や rebase は使わない、履歴を保つ）。

### 5.3 審査通過後

Chrome Web Store から **公開 extension ID** が確定する（または既存 ID が継続使用される）。

#### 5.3.1 ALLOWED_ORIGINS を本番 ID に更新

`apps/api/wrangler.toml`:
```toml
[vars]
ALLOWED_ORIGINS = "chrome-extension://<実 ID>"
```

```bash
cd apps/api
wrangler deploy
```

#### 5.3.2 v0.3.5 タグ付け

```bash
# main の最新を取得（重要）
git checkout main
git pull origin main

# タグ作成 + push
git tag v0.3.5 -m "v0.3.5: Phase 2.5 opt-in data collection"
git push origin v0.3.5

# GitHub UI で Release を作成し、CHANGELOG の v0.3.5 セクションを Release Notes に貼る
```

---

## Step 6: 公開後の動作確認

### 6.1 一般ユーザーとして検証

1. 別 Chrome プロファイルまたは別 PC で Chrome Web Store から Fresh Chat Keeper を **新規インストール**
2. YouTube アーカイブを開いて従来機能（フィルタ）が動くことを確認
3. ポップアップで「データ収集（任意）」を ON → 同意モーダル → 「同意して有効化」
4. もう一度 YouTube タブに戻ってチャットを少し流す
5. apps/api 側で件数増加を確認:
```bash
wrangler d1 execute COLLECTION_DB --remote --command "SELECT COUNT(*) FROM judgment_logs;"
```

### 6.2 retention cron 動作確認

毎日 03:00 UTC に自動実行されるが、確認したい場合は wrangler dashboard の Cron Triggers ログで実行履歴を確認。

### 6.3 monitoring

- Cloudflare dashboard で apps/api の error rate / 5xx を確認
- D1 の row 数推移を週次で確認（爆発的増加がないか）
- Chrome Web Store のレビュー欄を 1 週間チェック（opt-in に関する誤解や苦情がないか）

---

## トラブルシューティング

### CORS エラーが出る（既知挙動）

公開後に `chrome-extension://<実 ID>` で apps/api の ALLOWED_ORIGINS を更新するまで、ユーザーの ingest が CORS で reject される。Step 5.3.1 を完了するまで opt-in 機能はストアからインストールしたユーザーには動かない。

### consent_versions が見つからない（422 が返る）

Step 2.2 の seed 投入を忘れた場合に発生。再投入で解決。

### COLLECTION_SALT 未設定（500 が返る）

Step 1.3 を忘れた場合。`wrangler secret put COLLECTION_SALT` で設定して再 deploy。

---

## ロールバック手順

万一 v0.3.5 で重大な問題が発生した場合:

1. Chrome Web Store で前バージョン（v0.3.1）の zip を再アップロード
2. `wrangler rollback` で apps/api を前 deployment に戻す（または stop でメンテナンスモード）
3. 必要に応じて consent_records をすべて削除（ユーザーは v0.3.1 で機能オフのまま使える）

ただし opt-in データはサーバー側で 90 日 retention されているため、v0.3.5 を一時停止しても既存データは自動削除されるまで残る点に注意。
