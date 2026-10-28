# セットアップ手順

ターミナルを使わず、ブラウザだけで進める場合は [SETUP-BROWSER.md](SETUP-BROWSER.md) を参照してください。

認証情報（鍵・トークン・パスワード）は **チャットやリポジトリに貼らず**、最後の手順で `wrangler secret put` で直接 Cloudflare に登録してください。このリポジトリは公開設定なので、IDやトークンを含むファイルはコミットしないでください（`.dev.vars` は除外済み）。

所要時間の目安: 担当者が揃っていれば半日〜1日。Google広告の開発者トークン審査だけは数日かかることがあります。

| # | やること | 誰が | 得られるもの |
|---|---|---|---|
| 1 | Cloudflare の準備 | Web担当 | KV の ID |
| 2 | Microsoft Entra ID のアプリ登録 | M365 管理者 | クライアントID / シークレット / テナントID |
| 3 | Cloudflare Access の設定 | Web担当 | チームドメイン / AUD タグ |
| 4 | GA4 用サービスアカウント | GCP 管理者 + GA4 管理者 | サービスアカウントの JSON 鍵 / プロパティID |
| 5 | Google広告 API の準備 | 広告MCC 管理者 | 開発者トークン / OAuth 情報 / MCC ID |
| 5-2 | Meta広告 API の準備 | ビジネスマネージャ管理者 | システムユーザーのアクセストークン / 広告アカウントID |
| 6 | Claude API キー | 契約者 | API キー |
| 7 | シークレット登録とデプロイ | Web担当 | ダッシュボードのURL |

---

## 1. Cloudflare の準備

```bash
npm ci
npx wrangler login
npx wrangler kv namespace create CACHE
```

表示された `id` を `wrangler.jsonc` の `REPLACE_WITH_KV_NAMESPACE_ID` と置き換えます。

プランは Workers Free で動きます（30分ごとの先読みで KV 書き込みは1日約400回、無料枠は1,000回）。先読み間隔を短くしたい場合は Workers Paid（月5ドル）にしてください。

## 2. Microsoft Entra ID のアプリ登録（M365 管理者）

