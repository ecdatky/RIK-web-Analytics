// 認証情報が揃う前でも画面を確認できるようにするためのデモデータ。
// 実データと混同しないよう、レスポンスには demo: true を付け、画面にも「デモ」と表示する。
import type { Advice, AdsReport, CompareKey, DateRange, Ga4Report, MetaReport, RangeKey, SiteConfig } from "./types";
import { eachDay } from "./dates";

export const DEMO_SITES: SiteConfig[] = [
  { id: "corp", name: "コーポレートサイト", url: "https://www.rikcorp.jp/", ga4PropertyId: "demo", adsCustomerIds: ["demo-1"], metaAdAccountIds: ["demo-m1"] },
  { id: "product", name: "製品サイト", ga4PropertyId: "demo", adsCustomerIds: ["demo-2"] },
  { id: "rikshare", name: "RIKシェア", ga4PropertyId: "demo", adsCustomerIds: ["demo-3"], metaAdAccountIds: ["demo-m2"] },
  { id: "other", name: "その他サイト", ga4PropertyId: "demo" },
];

function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function series(seed: string, range: DateRange, base: number) {
  const r = rng(seed);
  return eachDay(range).map((date) => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6 ? 0.55 : 1;
    const users = Math.round(base * weekend * (0.8 + r() * 0.4));
    const sessions = Math.round(users * (1.2 + r() * 0.2));
    return { date, activeUsers: users, sessions, keyEvents: Math.round(sessions * (0.008 + r() * 0.01)) };
  });
}

const sumBy = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

export function demoGa4(site: SiteConfig, current: DateRange, previous: DateRange, compare: CompareKey): Ga4Report {
  const base = { corp: 900, product: 600, rikshare: 1500, other: 250 }[site.id] ?? 500;
  const daily = series(`${site.id}:cur`, current, base);
  const dailyPrevious = series(`${site.id}:${compare}`, previous, base * (compare === "yoy" ? 0.78 : 0.92));
  const r = rng(site.id);
  const k = (cur: number, prev: number) => ({ current: cur, previous: prev });
  const sessions = sumBy(daily, (x) => x.sessions);
  const prevSessions = sumBy(dailyPrevious, (x) => x.sessions);
  const users = Math.round(sumBy(daily, (x) => x.activeUsers) * 0.7);
  const prevUsers = Math.round(sumBy(dailyPrevious, (x) => x.activeUsers) * 0.7);
  const channels = [
    ["Organic Search", 0.46],
    ["Direct", 0.2],
    ["Paid Search", 0.14],
    ["Referral", 0.08],
    ["Organic Social", 0.07],
    ["Email", 0.05],
  ] as const;
  const pages =
    site.id === "rikshare"
      ? ["/", "/article/garden-diy/", "/article/exterior-color/", "/article/carport-guide/", "/article/fence-height/", "/category/garden/"]
      : ["/", "/products/", "/products/gardenplus/", "/company/", "/contact/", "/news/"];
  return {
    totals: {
      activeUsers: k(users, prevUsers),
      newUsers: k(Math.round(users * 0.78), Math.round(prevUsers * 0.8)),
      sessions: k(sessions, prevSessions),
      screenPageViews: k(Math.round(sessions * 2.3), Math.round(prevSessions * 2.4)),
      engagementRate: k(0.58 + r() * 0.05, 0.6),
      averageSessionDuration: k(95 + r() * 20, 102),
      keyEvents: k(sumBy(daily, (x) => x.keyEvents), sumBy(dailyPrevious, (x) => x.keyEvents)),
    },
    daily,
    dailyPrevious,
    channels: channels.map(([channel, share]) => ({
      channel,
      sessions: Math.round(sessions * share),
      engagementRate: 0.4 + r() * 0.35,
      keyEvents: Math.round(sessions * share * (0.005 + r() * 0.015)),
    })),
    devices: [
      { device: "mobile", sessions: Math.round(sessions * 0.62) },
      { device: "desktop", sessions: Math.round(sessions * 0.34) },
      { device: "tablet", sessions: Math.round(sessions * 0.04) },
    ],
    topPages: pages.map((path, i) => ({
      path,
      title: `${site.name} ${path === "/" ? "トップ" : path.split("/").filter(Boolean).pop()}`,
      views: Math.round((sessions * 0.5) / (i + 1)),
      users: Math.round((sessions * 0.35) / (i + 1)),
      engagementRate: 0.35 + r() * 0.45,
    })),
    landingPages: pages.map((path, i) => ({
      path,
      sessions: Math.round((sessions * 0.4) / (i + 1.3)),
      engagementRate: 0.3 + r() * 0.5,
      keyEvents: Math.round((sessions * 0.004) / (i + 1)),
    })),
    sourceMedium: [
      ["google / organic", 0.42],
      ["(direct) / (none)", 0.2],
      ["google / cpc", 0.14],
      ["yahoo / organic", 0.05],
      ["instagram / social", 0.04],
    ].map(([sm, share]) => ({
      sourceMedium: sm as string,
      sessions: Math.round(sessions * (share as number)),
      keyEvents: Math.round(sessions * (share as number) * 0.01),
    })),
    today: { activeUsers: Math.round(base * 0.4), sessions: Math.round(base * 0.5), keyEvents: Math.round(base * 0.004) },
  };
}

