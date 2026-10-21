import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAds } from "../src/google/ads";
import type { Env } from "../src/types";

const env = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
  GOOGLE_ADS_CLIENT_ID: "id",
  GOOGLE_ADS_CLIENT_SECRET: "secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "111-222-3333",
} as Env;

afterEach(() => vi.unstubAllGlobals());

describe("fetchAds", () => {
  it("複数アカウントを合算し、micros を円に直す", async () => {
    const calls: { url: string; headers: Record<string, string>; query: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.includes("oauth2")) return Response.json({ access_token: "tok", expires_in: 3600 });
        const query = JSON.parse(String(init.body)).query as string;
        calls.push({ url, headers: init.headers as Record<string, string>, query });
        if (query.includes("FROM campaign")) {
          return Response.json([
            {
              results: [
                {
                  campaign: { id: "1", name: "A", status: "ENABLED", advertisingChannelType: "SEARCH" },
                  metrics: { costMicros: "5000000", clicks: "10", impressions: "100", conversions: 1, searchImpressionShare: 0.5, searchBudgetLostImpressionShare: 0.3 },
                },
              ],
            },
          ]);
        }
        if (query.includes("FROM search_term_view")) {
          return Response.json([{ results: [{ searchTermView: { searchTerm: "ウッドデッキ" }, campaign: { name: "A" }, metrics: { costMicros: "3000000", clicks: "3" } }] }]);
        }
        if (query.includes("FROM keyword_view")) {
          return Response.json([{ results: [{ adGroupCriterion: { keyword: { text: "フェンス", matchType: "PHRASE" } }, campaign: { name: "A" }, metrics: { costMicros: "1000000" } }] }]);
        }
        if (query.includes("segments.device")) {
          return Response.json([{ results: [{ segments: { device: "MOBILE" }, metrics: { costMicros: "2000000", clicks: "5", conversions: 1 } }] }]);
        }
        if (query.includes("segments.date,")) {
          return Response.json([{ results: [{ segments: { date: "2026-10-16" }, metrics: { costMicros: "1000000", clicks: "2", conversions: 0.5 } }] }]);
        }
        return Response.json([{ results: [{ metrics: { impressions: "100", clicks: "10", costMicros: "2500000", conversions: 2, conversionsValue: 0 } }] }]);
      }),
    );

    const r = await fetchAds(env, ["123-456-7890", "9876543210"], { startDate: "2026-10-10", endDate: "2026-10-16" }, { startDate: "2026-10-03", endDate: "2026-10-09" });

    expect(r.totals.cost).toEqual({ current: 5, previous: 5 });
    expect(r.totals.clicks.current).toBe(20);
    expect(r.daily).toHaveLength(7);
    expect(r.daily.at(-1)).toEqual({ date: "2026-10-16", cost: 2, clicks: 4, conversions: 1 });
    expect(r.campaigns).toHaveLength(2);
    expect(r.campaigns[0].searchImpressionShare).toBe(0.5);
    expect(r.campaigns[0].searchRankLostIs).toBeNull();
    expect(r.devices).toEqual([{ device: "MOBILE", cost: 4, clicks: 10, conversions: 2 }]);
    expect(r.searchTerms[0]).toMatchObject({ term: "ウッドデッキ", cost: 3, conversions: 0 });
    expect(r.keywords[0]).toMatchObject({ text: "フェンス", matchType: "PHRASE", cost: 1 });
    expect(calls[0].url).toContain("/customers/1234567890/googleAds:searchStream");
    expect(calls[0].headers["login-customer-id"]).toBe("1112223333");
  });

  it("広告の見出し・画像をキャンペーン別に取り、P-MAXはアセットグループ単位にする", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.includes("oauth2")) return Response.json({ access_token: "tok", expires_in: 3600 });
        const query = JSON.parse(String(init.body)).query as string;
        if (query.includes("FROM ad_group_ad")) {
          return Response.json([
            {
              results: [
                {
                  campaign: { name: "検索" },
                  adGroup: { name: "デッキ" },
                  adGroupAd: {
                    ad: {
                      type: "RESPONSIVE_SEARCH_AD",
                      finalUrls: ["https://products.rikcorp.jp/"],
                      responsiveSearchAd: { headlines: [{ text: "人工木デッキ" }, { text: "無料カタログ" }], descriptions: [{ text: "説明" }] },
                    },
                  },
                  metrics: { costMicros: "4000000", clicks: "8", impressions: "80", conversions: 1 },
                },
                {
                  campaign: { name: "ディスプレイ" },
                  adGroup: { name: "リマケ" },
                  adGroupAd: {
                    ad: { type: "RESPONSIVE_DISPLAY_AD", responsiveDisplayAd: { headlines: [{ text: "庭づくり" }], marketingImages: [{ asset: "customers/1/assets/9" }] } },
                  },
                  metrics: { costMicros: "1000000", clicks: "1", impressions: "50", conversions: 0 },
                },
              ],
            },
          ]);
        }
        if (query.includes("FROM asset_group_asset")) {
          return Response.json([
            {
              results: [
                { assetGroup: { resourceName: "ag/1" }, assetGroupAsset: { fieldType: "HEADLINE" }, asset: { textAsset: { text: "P-MAX見出し" } } },
                { assetGroup: { resourceName: "ag/1" }, assetGroupAsset: { fieldType: "MARKETING_IMAGE" }, asset: { imageAsset: { fullSize: { url: "https://img/pmax.jpg" } } } },
              ],
            },
          ]);
        }
        if (query.includes("FROM asset_group")) {
          return Response.json([
            { results: [{ campaign: { name: "P-MAX" }, assetGroup: { resourceName: "ag/1", name: "全製品" }, metrics: { costMicros: "6000000", clicks: "6", impressions: "300", conversions: 2 } }] },
          ]);
        }
        if (query.includes("FROM asset WHERE")) {
          expect(query).toContain("'customers/1/assets/9'");
          return Response.json([{ results: [{ asset: { resourceName: "customers/1/assets/9", imageAsset: { fullSize: { url: "https://img/display.jpg" } } } }] }]);
        }
        return Response.json([{ results: [] }]);
      }),
    );

    const r = await fetchAds(env, ["123"], { startDate: "2026-10-10", endDate: "2026-10-16" }, { startDate: "2026-10-03", endDate: "2026-10-09" });

    expect(r.ads?.map((a) => a.campaign)).toEqual(["P-MAX", "検索", "ディスプレイ"]);
    expect(r.ads?.[0]).toMatchObject({ type: "ASSET_GROUP", adGroup: "全製品", headlines: ["P-MAX見出し"], imageUrl: "https://img/pmax.jpg", cost: 6 });
    expect(r.ads?.[1]).toMatchObject({ headlines: ["人工木デッキ", "無料カタログ"], descriptions: ["説明"], finalUrl: "https://products.rikcorp.jp/", cost: 4 });
    expect(r.ads?.[1].imageUrl).toBeUndefined();
    expect(r.ads?.[2].imageUrl).toBe("https://img/display.jpg");
  });
});