1. [Entra 管理センター](https://entra.microsoft.com/) → アプリの登録 → 新規登録
   - 名前: `Cloudflare Access`（任意）
   - サポートされるアカウント: この組織ディレクトリのみ
   - リダイレクト URI（Web）: `https://<チーム名>.cloudflareaccess.com/cdn-cgi/access/callback`
     （チーム名は手順3の Zero Trust 初回設定で決めます。先に決めておくと手戻りがありません）
2. 「証明書とシークレット」でクライアントシークレットを作成し、値を控える
3. 「API のアクセス許可」で Microsoft Graph の委任されたアクセス許可 `email` `openid` `profile` `offline_access` `User.Read` を追加し、管理者の同意を与える
   - マーケティンググループのセキュリティグループでアクセスを絞る場合は `Group.Read.All` も追加
4. 概要ページの「アプリケーション（クライアント）ID」「ディレクトリ（テナント）ID」を控える

## 3. Cloudflare Access の設定

1. Cloudflare ダッシュボード → Zero Trust（初回はチーム名を決める。Free プランは50ユーザーまで無料）
2. 設定 → 認証 → ログイン方法 → 追加 → **Azure AD**
   - 手順2のアプリケーションID / シークレット / ディレクトリID を入力
   - グループで絞る場合は「Support groups」をオン
   - 「Test」でサインインできることを確認
3. デプロイ（手順7）を一度行った後、Workers & Pages → `rik-web-analytics` → 設定 → ドメインとルート → `workers.dev` の「Cloudflare Access を有効にする」をオン
   - 自社ドメイン（例: `analytics.rikcorp.jp`）で公開する場合は、`wrangler.jsonc` の `routes` を設定し、Zero Trust → Access → アプリケーション でセルフホスト型アプリを作成してください（ドメインのDNSが Cloudflare にある必要があります）
4. Access アプリケーションのポリシーを設定
   - 例: 「Allow」/ Include: Emails ending in `@rikcorp.jp`
   - グループで絞る例: Include: Azure groups = マーケティンググループのオブジェクトID
5. アプリケーションの「概要」にある **Application Audience (AUD) タグ** を控える
6. Workers & Pages → `rik-web-analytics` → 設定 → 変数とシークレット で、種類「テキスト」の変数を2つ追加
   - `ACCESS_TEAM_DOMAIN`: `<チーム名>.cloudflareaccess.com`
   - `ACCESS_AUD`: 手順5の AUD タグ
   - `wrangler.jsonc` は `keep_vars: true` なので、デプロイし直してもこの2つは消えません。設定するまでは画面に「Cloudflare Access の設定が未設定です」と出て、データは表示されません

Worker 側でも Access の署名付きトークン（`Cf-Access-Jwt-Assertion`）を検証するので、Access の設定漏れがあってもデータは表示されません。

## 4. GA4 用サービスアカウント

1. [Google Cloud コンソール](https://console.cloud.google.com/) でプロジェクトを作成（既存でも可）
2. 「API とサービス」→ **Google Analytics Data API** を有効化
3. IAM → サービスアカウント → 作成（ロールは付けなくてよい）→ 鍵 → JSON を作成してダウンロード
   - 組織ポリシーで鍵作成が禁止されている場合は GCP 管理者に例外を依頼
4. GA4 の各プロパティ（4つ）で 管理 → プロパティのアクセス管理 → サービスアカウントのメールアドレスを **閲覧者** で追加
5. 各プロパティの **プロパティID**（数字）を控える（管理 → プロパティの詳細）

## 5. Google広告 API の準備

1. 開発者トークンは不要です（2026年9月に廃止され、利用権限は Google Cloud プロジェクト単位になりました）。本番アカウントのデータを取るには、Google Cloud コンソールでそのプロジェクトに Explorer 以上のアクセスレベルを付けます
2. 手順4と同じ GCP プロジェクトで **Google Ads API** を有効化し、「アクセスレベル → 管理」から Explorer を申請
3. **おすすめ（OAuth 不要）**: Google広告の MCC の「管理 → アクセスとセキュリティ」で、手順4のサービスアカウントのメールアドレスを「閲覧のみ」のユーザーとして追加する。OAuth の CLIENT_ID / SECRET / REFRESH_TOKEN を登録しなければ、このサービスアカウントで Google広告 API を呼びます
   - 下の OAuth の手順（4〜5）は、サービスアカウントを使わない場合だけ必要です
4. 「認証情報」→ OAuth クライアントID を作成（種類: ウェブアプリケーション、リダイレクトURI に `https://developers.google.com/oauthplayground` を追加）
5. [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) を開き、歯車から「Use your own OAuth credentials」に手順4の ID / シークレットを入力
   - スコープ `https://www.googleapis.com/auth/adwords` を入力して認可（MCC にアクセスできる社内アカウントでログイン）
   - 「Exchange authorization code for tokens」で **リフレッシュトークン** を取得
   - OAuth 同意画面が「テスト」状態だとリフレッシュトークンが7日で失効します。「本番」にするか、Google Workspace の内部アプリにしてください
6. MCC の顧客ID（`123-456-7890` 形式）と、各広告アカウント（3つ）の顧客IDを控える

## 5-2. Meta広告 API の準備

Facebook・Instagram 広告のデータは Meta Marketing API（Insights API）で取得します。読み取り専用の権限だけを使います。

1. [Meta for Developers](https://developers.facebook.com/apps/) でアプリを作成
   - 種類は「ビジネス」、ビジネスポートフォリオは自社のものを選択
   - アプリに「マーケティングAPI」を追加
   - 社内利用だけなら、アプリは開発モードのままで構いません（自社ビジネスの広告アカウントのデータは取得できます）
2. [ビジネス設定](https://business.facebook.com/settings/) → ユーザー → **システムユーザー** → 追加（役割: 従業員）
3. 作ったシステムユーザーに「アセットを追加」→ 広告アカウント → 対象の広告アカウントを選び、**パフォーマンスを確認（閲覧）** の権限を付与
4. 同じシステムユーザーに手順1のアプリを割り当て（アプリ → 管理を付与）
5. システムユーザーの「新しいトークンを生成」→ 手順1のアプリを選択 → 有効期限は「なし」→ 権限 `ads_read` にチェック → 生成したトークンを控える
   - このトークンは画面を閉じると再表示できません。紛失した場合は作り直してください
6. アプリの 設定 → ベーシック にある **app secret** を控える（任意。登録するとAPI呼び出しに署名を付けるので、トークン単体が漏れても使われにくくなります）
7. 各広告アカウントの **広告アカウントID**（広告マネージャのURL `act=` の後ろの数字）を控える

コンバージョンとして数える指標は、既定で「リード」（`lead`。Metaピクセルのリードとリード獲得フォームの合計）です。資料請求などをカスタムコンバージョンで計測している場合は、手順7の `metaConversionActions` に action_type（例: `offsite_conversion.custom.123456789`）を指定してください。重複する種類（`lead` と `offsite_conversion.fb_pixel_lead` など）を両方入れると二重に数えます。

## 6. Claude API キー

[Claude Console](https://platform.claude.com/) で API キーを発行します。AIアドバイスは毎朝7時に各サイト1回と、画面の「作り直す」ボタンで生成されます（同じサイトは5分以内に再生成しない制限あり）。画面右下の「AIに質問」でも同じキーを使います（1人1時間60回まで）。

## 7. シークレット登録とデプロイ

サイト設定（`SITES_JSON`）を用意します。プロパティIDや顧客IDを公開リポジトリに載せないため、これもシークレットにします。

```json
[
  { "id": "corp", "name": "コーポレートサイト", "url": "https://www.rikcorp.jp/", "ga4PropertyId": "123456789", "adsCustomerIds": ["111-111-1111"], "metaAdAccountIds": ["1234567890123456"], "goal": "問い合わせ・資料請求の獲得" },
  { "id": "product", "name": "製品サイト", "ga4PropertyId": "234567890", "adsCustomerIds": ["222-222-2222"] },
  { "id": "rikshare", "name": "RIKシェア", "ga4PropertyId": "345678901", "adsCustomerIds": ["333-333-3333"] },
  { "id": "xxx", "name": "（4つ目のサイト）", "ga4PropertyId": "456789012" }
]
```

- `id` はURLやキャッシュに使う英数字。`goal` は任意で、AIアドバイスの前提として使われます
- 1サイトに複数の広告アカウントがある場合は `adsCustomerIds` / `metaAdAccountIds` に並べると合算されます
- `metaConversionActions`（任意）: Meta広告でCVとして数える action_type の配列。省略時は `["lead"]`
- `googleAdsViaGa4`（任意）: `true` にすると、Google広告APIの代わりに GA4 にリンクされた Google広告の費用・クリック・表示回数と、Google広告経由のキーイベントを使います。`adsCustomerIds` があればそちらが優先です

```bash
npx wrangler secret put SITES_JSON                     # 上のJSONを貼り付け
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON    # 手順4のJSONファイルの中身
npx wrangler secret put GOOGLE_ADS_CLIENT_ID
npx wrangler secret put GOOGLE_ADS_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_REFRESH_TOKEN
npx wrangler secret put GOOGLE_ADS_LOGIN_CUSTOMER_ID   # MCC の顧客ID
npx wrangler secret put META_ACCESS_TOKEN              # 手順5-2のシステムユーザーのトークン
npx wrangler secret put META_APP_SECRET                # 任意。手順5-2の app secret
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

`SITES_JSON` が未登録のうちはデモデータで表示されます（画面上部に「デモデータ」と出ます）。

### GitHub Actions からデプロイする場合（任意）

リポジトリの Settings → Secrets and variables → Actions に `CLOUDFLARE_API_TOKEN`（「Workers の編集」テンプレートで作成）と `CLOUDFLARE_ACCOUNT_ID` を、Variables に `DEPLOY_ENABLED` = `true` を登録すると、`main` へのマージで自動デプロイされます。

## 確認

- ダッシュボードURLを開く → Microsoft のサインイン画面 → 社内アカウントで入れること
- 各タブで GA4 と広告の数値が出ること。エラーは赤枠で表示されます。よくある原因:
  - `GA4 API エラー (403)`: サービスアカウントがそのプロパティに追加されていない
  - `Google広告 API エラー (401/403)`: 開発者トークンがテストアクセスのまま、またはリフレッシュトークンのアカウントに権限がない
  - `Google広告 API エラー (404)`: API バージョンのサンセット。`GOOGLE_ADS_API_VERSION` を新しい版に上げる
  - `Meta広告 API エラー (400) Invalid OAuth access token`: トークンの貼り間違い、またはシステムユーザーのトークンが削除された
  - `Meta広告 API エラー (403)` / `(#10)` `(#200)`: システムユーザーにその広告アカウントの権限がない、または `ads_read` が付いていない
  - Meta広告のCVが0のまま: `metaConversionActions` が実際の計測と合っていない。広告マネージャの「結果」列で使っている指標を確認する
- Meta の Graph API はバージョンごとに約2年で使えなくなります。`META_API_VERSION`（`wrangler.jsonc`）も年に1回見直してください
- Google広告 API は毎月新バージョンが出て、各メジャー版は約1年で使えなくなります。年に1回は `GOOGLE_ADS_API_VERSION` を更新してください
