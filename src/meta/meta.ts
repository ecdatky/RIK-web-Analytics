import type { DateRange, Env, MetaAd, MetaCampaign, MetaDestination, MetaReport } from "../types";
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

async function graphGet(env: Env, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const token = env.META_ACCESS_TOKEN;
  if (!token) throw new Error("META_ACCESS_TOKEN が未設定です");
  const url = new URL(`https://graph.facebook.com/${env.META_API_VERSION || DEFAULT_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (env.META_APP_SECRET) url.searchParams.set("appsecret_proof", await appSecretProof(token, env.META_APP_SECRET));
  const res = await fetch(url.toString(), { headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Meta広告 API エラー (${res.status}): ${(body.error?.message ?? "").slice(0, 300)}`);
  return body;
}

type Cta = { value?: { link?: string } };
type CreativeRow = {
  image_url?: string;
  thumbnail_url?: string;
  link_url?: string;
  object_url?: string;
  object_story_spec?: { link_data?: { link?: string; call_to_action?: Cta }; video_data?: { call_to_action?: Cta } };
  asset_feed_spec?: { link_urls?: { website_url?: string }[] };
};

/** クリエイティブから、広告を押した先のURLを取り出す（画像・動画・ダイナミック広告で入る場所が違う） */
export function creativeLink(c: CreativeRow | undefined): string | undefined {
  const s = c?.object_story_spec;
  return (
    s?.link_data?.call_to_action?.value?.link ||
    s?.link_data?.link ||
    s?.video_data?.call_to_action?.value?.link ||
    c?.asset_feed_spec?.link_urls?.find((l) => l.website_url)?.website_url ||
    c?.link_url ||
    c?.object_url ||
    undefined
  );
}

const CREATIVE_FIELDS = "image_url,thumbnail_url,link_url,object_url,object_story_spec,asset_feed_spec{link_urls}";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function creativeInfo(c: CreativeRow | undefined): { imageUrl?: string; link?: string } | undefined {
  const imageUrl = c?.image_url || c?.thumbnail_url;
  const link = creativeLink(c);
  return imageUrl || link ? { ...(imageUrl && { imageUrl }), ...(link && { link }) } : undefined;
}

/**
 * 広告IDから画像URLとリンク先を引く（広告のクリエイティブを展開して1回で取る）。
 * 画像広告は image_url、動画・カルーセルなどは thumbnail_url を使う。
 * まとめて取れないときは広告ごとに取り直し、それでもだめなら画像だけを取りにいく。
 * 付加情報なので、失敗しても空で返し、理由を error に入れる
 */
export async function fetchAdCreatives(
  env: Env,
  adIds: string[],
): Promise<{ creatives: Map<string, { imageUrl?: string; link?: string }>; error?: string }> {
  const creatives = new Map<string, { imageUrl?: string; link?: string }>();
  if (!adIds.length) return { creatives };
  const size = { thumbnail_width: "600", thumbnail_height: "600" };
  try {
    const ads = (await graphGet(env, "", { ids: adIds.join(","), fields: `creative{${CREATIVE_FIELDS}}`, ...size })) as Record<string, { creative?: CreativeRow }>;
    for (const [adId, a] of Object.entries(ads)) {
      const info = creativeInfo(a?.creative);
      if (info) creatives.set(adId, info);
    }
    return { creatives };
  } catch (e) {
    console.error("meta ad creatives (batch)", errText(e));
  }
  // 1件でも見られない広告があると、まとめての取得は全体が失敗するので広告ごとに取る
  const errors: string[] = [];
  await Promise.all(
    adIds.map(async (adId) => {
      for (const fields of [CREATIVE_FIELDS, "thumbnail_url,image_url"]) {
        try {
          const a = (await graphGet(env, adId, { fields: `creative{${fields}}`, ...size })) as { creative?: CreativeRow };
          const info = creativeInfo(a.creative);
          if (info) creatives.set(adId, info);
          return;
        } catch (e) {
          errors.push(errText(e));
        }
      }
    }),
  );
  if (errors.length) console.error("meta ad creatives", errors[0]);
  return { creatives, ...(!creatives.size && errors.length && { error: errors[0] }) };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** 広告費をリンク先のドメインごとにまとめる。Peatix など外部のページに送っているかを見分けるため */
export function destinationsOf(ads: MetaAd[]): MetaDestination[] {
  const map = new Map<string, MetaDestination>();
  for (const a of ads) {
    const host = a.link ? hostOf(a.link) : "";
    if (!host) continue;
    const d = map.get(host) ?? { host, spend: 0, clicks: 0, ads: 0, example: a.link! };
    d.spend += a.spend;
    d.clicks += a.clicks;
    d.ads += 1;
    map.set(host, d);
  }
  return [...map.values()].sort((x, y) => y.spend - x.spend);
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
        insights(env, id, { ...cur, level: "ad", fields: `ad_id,ad_name,campaign_name,${base}`, sort: "spend_descending", limit: "20" }),
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

  const topAds = perAccount
    .flatMap((a) =>
      a.ads.map((r) => ({
        id: String(r.ad_id ?? ""),
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
  const { creatives, error: creativeError } = await fetchAdCreatives(env, topAds.map((a) => a.id).filter(Boolean));
  const ads: MetaAd[] = topAds.map((a) => ({ ...a, ...creatives.get(a.id) }));

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
    destinations: destinationsOf(ads),
    ...(creativeError && { creativeError }),
  };
}
