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
// advertiserAd* は広告系のディメンションと組み合わせないと GA4 が 400 を返すため、
// 費用系のクエリには必ずキャンペーン名を足して、行を合算して使う
const CAMPAIGN_DIMS = ["sessionGoogleAdsCampaignName", "sessionCampaignName"];
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

/** 費用系クエリの合計を取りつつ、このプロパティで通るキャンペーン名ディメンションを見つける */
async function probeCampaignDim(run: (q: Q) => Promise<Report>, range: DateRange) {
  let last: unknown;
  for (const d of CAMPAIGN_DIMS) {
    try {
      return { d, totals: await run({ ranges: [range], dimensions: [d], metrics: COST, limit: 10000 }) };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** 費用系の行（キャンペーン別）を合算して [費用, クリック, 表示回数] を返す */
function sumCost(r: Report) {
  const t = [0, 0, 0];
  for (const row of r.rows ?? []) for (let i = 0; i < 3; i++) t[i] += num(row, i);
  return t;
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

  const { d: campDim, totals: totalsCur } = await probeCampaignDim(run, current);
  const runCost = (q: Q) => {
    const dims = q.dimensions ?? [];
    return run({ ...q, dimensions: dims.some((x) => CAMPAIGN_DIMS.includes(x)) ? dims : [...dims, campDim] });
  };
  const [totalsPrev, totalsKev, dailyCost, dailyKev, campCost, campKev, kwCost, kwKev, qCost, qKev, devCost, devKev] =
    await Promise.all([
      soft(runCost({ ranges: [previous], metrics: COST, limit: 10000 })),
      run({ ranges: both, metrics: KEY_EVENTS, filter: GOOGLE_CPC }),
      soft(runCost({ ranges: cur, dimensions: ["date"], metrics: COST, limit: 10000 })),
      soft(run({ ranges: cur, dimensions: ["date"], metrics: KEY_EVENTS, filter: GOOGLE_CPC })),
      soft(runCost({ ranges: cur, dimensions: [campDim], metrics: COST, order: "advertiserAdCost", limit: 50 })),
      soft(run({ ranges: cur, dimensions: [campDim], metrics: KEY_EVENTS, filter: GOOGLE_CPC, limit: 200 })),
      soft(runCost({ ranges: cur, dimensions: ["sessionGoogleAdsKeyword"], metrics: COST, order: "advertiserAdCost", limit: 100 })),
      soft(run({ ranges: cur, dimensions: ["sessionGoogleAdsKeyword"], metrics: KEY_EVENTS, filter: GOOGLE_CPC, limit: 500 })),
      soft(runCost({ ranges: cur, dimensions: ["sessionGoogleAdsQuery"], metrics: COST, order: "advertiserAdCost", limit: 200 })),
      soft(run({ ranges: cur, dimensions: ["sessionGoogleAdsQuery"], metrics: KEY_EVENTS, filter: GOOGLE_CPC, limit: 500 })),
      soft(runCost({ ranges: cur, dimensions: ["deviceCategory"], metrics: COST, limit: 1000 })),
      soft(run({ ranges: cur, dimensions: ["deviceCategory"], metrics: KEY_EVENTS, filter: GOOGLE_CPC })),
    ]);

  const tk = byPeriod(totalsKev);
  const pick = (m: Map<string, Row>, p: string, i: number) => {
    const row = m.get(p);
    return row ? num(row, i) : 0;
  };
  if (!totalsCur.rows?.length) throw new Error("GA4 に Google広告の費用データがありません（Google広告とのリンクと費用データのインポートを確認してください）");
  const tcCur = sumCost(totalsCur);
  const tcPrev = totalsPrev ? sumCost(totalsPrev) : [0, 0, 0];

  const kpi = (i: number) => ({ current: tcCur[i], previous: tcPrev[i] });
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
      d.cost += num(r, 0);
      d.clicks += num(r, 1);
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
