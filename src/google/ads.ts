import type { AdsCampaign, AdsReport, DateRange, Env } from "../types";
import { eachDay } from "../dates";
import { adsOAuthToken } from "./auth";

// Google広告APIは毎月新バージョンが出て、各メジャーは約1年でサンセットする。
// 変数 GOOGLE_ADS_API_VERSION で上書きできるようにしておく。
const DEFAULT_VERSION = "v25";

type GaqlRow = Record<string, Record<string, string | number | undefined> | undefined>;

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

function totalsQuery(r: DateRange) {
  return `SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
          FROM customer WHERE segments.date BETWEEN '${r.startDate}' AND '${r.endDate}'`;
}

export async function fetchAds(env: Env, customerIds: string[], current: DateRange, previous: DateRange): Promise<AdsReport> {
  const perAccount = await Promise.all(
    customerIds.map(async (cid) => {
      const [cur, prev, daily, campaigns] = await Promise.all([
        gaql(env, cid, totalsQuery(current)),
        gaql(env, cid, totalsQuery(previous)),
        gaql(
          env,
          cid,
          `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.conversions
           FROM customer WHERE segments.date BETWEEN '${current.startDate}' AND '${current.endDate}'`,
        ),
        gaql(
          env,
          cid,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                  metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
           FROM campaign
           WHERE segments.date BETWEEN '${current.startDate}' AND '${current.endDate}'
             AND campaign.status != 'REMOVED'
           ORDER BY metrics.cost_micros DESC
           LIMIT 20`,
        ),
      ]);
      return { cid, cur, prev, daily, campaigns };
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
  };
}
