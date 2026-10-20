import type { DateRange, Env, MetaAd, MetaCampaign, MetaReport } from "../types";
import { eachDay } from "../dates";

// Graph API は各バージョンが約2年使える。変数 META_API_VERSION で上書きできるようにしておく。
const DEFAULT_VERSION = "v24.0";
// 「リード」は Pixel のリードとフォームのリードをまとめた集計値
const DEFAULT_CONVERSION_ACTIONS = ["lead"];

type ActionStat = { action_type?: string; value?: string };
type InsightRow = Record<string, unknown> & { actions?: ActionStat[]; action_values?: ActionStat[] };

const n = (v: unknown) => Number(v ?? 0) || 0;
const actId = (id: string) => (id.startsWith("act_") ? id : `act_${id.replace(/-/g, "")}`);

/** actions / action_values から、指定した action_type の値を合計する */
export function sumActions(list: ActionStat[] | undefined, types: string[]): number {
  if (!list) return 0;
  return list.filter((a) => a.action_type && types.includes(a.action_type)).reduce((s, a) => s + n(a.value), 0);
}

async function appSecretProof(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function insights(env: Env, accountId: string, params: Record<string, string>): Promise<InsightRow[]> {
  const token = env.META_ACCESS_TOKEN;
  if (!token) throw new Error("META_ACCESS_TOKEN が未設定です");
  const version = env.META_API_VERSION || DEFAULT_VERSION;
  const url = new URL(`https://graph.facebook.com/${version}/${actId(accountId)}/insights`);
  for (const [k, v] of Object.entries({ limit: "500", ...params })) url.searchParams.set(k, v);
  if (env.META_APP_SECRET) url.searchParams.set("appsecret_proof", await appSecretProof(token, env.META_APP_SECRET));

  const rows: InsightRow[] = [];
  let next: string | undefined = url.toString();
  // 日別×90日程度なので数ページで終わる。念のため上限を設ける
  for (let page = 0; next && page < 10; page++) {
    const res: Response = await fetch(next, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => ({}))) as { data?: InsightRow[]; paging?: { next?: string }; error?: { message?: string } };
    if (!res.ok) throw new Error(`Meta広告 API エラー (${res.status}, ${accountId}): ${(body.error?.message ?? "").slice(0, 300)}`);
    rows.push(...(body.data ?? []));
    next = body.paging?.next;
  }
  return rows;
}

const timeRange = (r: DateRange) => JSON.stringify({ since: r.startDate, until: r.endDate });

export async function fetchMeta(
  env: Env,
  accountIds: string[],
  current: DateRange,
  previous: DateRange,
  conversionActions: string[] = DEFAULT_CONVERSION_ACTIONS,
): Promise<MetaReport> {
  const cvTypes = conversionActions.length ? conversionActions : DEFAULT_CONVERSION_ACTIONS;
  const cv = (r: InsightRow) => sumActions(r.actions, cvTypes);
  const cvValue = (r: InsightRow) => sumActions(r.action_values, cvTypes);
  const base = "spend,impressions,reach,inline_link_clicks,actions,action_values";

  const perAccount = await Promise.all(
    accountIds.map(async (id) => {
      const cur = { time_range: timeRange(current) };
      const [totals, prevTotals, daily, campaigns, platforms, ads] = await Promise.all([
        insights(env, id, { ...cur, level: "account", fields: base }),
        insights(env, id, { time_range: timeRange(previous), level: "account", fields: base }),
        insights(env, id, { ...cur, level: "account", time_increment: "1", fields: "spend,inline_link_clicks,actions" }),
        insights(env, id, { ...cur, level: "campaign", fields: `campaign_id,campaign_name,objective,${base}`, sort: "spend_descending" }),
        insights(env, id, { ...cur, level: "account", breakdowns: "publisher_platform", fields: "spend,impressions,inline_link_clicks,actions" }),
        insights(env, id, { ...cur, level: "ad", fields: `ad_name,campaign_name,${base}`, sort: "spend_descending", limit: "20" }),
      ]);
      return { id, totals, prevTotals, daily, campaigns, platforms, ads };
    }),
  );

  const kpi = (f: (r: InsightRow) => number) => ({
    current: perAccount.reduce((s, a) => s + a.totals.reduce((t, r) => t + f(r), 0), 0),
    previous: perAccount.reduce((s, a) => s + a.prevTotals.reduce((t, r) => t + f(r), 0), 0),
  });

  const dailyMap = new Map(eachDay(current).map((date) => [date, { date, spend: 0, clicks: 0, conversions: 0 }]));
  for (const a of perAccount) {
    for (const r of a.daily) {
      const day = dailyMap.get(String(r.date_start ?? ""));
      if (!day) continue;
      day.spend += n(r.spend);
      day.clicks += n(r.inline_link_clicks);
      day.conversions += cv(r);
    }
  }

  const campaigns: MetaCampaign[] = perAccount
    .flatMap((a) =>
      a.campaigns.map((r) => ({
        accountId: a.id,
        id: String(r.campaign_id ?? ""),
        name: String(r.campaign_name ?? ""),
        objective: String(r.objective ?? ""),
        spend: n(r.spend),
        impressions: n(r.impressions),
        reach: n(r.reach),
        clicks: n(r.inline_link_clicks),
        conversions: cv(r),
        conversionsValue: cvValue(r),
      })),
    )
    .sort((x, y) => y.spend - x.spend)
    .slice(0, 30);

  const platformMap = new Map<string, MetaReport["platforms"][number]>();
  for (const a of perAccount) {
    for (const r of a.platforms) {
      const platform = String(r.publisher_platform ?? "unknown");
      const p = platformMap.get(platform) ?? { platform, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      p.spend += n(r.spend);
      p.impressions += n(r.impressions);
      p.clicks += n(r.inline_link_clicks);
      p.conversions += cv(r);
      platformMap.set(platform, p);
    }
  }

  const ads: MetaAd[] = perAccount
    .flatMap((a) =>
      a.ads.map((r) => ({
        name: String(r.ad_name ?? ""),
        campaign: String(r.campaign_name ?? ""),
        spend: n(r.spend),
        impressions: n(r.impressions),
        reach: n(r.reach),
        clicks: n(r.inline_link_clicks),
        conversions: cv(r),
      })),
    )
    .sort((x, y) => y.spend - x.spend)
    .slice(0, 20);

  return {
    accounts: accountIds,
    conversionActions: cvTypes,
    totals: {
      spend: kpi((r) => n(r.spend)),
      impressions: kpi((r) => n(r.impressions)),
      reach: kpi((r) => n(r.reach)),
      clicks: kpi((r) => n(r.inline_link_clicks)),
      conversions: kpi(cv),
      conversionsValue: kpi(cvValue),
    },
    daily: [...dailyMap.values()],
    campaigns,
    platforms: [...platformMap.values()].sort((x, y) => y.spend - x.spend),
    ads,
  };
}
