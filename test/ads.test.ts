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
            { results: [{ campaign: { id: "1", name: "A", status: "ENABLED", advertisingChannelType: "SEARCH" }, metrics: { costMicros: "5000000", clicks: "10", impressions: "100", conversions: 1 } }] },
          ]);
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
    expect(calls[0].url).toContain("/customers/1234567890/googleAds:searchStream");
    expect(calls[0].headers["login-customer-id"]).toBe("1112223333");
  });
});