export function demoAds(site: SiteConfig, current: DateRange, _previous: DateRange, compare: CompareKey): AdsReport {
  const prevFactor = compare === "yoy" ? 0.75 : 0.9;
  const r = rng(`${site.id}:ads`);
  const daily = eachDay(current).map((date) => {
    const cost = Math.round(8000 + r() * 6000);
    const clicks = Math.round(cost / (90 + r() * 40));
    return { date, cost, clicks, conversions: Math.round(clicks * (0.02 + r() * 0.03) * 10) / 10 };
  });
  const cost = sumBy(daily, (x) => x.cost);
  const clicks = sumBy(daily, (x) => x.clicks);
  const conv = sumBy(daily, (x) => x.conversions);
  const names = ["指名検索", "一般キーワード_エクステリア", "P-MAX_製品", "リマーケティング", "デマンドジェネレーション"];
  return {
    accounts: site.adsCustomerIds ?? [],
    totals: {
      impressions: { current: clicks * 28, previous: Math.round(clicks * 26 * prevFactor) },
      clicks: { current: clicks, previous: Math.round(clicks * 0.95 * prevFactor) },
      cost: { current: cost, previous: Math.round(cost * prevFactor) },
      conversions: { current: conv, previous: Math.round(conv * 1.08 * prevFactor * 10) / 10 },
      conversionsValue: { current: 0, previous: 0 },
    },
    daily,
    campaigns: names.map((name, i) => {
      const share = [0.15, 0.35, 0.3, 0.12, 0.08][i];
      return {
        accountId: site.adsCustomerIds?.[0] ?? "",
        id: String(1000 + i),
        name,
        status: "ENABLED",
        channelType: i === 2 ? "PERFORMANCE_MAX" : i === 4 ? "DEMAND_GEN" : i === 3 ? "DISPLAY" : "SEARCH",
        impressions: Math.round(clicks * 28 * share),
        clicks: Math.round(clicks * share),
        cost: Math.round(cost * share),
        conversions: Math.round(conv * share * (i === 0 ? 2 : 0.8) * 10) / 10,
        conversionsValue: 0,
        searchImpressionShare: i < 2 ? [0.82, 0.41][i] : null,
        searchBudgetLostIs: i < 2 ? [0.02, 0.37][i] : null,
        searchRankLostIs: i < 2 ? [0.16, 0.22][i] : null,
      };
    }),
    devices: [
      { device: "MOBILE", cost: Math.round(cost * 0.58), clicks: Math.round(clicks * 0.64), conversions: Math.round(conv * 0.48 * 10) / 10 },
      { device: "DESKTOP", cost: Math.round(cost * 0.37), clicks: Math.round(clicks * 0.31), conversions: Math.round(conv * 0.47 * 10) / 10 },
      { device: "TABLET", cost: Math.round(cost * 0.05), clicks: Math.round(clicks * 0.05), conversions: Math.round(conv * 0.05 * 10) / 10 },
    ],
    keywords: [
      ["ユニマットリック", "EXACT", "指名検索", 0.08, 3.2],
      ["エクステリア メーカー", "PHRASE", "一般キーワード_エクステリア", 0.12, 1.1],
      ["ウッドデッキ 人工木", "BROAD", "一般キーワード_エクステリア", 0.1, 0.6],
      ["フェンス 目隠し", "PHRASE", "一般キーワード_エクステリア", 0.07, 0.4],
      ["カーポート おしゃれ", "BROAD", "一般キーワード_エクステリア", 0.06, 0],
    ].map(([text, matchType, campaign, share, cvMul]) => ({
      text: text as string,
      matchType: matchType as string,
      campaign: campaign as string,
      impressions: Math.round(clicks * 28 * (share as number)),
      clicks: Math.round(clicks * (share as number)),
      cost: Math.round(cost * (share as number)),
      conversions: Math.round(conv * (share as number) * (cvMul as number) * 10) / 10,
    })),
    searchTerms: [
      ["ユニマットリック カタログ", 0.04, 4],
      ["ウッドデッキ diy 費用", 0.05, 0],
      ["目隠しフェンス 高さ", 0.035, 0.5],
      ["カーポート 価格 相場", 0.03, 0],
      ["エクステリア 施工例", 0.025, 1],
    ].map(([term, share, cvMul]) => ({
      term: term as string,
      campaign: "一般キーワード_エクステリア",
      impressions: Math.round(clicks * 25 * (share as number)),
      clicks: Math.round(clicks * (share as number)),
      cost: Math.round(cost * (share as number)),
      conversions: Math.round(conv * (share as number) * (cvMul as number) * 10) / 10,
    })),
  };
}

