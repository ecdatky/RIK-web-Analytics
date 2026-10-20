import type { AdsCampaign, AdsKeyword, AdsReport, AdsSearchTerm, DateRange, Env } from "../types";
import { eachDay } from "../dates";
import { adsOAuthToken } from "./auth";

// Google広告APIは毎月新バージョンが出て、各メジャーは約1年でサンセットする。
// 変数 GOOGLE_ADS_API_VERSION で上書きできるようにしておく。
const DEFAULT_VERSION = "v25";

type GaqlRow = Record<string, Record<string, unknown> | undefined>;

const clean = (id: string) => id.replace(/-/g, "");

async function gaql(env: Env, customerId: string, query: string): Promise<GaqlRow[]> {
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN が未設定です");
  const token = await adsOAuthToken(env);
  const version = env.GOOGLE_ADS_API_VERSION || DEFAULT_VERSION;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
    "content-type": "application/json",
  };
  if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) headers["login-customer-id"] = clean(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);

  const res = await fetch(`https://googleads.googleapis.com/${version}/customers/${clean(customerId)}/googleAds:searchStream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google広告 API エラー (${res.status}, ${customerId}): ${text.slice(0, 300)}`);
  }
  const batches = (await res.json()) as { results?: GaqlRow[] }[];
  return batches.flatMap((b) => b.results ?? []);
}

const n = (v: unknown) => Number(v ?? 0);
const yen = (micros: unknown) => n(micros) / 1_000_000;
// インプレッションシェアは対象外のキャンペーン（P-MAX等）だと値が入らない
const share = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));

function totalsQuery(r: DateRange) {
  return `SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
          FROM customer WHERE segments.date BETWEEN '${r.startDate}' AND '${r.endDate}'`;
}

export async function fetchAds(env: Env, customerIds: string[], current: DateRange, previous: DateRange): Promise<AdsReport> {
  const perAccount = await Promise.all(
    customerIds.map(async (cid) => {
      const between = `segments.date BETWEEN '${current.startDate}' AND '${current.endDate}'`;
      const [cur, prev, daily, campaigns, devices, keywords, searchTerms] = await Promise.all([
        gaql(env, cid, totalsQuery(current)),
        gaql(env, cid, totalsQuery(previous)),
        gaql(env, cid, `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.conversions FROM customer WHERE ${between}`),
        gaql(
          env,
          cid,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                  metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value,
                  metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
           FROM campaign
           WHERE ${between} AND campaign.status != 'REMOVED'
           ORDER BY metrics.cost_micros DESC
           LIMIT 20`,
        ),
        gaql(
          env,
          cid,
          `SELECT segments.device, metrics.cost_micros, metrics.clicks, metrics.conversions FROM customer WHERE ${between}`,
        ),
        gaql(
          env,
          cid,
          `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, campaign.name,
                  metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
           FROM keyword_view
           WHERE ${between} AND metrics.impressions > 0
           ORDER BY metrics.cost_micros DESC
           LIMIT 20`,
        ),
        gaql(
          env,
          cid,
          `SELECT search_term_view.search_term, campaign.name,
                  metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
           FROM search_term_view
           WHERE ${between}
           ORDER BY metrics.cost_micros DESC
           LIMIT 30`,
        ),
      ]);
      return { cid, cur, prev, daily, campaigns, devices, keywords, searchTerms };
    }),
  );

  const sum = (rows: GaqlRow[], field: string, conv: (v: unknown) => number = n) =>
    rows.reduce((s, r) => s + conv(r.metrics?.[field]), 0);
  const kpi = (field: string, conv: (v: unknown) => number = n) => ({
    current: perAccount.reduce((s, a) => s + sum(a.cur, field, conv), 0),
    previous: perAccount.reduce((s, a) => s + sum(a.prev, field, conv), 0),
  });

  const dailyMap = new Map(eachDay(current).map((date) => [date, { date, cost: 0, clicks: 0, conversions: 0 }]));
  for (const a of perAccount) {
    for (const r of a.daily) {
      const day = dailyMap.get(String(r.segments?.date ?? ""));
      if (!day) continue;
      day.cost += yen(r.metrics?.costMicros);
      day.clicks += n(r.metrics?.clicks);
      day.conversions += n(r.metrics?.conversions);
    }
  }

  const campaigns: AdsCampaign[] = perAccount
    .flatMap((a) =>
      a.campaigns.map((r) => ({
        accountId: a.cid,
        id: String(r.campaign?.id ?? ""),
        name: String(r.campaign?.name ?? ""),
        status: String(r.campaign?.status ?? ""),
        channelType: String(r.campaign?.advertisingChannelType ?? ""),
        impressions: n(r.metrics?.impressions),
        clicks: n(r.metrics?.clicks),
        cost: yen(r.metrics?.costMicros),
        conversions: n(r.metrics?.conversions),
        conversionsValue: n(r.metrics?.conversionsValue),
        searchImpressionShare: share(r.metrics?.searchImpressionShare),
        searchBudgetLostIs: share(r.metrics?.searchBudgetLostImpressionShare),
        searchRankLostIs: share(r.metrics?.searchRankLostImpressionShare),
      })),
    )
    .sort((x, y) => y.cost - x.cost)
    .slice(0, 30);

  const deviceMap = new Map<string, { device: string; cost: number; clicks: number; conversions: number }>();
  for (const a of perAccount) {
    for (const r of a.devices) {
      const device = String(r.segments?.device ?? "UNKNOWN");
      const d = deviceMap.get(device) ?? { device, cost: 0, clicks: 0, conversions: 0 };
      d.cost += yen(r.metrics?.costMicros);
      d.clicks += n(r.metrics?.clicks);
      d.conversions += n(r.metrics?.conversions);
      deviceMap.set(device, d);
    }
  }

  const keywords: AdsKeyword[] = perAccount
    .flatMap((a) =>
      a.keywords.map((r) => {
        const kw = (r.adGroupCriterion as { keyword?: { text?: string; matchType?: string } } | undefined)?.keyword;
        return {
          text: String(kw?.text ?? ""),
          matchType: String(kw?.matchType ?? ""),
          campaign: String(r.campaign?.name ?? ""),
          impressions: n(r.metrics?.impressions),
          clicks: n(r.metrics?.clicks),
          cost: yen(r.metrics?.costMicros),
          conversions: n(r.metrics?.conversions),
        };
      }),
    )
    .sort((x, y) => y.cost - x.cost)
    .slice(0, 20);

  const searchTerms: AdsSearchTerm[] = perAccount
    .flatMap((a) =>
      a.searchTerms.map((r) => ({
        term: String(r.searchTermView?.searchTerm ?? ""),
        campaign: String(r.campaign?.name ?? ""),
        impressions: n(r.metrics?.impressions),
        clicks: n(r.metrics?.clicks),
        cost: yen(r.metrics?.costMicros),
        conversions: n(r.metrics?.conversions),
      })),
    )
    .sort((x, y) => y.cost - x.cost)
    .slice(0, 30);

  return {
    accounts: customerIds,
    totals: {
      impressions: kpi("impressions"),
      clicks: kpi("clicks"),
      cost: kpi("costMicros", yen),
      conversions: kpi("conversions"),
      conversionsValue: kpi("conversionsValue"),
    },
    daily: [...dailyMap.values()],
    campaigns,
    devices: [...deviceMap.values()].sort((x, y) => y.cost - x.cost),
    keywords,
    searchTerms,
  };
}
