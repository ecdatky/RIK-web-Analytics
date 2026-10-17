# RIK Web解析ダッシュボード

コーポレートサイト・製品サイト・RIKシェアなどの GA4 と Google広告のデータを API で自動取得し、サイトごとのタブで確認できるダッシュボードです。各サイトの数値をもとに Claude が改善アドバイスを出します。Cloudflare Workers 上で動き、Microsoft 365（Entra ID）のアカウントでサインインします。

![画面イメージ](docs/screenshot.png)

## できること

- **サマリー**タブで全サイトの主要指標（ユーザー、キーイベント、CVR、広告費、CPA）とAIのひとことを一覧
- **サイト別タブ**
  - 今日の速報（リアルタイムの閲覧者数、今日のユーザー・セッション・キーイベント）
  - AIアドバイス（気づき・改善アクション。毎朝7時に自動更新、ボタンで作り直し）
  - GA4: 主要指標の前期間比、日別推移、チャネル・デバイス・参照元、人気ページ、ランディングページ
  - Google広告: 費用・CTR・CPC・CV・CPA の前期間比、日別の費用とCV、キャンペーン別
- 期間は 7日 / 28日 / 90日（いずれも昨日まで）。前期間は同じ日数の直前期間

## 「開いた瞬間に最新」の仕組み

1. 30分ごとの定期実行で全サイトの 7日・28日分を取得して KV に保存
2. 画面を開くと KV のデータを即表示
3. 保存から10分以上たっていれば、そのまま API から取り直して画面を差し替え（「最新データを取得中…」表示）
4. リアルタイムの閲覧者数は常に GA4 Realtime API から直接取得（1分ごと）

GA4 の集計値は処理に数時間〜1日の遅れがあり、Google広告も数時間遅れます。そのため期間集計は昨日まで、当日分は「速報」として分けています。

## 構成

```
ブラウザ ─ Cloudflare Access（Entra ID でSSO）─ Worker ─┬─ GA4 Data API（サービスアカウント）
                                                         ├─ Google Ads API（OAuth + 開発者トークン）
                                                         ├─ Claude API（AIアドバイス）
                                                         └─ KV（データとアドバイスのキャッシュ）
```

| パス | 内容 |
|---|---|
| `src/index.ts` | ルーティング、定期実行 |
| `src/service.ts` | レポート組み立て、キャッシュ |
| `src/google/ga4.ts` | GA4 Data API |
| `src/google/ads.ts` | Google Ads API（GAQL） |
| `src/ai/advice.ts` | Claude によるアドバイス生成 |
| `src/access.ts` | Cloudflare Access のトークン検証 |
| `src/demo.ts` | 認証情報が揃う前のデモデータ |
| `public/` | 画面（HTML / CSS / JS） |

## セットアップ

[docs/SETUP.md](docs/SETUP.md) を参照してください。

## ローカルで動かす

```bash
npm ci
cp .dev.vars.example .dev.vars   # デモデータ・認証なしで起動する設定
npm run dev                      # http://localhost:8787
npm test
npm run typecheck
```