export function demoMeta(site: SiteConfig, current: DateRange, compare: CompareKey): MetaReport {
  const prevFactor = compare === "yoy" ? 0.7 : 0.92;
  const r = rng(`${site.id}:meta`);
  const daily = eachDay(current).map((date) => {
    const spend = Math.round(5000 + r() * 4000);
    const clicks = Math.round(spend / (60 + r() * 30));
    return { date, spend, clicks, conversions: Math.round(clicks * (0.01 + r() * 0.02) * 10) / 10 };
  });
  const spend = sumBy(daily, (x) => x.spend);
  const clicks = sumBy(daily, (x) => x.clicks);
  const conv = sumBy(daily, (x) => x.conversions);
  const impressions = clicks * 110;
  const reach = Math.round(impressions / 2.6);
  const k = (cur: number, mul: number) => ({ current: cur, previous: Math.round(cur * mul * prevFactor) });
  const campaigns: [string, string, number, number, number][] = [
    ["リード獲得_カタログ請求", "OUTCOME_LEADS", 0.45, 1.6, 2.1],
    ["トラフィック_RIKシェア記事", "OUTCOME_TRAFFIC", 0.3, 0.4, 2.4],
    ["リターゲティング_サイト訪問者", "OUTCOME_LEADS", 0.15, 1.4, 4.2],
    ["認知_新製品動画", "OUTCOME_AWARENESS", 0.1, 0, 1.8],
  ];
  return {
    accounts: site.metaAdAccountIds ?? [],
    conversionActions: ["lead"],
    totals: {
      spend: k(spend, 0.95),
      impressions: k(impressions, 0.9),
      reach: k(reach, 0.97),
      clicks: k(clicks, 0.93),
      conversions: { current: conv, previous: Math.round(conv * 0.85 * prevFactor * 10) / 10 },
      conversionsValue: { current: 0, previous: 0 },
    },
    daily,
    campaigns: campaigns.map(([name, objective, share, cvMul, freq], i) => {
      const impr = Math.round(impressions * share);
      return {
        accountId: site.metaAdAccountIds?.[0] ?? "",
        id: String(2000 + i),
        name,
        objective,
        spend: Math.round(spend * share),
        impressions: impr,
        reach: Math.round(impr / freq),
        clicks: Math.round(clicks * share * (objective === "OUTCOME_AWARENESS" ? 0.3 : 1.1)),
        conversions: Math.round(conv * share * cvMul * 10) / 10,
        conversionsValue: 0,
      };
    }),
    platforms: [
      ["instagram", 0.58, 0.55, 0.5],
      ["facebook", 0.34, 0.38, 0.45],
      ["audience_network", 0.06, 0.05, 0.02],
      ["messenger", 0.02, 0.02, 0.03],
    ].map(([platform, s, c, cv]) => ({
      platform: platform as string,
      spend: Math.round(spend * (s as number)),
      impressions: Math.round(impressions * (s as number)),
      clicks: Math.round(clicks * (c as number)),
      conversions: Math.round(conv * (cv as number) * 10) / 10,
    })),
    ads: [
      ["カタログ請求_施工例カルーセル", "リード獲得_カタログ請求", 0.22, 0.012, 2.0],
      ["カタログ請求_静止画A", "リード獲得_カタログ請求", 0.15, 0.009, 1.2],
      ["記事_ウッドデッキDIY", "トラフィック_RIKシェア記事", 0.14, 0.016, 0.3],
      ["リタゲ_人工木デッキ", "リターゲティング_サイト訪問者", 0.1, 0.007, 1.4],
      ["カタログ請求_動画15秒", "リード獲得_カタログ請求", 0.08, 0.004, 0],
    ].map(([name, campaign, share, ctr, cvMul]) => {
      const impr = Math.round(impressions * (share as number));
      return {
        name: name as string,
        campaign: campaign as string,
        spend: Math.round(spend * (share as number)),
        impressions: impr,
        reach: Math.round(impr / 2.2),
        clicks: Math.round(impr * (ctr as number)),
        conversions: Math.round(conv * (share as number) * (cvMul as number) * 10) / 10,
      };
    }),
  };
}

