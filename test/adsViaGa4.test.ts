import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAdsViaGa4 } from "../src/google/adsViaGa4";
import type { Env } from "../src/types";

vi.mock("../src/google/auth", () => ({ serviceAccountToken: async () => "tok" }));

afterEach(() => vi.unstubAllGlobals());

const row = (dims: string[], mets: number[]) => ({
  dimensionValues: dims.map((value) => ({ value })),
  metricValues: mets.map((v) => ({ value: String(v) })),
});

describe("fetchAdsViaGa4", () => {
  it("GA4の広告費用とGoogle広告経由のキーイベントを突き合わせる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const dim = body.dimensions?.[0]?.name as string | undefined;
        const isCost = body.metrics[0].name === "advertiserAdCost";
        if (!dim) {
          return Response.json({
            rows: isCost
              ? [row(["current"], [12000, 30, 900]), row(["previous"], [10000, 20, 800])]
              : [row(["current"], [3]), row(["previous"], [2])],
          });
        }
        if (dim === "date") return Response.json({ rows: [isCost ? row(["20261016"], [2000, 5, 100]) : row(["20261016"], [1])] });
        if (dim === "sessionGoogleAdsCampaignName") {
          return Response.json({
            rows: isCost ? [row(["指名"], [2000, 10, 100]), row(["一般"], [10000, 20, 800])] : [row(["指名"], [2]), row(["(not set)"], [5])],
          });
        }
        // デバイスは組み合わせ不可でエラーになる想定
        if (dim === "deviceCategory") return new Response("incompatible", { status: 400 });
        return Response.json({ rows: [] });
      }),
    );

    const r = await fetchAdsViaGa4({} as Env, "123", { startDate: "2026-10-10", endDate: "2026-10-16" }, { startDate: "2026-10-03", endDate: "2026-10-09" });

    expect(r.source).toBe("ga4");
    expect(r.totals.cost).toEqual({ current: 12000, previous: 10000 });
    expect(r.totals.impressions.current).toBe(900);
    expect(r.totals.conversions).toEqual({ current: 3, previous: 2 });
    expect(r.daily).toHaveLength(7);
    expect(r.daily.at(-1)).toEqual({ date: "2026-10-16", cost: 2000, clicks: 5, conversions: 1 });
    expect(r.campaigns.map((c) => [c.name, c.cost, c.conversions])).toEqual([
      ["一般", 10000, 0],
      ["指名", 2000, 2],
    ]);
    expect(r.devices).toEqual([]);
  });

  it("費用データが無ければエラーにする", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    await expect(
      fetchAdsViaGa4({} as Env, "123", { startDate: "2026-10-10", endDate: "2026-10-16" }, { startDate: "2026-10-03", endDate: "2026-10-09" }),
    ).rejects.toThrow("Google広告の費用データがありません");
  });
});
