// 認証情報が揃う前でも画面を確認できるようにするためのデモデータ。
// 実データと混同しないよう、レスポンスには demo: true を付け、画面にも「デモ」と表示する。
import type { Advice, AdsReport, DateRange, Ga4Report, SiteConfig } from "./types";
import { eachDay } from "./dates";

export const DEMO_SITES: SiteConfig[] = [
  { id: "corp", name: "コーポレートサイト", url: "https://www.rikcorp.jp/", ga4PropertyId: "demo", adsCustomerIds: ["demo-1"] },
  { id: "product", name: "製品サイト", ga4PropertyId: "demo", adsCustomerIds: ["demo-2"] },
  { id: "rikshare", name: "RIKシェア", ga4PropertyId: "demo", adsCustomerIds: ["demo-3"] },
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

export function demoGa4(site: SiteConfig, current: DateRange, previous: DateRange): Ga4Report {
  const base = { corp: 900, product: 600, rikshare: 1500, other: 250 }[site.id] ?? 500;
  const daily = series(`${site.id}:cur`, current, base);
  const dailyPrevious = series(`${site.id}:prev`, previous, base * 0.92);
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

export function demoAds(site: SiteConfig, current: DateRange, previous: DateRange): AdsReport {
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
      impressions: { current: clicks * 28, previous: clicks * 26 },
      clicks: { current: clicks, previous: Math.round(clicks * 0.95) },
      cost: { current: cost, previous: Math.round(cost * 0.9) },
      conversions: { current: conv, previous: conv * 1.08 },
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
      };
    }),
  };
}

export function demoAdvice(site: SiteConfig): Advice {
  return {
    siteId: site.id,
    generatedAt: new Date().toISOString(),
    model: "demo",
    demo: true,
    summary: `（デモ表示）${site.name}はセッションが前期間比で増えていますが、コンバージョン率は下がっています。流入の質と導線を確認する時期です。`,
    findings: [
      { title: "自然検索からの流入が増加", detail: "Organic Search のセッションが全体の約半分を占め、前期間より伸びています。", tone: "good" },
      { title: "CVRが低下", detail: "セッション増に対してキーイベント数が追いついていません。", tone: "warning" },
      { title: "モバイル比率が6割超", detail: "モバイルのエンゲージメント率がデスクトップより低い可能性があります。", tone: "info" },
    ],
    actions: [
      { title: "流入上位の記事に製品導線を追加", detail: "上位ランディングページの本文中と末尾に、関連製品ページへのリンクを設置する。", priority: "high", metric: "キーイベント数" },
      { title: "一般キーワードキャンペーンの検索語句を見直す", detail: "費用比率が高いのにCVが少ないため、除外キーワードを追加する。", priority: "medium", metric: "CPA" },
    ],
  };
}
