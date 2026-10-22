# セットアップ手順（ブラウザだけで進める版）

パソコンのターミナルを使わず、Cloudflare と GitHub の画面だけで公開まで進める手順です。各サービスの認証情報（GA4・Google広告・Meta・Claude）の取得方法は [SETUP.md](SETUP.md) の手順2〜6と同じなので、そちらを参照してください。この手順書は、SETUP.md の手順1（Cloudflare の準備）と手順7（シークレット登録とデプロイ）の代わりになります。

## 全体の流れ

| # | どこで | やること |
|---|---|---|
| 1 | Cloudflare | KV（データの保存場所）を作り、IDを Claude に伝える |
| 2 | Cloudflare | GitHub から自動デプロイするための APIトークンを作る |
| 3 | GitHub | APIトークンなどを登録し、PR #1 をマージする（自動でデプロイされる） |
| 4 | Cloudflare | サイト設定と各サービスの認証情報を「シークレット」として登録する |
| 5 | Cloudflare | Microsoft 365 でのサインイン（Access）を設定する |
| 6 | ブラウザ | ダッシュボードを開いて確認する |

**認証情報（トークン・鍵・パスワード）は、チャットにも GitHub のファイルにも貼らないでください。**登録先は、手順3の「GitHub の Secrets」と、手順4の「Cloudflare のシークレット」だけです。

---

## 1. KV を作る（Cloudflare）

1. https://dash.cloudflare.com/ にログインします。
2. 左のメニューから「ストレージとデータベース」→「Workers KV」を開きます。
3. 「Create instance（インスタンスを作成）」を押し、名前に `rik-web-analytics-cache` と入れて作成します。
4. 一覧に表示される **ID**（32文字の英数字）をコピーし、Claude のスレッドに貼ってください。
   - KV の ID は認証情報ではないので、チャットに貼って問題ありません。
   - Claude がプログラムの設定ファイルに反映します。反映が終わるまで、手順3のマージは待ってください。

## 2. APIトークンを作る（Cloudflare）

GitHub が Cloudflare にデプロイするための鍵です。

1. Cloudflare の右上の人型アイコン →「プロファイル」→「API トークン」を開きます。
2. 「トークンを作成する」→ テンプレート「**Cloudflare Workers を編集する**」の「テンプレートを使用する」を押します。
3. 「アカウント リソース」で自社のアカウントを選びます。「ゾーン リソース」は「すべてのゾーン」のままで構いません。
4. 「概要に進む」→「トークンを作成する」を押し、表示されたトークンをコピーします。
   - この画面を閉じると、トークンは二度と表示されません。手順3が終わるまでメモ帳に控えておき、終わったらメモは削除してください。
5. **アカウントID** も控えます。「Workers & Pages」の概要ページ右側、または URL の `dash.cloudflare.com/` の後ろの32文字です。

## 3. GitHub に登録してマージする（GitHub）

1. https://github.com/ecdatky/RIK-web-Analytics を開き、「Settings」→「Secrets and variables」→「Actions」を開きます。
2. 「Secrets」タブで「New repository secret」を押し、次の2つを登録します。

   | Name | Secret |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | 手順2のトークン |
   | `CLOUDFLARE_ACCOUNT_ID` | 手順2のアカウントID |

3. 「Variables」タブで「New repository variable」を押し、次を登録します。

   | Name | Value |
   |---|---|
   | `DEPLOY_ENABLED` | `true` |

4. Claude から「KV の ID を反映しました」と連絡が来たら、PR #1 を開いて「Ready for review」→「Merge pull request」→「Confirm merge」を押します。
5. 「Actions」タブを開き、「Deploy」が緑のチェックになれば、デプロイは完了です（2〜3分かかります）。
   - 赤い×になった場合は、その画面の文字を Claude のスレッドに貼ってください。

> GitHub の Secrets に登録した値は、リポジトリが公開設定でも外部からは見えません。

## 4. シークレットを登録する（Cloudflare）

