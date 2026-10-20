import type { AdsReport, DateRange, Env } from "../types";
import { eachDay } from "../dates";
import { dim, num, post, ymd, type Report, type Row } from "./ga4";

// GA4 にリンクされた Google広告の費用・クリック・表示回数（advertiserAd*）と、
// Google広告経由セッションのキーイベントを組み合わせて AdsReport を作る。
// Google広告APIの開発者トークンが無くても、広告の費用対効果をおおまかに追える。

const COST = ["advertiserAdCost", "advertiserAdClicks", "advertiserAdImpressions"].map((name) => ({ name }));
const KEY_EVENTS = [{ name: "keyEvents" }];
// Google広告のクリックから始まったセッションだけに絞る（P-MAX・ディスプレイも google / cpc になる）
const GOOGLE_CPC = {
  filter: { fieldName: "sessionSourceMedium", stringFilter: { matchType: "EXACT", value: "google / cpc" } },
};
const NOT_SET = new Set(["(not set)", "(not provided)", ""]);

type Q = { dimensions?: string[]; metrics: { name: string }[]; ranges: DateRange[]; filter?: unknown; limit?: number; order?: string };

function runner(env: Env, propertyId: string) {
  return (q: Q) =>
    post<Report>(env, `properties/${propertyId}:runReport`, {
      dateRanges: q.ranges.map((r, i) => ({ ...r, name: i ? "previous" : "current" })),
      dimensions: q.dimensions?.map((name) => ({ name })),
      metrics: q.metrics,
      dimensionFilter: q.filter,
      orderBys: q.order ? [{ metric: { metricName: q.order }, desc: true }] : undefined,
      limit: q.limit ?? 1000,
    });
}

/** 2期間指定時は先頭に dateRange ディメンションが付く */
function byPeriod(r: Report) {
  const out = new Map<string, Row>();
  for (const row of r.rows ?? []) out.set(dim(row, 0), row);
  return out;
}

/** 名前ごとに費用系とキーイベントを突き合わせる */
function joinByName(cost: Report | null, kev: Report | null) {
  const map = new Map<string, { impressions: number; clicks: number; cost: number; conversions: number }>();
  const get = (k: string) => map.get(k) ?? (map.set(k, { impressions: 0, clicks: 0, cost: 0, conversions: 0 }), map.get(k)!);
  for (const r of cost?.rows ?? []) {
    const x = get(dim(r, 0));
    x.cost += num(r, 0);
    x.clicks += num(r, 1);
    x.impressions += num(r, 2);
  }
  for (const r of kev?.rows ?? []) get(dim(r, 0)).conversions += num(r, 0);
  return [...map.entries()].filter(([k]) => !NOT_SET.has(k)).sort((a, b) => b[1].cost - a[1].cost);
}

// 補助的な内訳は、GA4側で組み合わせ不可などで失敗しても全体を止めない
const soft = (p: Promise<Report>) => p.catch(() => null);

export async function fetchAdsViaGa4(env: Env, propertyId: string, current: DateRange, previous: DateRange): Promise<AdsReport> {
  const run = runner(env, propertyId);
  const cur = [current];
  const both = [current, previous];

  const [totalsCost, totalsKev, dailyCost, dailyKev, campCost, campKev, kwCost, kwKev, qCost, qKev, devCost, devKev] =
    await Promise.all([
      run({ ranges: both, metrics: COST }),
      run({ ranges: both, metrics: KEY_EVENTS, filter: GOOGLE_CPC }),
      soft(run({ ranges: cur, dimensions: ["date"], metrics: COST })),
      soft(run({ ranges: cur, dimensions: ["date"], metrics: KEY_EVENTS, filter: GOOGLE_CPC })),
      soft(run({ ranges: cur, dimensions: ["sessionGoogleAdsCampaignName"], metrics: COST, order: "advertiserAdCost", limit: 50 })),
      soft(run({ ranges: cur, dimensions: ["sessionGoogleAdsCampaignName"], metrics: KEY_EVENTS, filter: GOOGLE_CPC, limit: 200 })),
      soft(run({ ranges: cur, dimensions: ["sessionGoogleAdsKeyword"], metrics: COST, order: "advertiserAdCost", limit: 30 })),
      soft(run({ ranges: cur, dimensions: ["sessionGoogleAdsKeyword"], metrics: KEY_EVENTS, filter: GOOGLE_CPC, limit: 500 })),
      soft(run({ ranges: cur, dimensions: ["sessionGoogleAdsQuery"], metrics: COST, order: "advertiserAdCost", limit: 40 })),
      soft(run({ ranges: cur, dimensions: ["sessionGoogleAdsQuery"], metrics: KEY_EVENTS, filter: GOOGLE_CPC, limit: 500 })),
      soft(run({ ranges: cur, dimensions: ["deviceCategory"], metrics: COST })),
      soft(run({ ranges: cur, dimensions: ["deviceCategory"], metrics: KEY_EVENTS, filter: GOOGLE_CPC })),
    ]);

  const tc = byPeriod(totalsCost);
  const tk = byPeriod(totalsKev);
  // 期間が1つだけ返る場合（片方が0件）に備えて dateRange で引く
  const pick = (m: Map<string, Row>, p: string, i: number) => {
    const row = m.get(p);
    return row ? num(row, i) : 0;
  };
  if (!tc.size) throw new Error("GA4 に Google広告の費用データがありません（Google広告とのリンクと費用データのインポートを確認してください）");

  const kpi = (i: number) => ({ current: pick(tc, "current", i), previous: pick(tc, "previous", i) });
  const totals = {
    cost: kpi(0),
    clicks: kpi(1),
    impressions: kpi(2),
    conversions: { current: pick(tk, "current", 0), previous: pick(tk, "previous", 0) },
    conversionsValue: { current: 0, previous: 0 },
  };

  const daily = new Map(eachDay(current).map((date) => [date, { date, cost: 0, clicks: 0, conversions: 0 }]));
  for (const r of dailyCost?.rows ?? []) {
    const d = daily.get(ymd(dim(r, 0)));
    if (d) {
      d.cost = num(r, 0);
      d.clicks = num(r, 1);
    }
  }
  for (const r of dailyKev?.rows ?? []) {
    const d = daily.get(ymd(dim(r, 0)));
    if (d) d.conversions = num(r, 0);
  }

  return {
    accounts: ["GA4連携"],
    source: "ga4",
    totals,
    daily: [...daily.values()],
    campaigns: joinByName(campCost, campKev)
      .slice(0, 30)
      .map(([name, x]) => ({
        accountId: "",
        id: name,
        name,
        status: "ENABLED",
        channelType: "",
        ...x,
        conversionsValue: 0,
        searchImpressionShare: null,
        searchBudgetLostIs: null,
        searchRankLostIs: null,
      })),
    devices: joinByName(devCost, devKev).map(([device, x]) => ({ device, cost: x.cost, clicks: x.clicks, conversions: x.conversions })),
    keywords: joinByName(kwCost, kwKev)
      .filter(([, x]) => x.cost > 0)
      .slice(0, 30)
      .map(([text, x]) => ({ text, matchType: "", campaign: "", impressions: x.impressions, clicks: x.clicks, cost: x.cost, conversions: x.conversions })),
    searchTerms: joinByName(qCost, qKev)
      .filter(([, x]) => x.cost > 0 || x.clicks > 0)
      .slice(0, 40)
      .map(([term, x]) => ({ term, campaign: "", impressions: x.impressions, clicks: x.clicks, cost: x.cost, conversions: x.conversions })),
  };
}