export function demoAdvice(site: SiteConfig, range: RangeKey, compare: CompareKey): Advice {
  const hasAds = !!site.adsCustomerIds?.length;
  const hasMeta = !!site.metaAdAccountIds?.length;
  return {
    siteId: site.id,
    generatedAt: new Date().toISOString(),
    model: "demo",
    demo: true,
    range,
    compare,
    summary: `（サンプル）${site.name}はアクセスが伸びていますが、成果につながる割合が下がっています。${hasAds ? "広告は一般キーワードの予算配分の見直しが効きそうです。" : ""}`,
    ga4: {
      review: "（サンプル）ユーザー・セッションとも比較期間を上回り、自然検索が増加を牽引しています。一方でキーイベントは横ばいで、CVRが下がっています。",
      findings: [
        { title: "自然検索からの流入が増加", detail: "Organic Search のセッションが全体の約半分を占め、比較期間より伸びています。", tone: "good" },
        { title: "CVRが低下", detail: "セッション増に対してキーイベント数が追いついていません。", tone: "warning" },
        { title: "モバイル比率が6割超", detail: "モバイルのエンゲージメント率がデスクトップより低い可能性があります（推測）。", tone: "info" },
      ],
      actions: [
        { title: "流入上位の記事に製品導線を追加", detail: "上位ランディングページの本文中と末尾に、関連製品ページへのリンクを設置する。", priority: "high", metric: "キーイベント数" },
        { title: "モバイルの問い合わせ導線を確認", detail: "スマホ表示でCTAボタンがファーストビューに入っているか確認する。", priority: "medium", metric: "モバイルCVR" },
      ],
    },
    ads: hasAds
      ? {
          review: "（サンプル）費用は増えた一方でCVが減り、CPAが悪化しています。主因は一般キーワードキャンペーンで、予算不足による表示機会の損失も大きい状態です。",
          findings: [
            { title: "指名検索は効率良好", detail: "指名検索のCPAは全体平均の約半分で、インプレッションシェアも8割を超えています。", tone: "good" },
            { title: "一般キーワードが予算で表示を逃している", detail: "検索インプレッションシェア41%、予算による損失37%です。", tone: "warning" },
            { title: "CVのない高額検索語句", detail: "「ウッドデッキ diy 費用」「カーポート 価格 相場」は費用が掛かっているのにCVがありません。", tone: "critical" },
          ],
          actions: [
            { title: "CVのない検索語句を除外", detail: "DIY・相場系の情報収集語句を除外キーワードに追加する。", priority: "high", metric: "CPA" },
            { title: "一般キーワードの予算を再配分", detail: "除外で浮いた費用を、CVのある語句の入札・予算に回す。", priority: "medium", metric: "検索インプレッションシェア" },
          ],
        }
      : null,
    meta: hasMeta
      ? {
          review: "（サンプル）CVは比較期間より増え、CPAも改善しています。リード獲得キャンペーンが成果の大半を占める一方、リターゲティングは同じ人への表示回数が多くなっています。",
          findings: [
            { title: "Instagramが費用・CVとも最大", detail: "費用の約6割、CVの約5割がInstagramです。", tone: "info" },
            { title: "リターゲティングのフリークエンシーが高い", detail: "1人あたり約4回表示されており、広告の見飽きが起きている可能性があります（推測）。", tone: "warning" },
            { title: "動画広告にCVがない", detail: "「カタログ請求_動画15秒」は費用が掛かっているのにCVがなく、CTRも低めです。", tone: "critical" },
          ],
          actions: [
            { title: "リターゲティングの対象期間と頻度を調整", detail: "対象を直近30日の訪問者に絞り、クリエイティブを2〜3種に増やして入れ替える。", priority: "high", metric: "フリークエンシー・CPA" },
            { title: "CVのない動画広告を停止し予算を移す", detail: "施工例カルーセルなどCPAの低い広告に予算を寄せる。", priority: "medium", metric: "CPA" },
          ],
        }
      : null,
  };
}