1. Cloudflare で「Workers & Pages」→「**rik-web-analytics**」→「設定」→「変数とシークレット」を開きます。
2. 「追加」を押し、種類を「**シークレット**」にして、名前と値を入れます。下の表の分だけ繰り返し、最後に「デプロイ」を押します。

| 名前 | 値 | 取得方法 |
|---|---|---|
| `SITES_JSON` | サイト設定のJSON（下の例） | — |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | サービスアカウントのJSONファイルの中身すべて | SETUP.md 手順4 |
| `GOOGLE_ADS_CLIENT_ID` | OAuth クライアントID | SETUP.md 手順5 |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth クライアントシークレット | SETUP.md 手順5 |
| `GOOGLE_ADS_REFRESH_TOKEN` | リフレッシュトークン | SETUP.md 手順5 |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | MCC の顧客ID | SETUP.md 手順5 |
| `META_ACCESS_TOKEN` | Meta のシステムユーザーのトークン | SETUP.md 手順5-2 |
| `META_APP_SECRET` | Meta アプリの app secret（任意） | SETUP.md 手順5-2 |
| `ANTHROPIC_API_KEY` | Claude の API キー | SETUP.md 手順6 |

まだ取得できていないものは、後から追加して構いません。追加した時点で反映されます。

**SITES_JSON の例**（IDは自社のものに置き換えます）

```json
[
  { "id": "corp", "name": "コーポレートサイト", "url": "https://www.rikcorp.jp/", "ga4PropertyId": "123456789", "adsCustomerIds": ["111-111-1111"], "metaAdAccountIds": ["1234567890123456"], "goal": "問い合わせ・資料請求の獲得" },
  { "id": "product", "name": "製品サイト", "ga4PropertyId": "234567890", "adsCustomerIds": ["222-222-2222"] },
  { "id": "rikshare", "name": "RIKシェア", "ga4PropertyId": "345678901", "adsCustomerIds": ["333-333-3333"] },
  { "id": "xxx", "name": "（4つ目のサイト）", "ga4PropertyId": "456789012" }
]
```

- 記号（`"` `,` `[` `]` `{` `}`）は半角で入力します。
- 項目の間はカンマで区切ります。最後の項目の後ろにはカンマを付けません。
- Meta広告アカウントIDは、広告マネージャのURLにある `act=` の後ろの数字です。
- Google広告APIの準備がまだでも、GA4 に Google広告がリンクされていれば `"googleAdsViaGa4": true` で広告費・クリック・成果（GA4のキーイベント）を表示できます。`adsCustomerIds` がある場合はそちらが優先されます。
- SITES_JSON は登録後に中身を見られません。メモ帳などで社内に保管しておき、変更するときは丸ごと登録し直してください。

## 5. Microsoft 365 でのサインインを設定する（Cloudflare / Entra）

SETUP.md の手順2と手順3を行います。どちらもブラウザで完結します。

最後に、手順3-6のとおり「変数とシークレット」に、種類「**テキスト**」で次の2つを追加します。

| 名前 | 値 |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `<チーム名>.cloudflareaccess.com` |
| `ACCESS_AUD` | Access アプリケーションの AUD タグ |

この2つを設定するまでは、ダッシュボードを開くと「Cloudflare Access の設定が未設定です」と表示され、データは見えません。設定漏れのまま社外に公開されないようにするための仕様です。

## 6. 確認する

1. 「Workers & Pages」→「rik-web-analytics」の画面に表示される URL（`https://rik-web-analytics.<アカウント名>.workers.dev`）を開きます。
2. Microsoft のサインイン画面が出て、社内アカウントで入れることを確認します。
3. 各サイトのタブで数値が表示されることを確認します。赤枠のエラーが出た場合の原因は、SETUP.md の「確認」の項目にまとめています。

## あとから変更するとき

- **サイトや広告アカウントを増やす**：手順4で `SITES_JSON` を登録し直します。
- **トークンを更新する**：手順4で同じ名前のシークレットを上書きします。
- **プログラムの更新**：Claude が PR を作り、マージすると手順3の仕組みで自動的にデプロイされます。登録したシークレットと変数は消えません。
