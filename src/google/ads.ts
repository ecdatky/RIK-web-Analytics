import type { AdsAd, AdsCampaign, AdsKeyword, AdsReport, AdsSearchTerm, DateRange, Env } from "../types";
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

/** "a.b.c" の形で入れ子の値を取り出す */
const pick = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
const texts = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(pick(x, "text") ?? "")).filter(Boolean) : []);
const quote = (s: string) => `'${s.replace(/'/g, "\\'")}'`;

/**
 * 広告ごとの見た目（見出し・説明文・画像）と成果。
 * 通常の広告は ad_group_ad、P-MAX は広告が無いのでアセットグループ単位で取る。
 * 取れなくてもレポート全体は返したいので、失敗時は空にする。
 */
async function fetchAdCreatives(env: Env, cid: string, between: string): Promise<AdsAd[]> {
  try {
    const [adRows, groupRows, groupAssets] = await Promise.all([
      gaql(
        env,
        cid,
        `SELECT campaign.name, ad_group.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls,
                ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
                ad_group_ad.ad.responsive_display_ad.headlines, ad_group_ad.ad.responsive_display_ad.descriptions,
                ad_group_ad.ad.responsive_display_ad.marketing_images, ad_group_ad.ad.responsive_display_ad.square_marketing_images,
                ad_group_ad.ad.image_ad.image_url,
                metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
         FROM ad_group_ad
         WHERE ${between} AND metrics.impressions > 0
         ORDER BY metrics.cost_micros DESC
         LIMIT 30`,
      ),
      gaql(
        env,
        cid,
        `SELECT campaign.name, asset_group.resource_name, asset_group.name, asset_group.final_urls,
                metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
         FROM asset_group
         WHERE ${between} AND metrics.impressions > 0
         ORDER BY metrics.cost_micros DESC
         LIMIT 20`,
      ),
      gaql(
        env,
        cid,
        `SELECT asset_group.resource_name, asset_group_asset.field_type, asset.text_asset.text, asset.image_asset.full_size.url
         FROM asset_group_asset
         WHERE asset_group_asset.field_type IN ('HEADLINE', 'DESCRIPTION', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE')
           AND asset_group_asset.status = 'ENABLED'`,
      ),
    ]);

    // レスポンシブディスプレイ広告の画像はアセット名しか返らないので、URLを別に引く
    const imageAsset = (r: GaqlRow) => {
      const list = [
        ...((pick(r, "adGroupAd.ad.responsiveDisplayAd.marketingImages") as unknown[]) ?? []),
        ...((pick(r, "adGroupAd.ad.responsiveDisplayAd.squareMarketingImages") as unknown[]) ?? []),
      ];
      return list.map((x) => String(pick(x, "asset") ?? "")).find(Boolean);
    };
    const assetNames = [...new Set(adRows.map(imageAsset).filter((x): x is string => !!x))];
    const assetUrls = new Map<string, string>();
    if (assetNames.length) {
      const rows = await gaql(
        env,
        cid,
        `SELECT asset.resource_name, asset.image_asset.full_size.url FROM asset WHERE asset.resource_name IN (${assetNames.map(quote).join(", ")})`,
      );
      for (const r of rows) assetUrls.set(String(pick(r, "asset.resourceName")), String(pick(r, "asset.imageAsset.fullSize.url") ?? ""));
    }

    const metrics = (r: GaqlRow) => ({
      impressions: n(r.metrics?.impressions),
      clicks: n(r.metrics?.clicks),
      cost: yen(r.metrics?.costMicros),
      conversions: n(r.metrics?.conversions),
    });

    const ads: AdsAd[] = adRows.map((r) => {
      const type = String(pick(r, "adGroupAd.ad.type") ?? "");
      const display = type === "RESPONSIVE_DISPLAY_AD";
      const asset = imageAsset(r);
      return {
        campaign: String(r.campaign?.name ?? ""),
        adGroup: String(r.adGroup?.name ?? ""),
        type,
        headlines: texts(pick(r, display ? "adGroupAd.ad.responsiveDisplayAd.headlines" : "adGroupAd.ad.responsiveSearchAd.headlines")),
        descriptions: texts(pick(r, display ? "adGroupAd.ad.responsiveDisplayAd.descriptions" : "adGroupAd.ad.responsiveSearchAd.descriptions")),
        imageUrl: (asset && assetUrls.get(asset)) || (pick(r, "adGroupAd.ad.imageAd.imageUrl") as string | undefined) || undefined,
        finalUrl: ((pick(r, "adGroupAd.ad.finalUrls") as string[] | undefined) ?? [])[0],
        ...metrics(r),
      };
    });

    const byGroup = new Map<string, { headlines: string[]; descriptions: string[]; images: string[] }>();
    for (const r of groupAssets) {
      const key = String(pick(r, "assetGroup.resourceName"));
      const g = byGroup.get(key) ?? { headlines: [], descriptions: [], images: [] };
      const field = String(pick(r, "assetGroupAsset.fieldType"));
      const text = pick(r, "asset.textAsset.text");
      const url = pick(r, "asset.imageAsset.fullSize.url");
      if (field === "HEADLINE" && text) g.headlines.push(String(text));
      else if (field === "DESCRIPTION" && text) g.descriptions.push(String(text));
      else if (url) g.images.push(String(url));
      byGroup.set(key, g);
    }
    for (const r of groupRows) {
      const g = byGroup.get(String(pick(r, "assetGroup.resourceName")));
      ads.push({
        campaign: String(r.campaign?.name ?? ""),
        adGroup: String(pick(r, "assetGroup.name") ?? ""),
        type: "ASSET_GROUP",
        headlines: g?.headlines ?? [],
        descriptions: g?.descriptions ?? [],
        imageUrl: g?.images[0],
        finalUrl: ((pick(r, "assetGroup.finalUrls") as string[] | undefined) ?? [])[0],
        ...metrics(r),
      });
    }
    return ads;
  } catch (e) {
    console.error("ads creatives", cid, e);
    return [];
  }
}

function totalsQuery(r: DateRange) {
  return `SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
          FROM customer WHERE segments.date BETWEEN '${r.startDate}' AND '${r.endDate}'`;
}

export async function fetchAds(env: Env, customerIds: string[], current: DateRange, previous: DateRange): Promise<AdsReport> {
  const perAccount = await Promise.all(
    customerIds.map(async (cid) => {
      const between = `segments.date BETWEEN '${current.startDate}' AND '${current.endDate}'`;
      const [cur, prev, daily, campaigns, devices, keywords, searchTerms, creatives] = await Promise.all([
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
        fetchAdCreatives(env, cid, between),
      ]);
      return { cid, cur, prev, daily, campaigns, devices, keywords, searchTerms, creatives };
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
    ads: perAccount
      .flatMap((a) => a.creatives)
      .sort((x, y) => y.cost - x.cost)
      .slice(0, 30),
  };
}
