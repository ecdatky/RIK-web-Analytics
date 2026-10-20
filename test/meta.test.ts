import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMeta, sumActions } from "../src/meta/meta";
import type { Env } from "../src/types";

afterEach(() => vi.unstubAllGlobals());

describe("sumActions", () => {
  it("指定した action_type だけを合計する", () => {
    const list = [
      { action_type: "lead", value: "3" },
      { action_type: "link_click", value: "50" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" },
    ];
    expect(sumActions(list, ["lead"])).toBe(3);
    expect(sumActions(list, ["lead", "offsite_conversion.fb_pixel_purchase"])).toBe(5);
    expect(sumActions(undefined, ["lead"])).toBe(0);
  });
});

describe("fetchMeta", () => {
  it("複数アカウントを合算し、ページングをたどり、appsecret_proof を付ける", async () => {
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        urls.push(url);
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
        const p = url.searchParams;
        const actions = [{ action_type: "lead", value: "2" }, { action_type: "link_click", value: "9" }];
        if (p.get("time_increment")) {
          // 1ページ目に次ページのURLを付けて、ページングを確認する
          if (!p.get("after")) {
            const next = new URL(url);
            next.searchParams.set("after", "x");
            return Response.json({ data: [{ date_start: "2026-10-15", spend: "100", inline_link_clicks: "5", actions }], paging: { next: next.toString() } });
          }
          return Response.json({ data: [{ date_start: "2026-10-16", spend: "200", inline_link_clicks: "7", actions }] });
        }
        if (p.get("level") === "campaign") {
          return Response.json({ data: [{ campaign_id: "1", campaign_name: "C", objective: "OUTCOME_LEADS", spend: "300", impressions: "1000", reach: "400", inline_link_clicks: "12", actions }] });
        }
        if (p.get("level") === "ad") {
          return Response.json({ data: [{ ad_name: "A", campaign_name: "C", spend: "50", impressions: "200", reach: "100", inline_link_clicks: "3" }] });
        }
        if (p.get("breakdowns")) {
          return Response.json({ data: [{ publisher_platform: "instagram", spend: "180", impressions: "600", inline_link_clicks: "8", actions }] });
        }
        return Response.json({ data: [{ spend: "300", impressions: "1000", reach: "400", inline_link_clicks: "12", actions, action_values: [{ action_type: "lead", value: "5000" }] }] });
      }),
    );

    const env = { META_ACCESS_TOKEN: "tok", META_APP_SECRET: "secret", META_API_VERSION: "v24.0" } as Env;
    const r = await fetchMeta(env, ["123", "act_456"], { startDate: "2026-10-15", endDate: "2026-10-16" }, { startDate: "2026-10-13", endDate: "2026-10-14" });

    expect(r.totals.spend).toEqual({ current: 600, previous: 600 });
    expect(r.totals.conversions.current).toBe(4);
    expect(r.totals.conversionsValue.current).toBe(10000);
    expect(r.daily).toEqual([
      { date: "2026-10-15", spend: 200, clicks: 10, conversions: 4 },
      { date: "2026-10-16", spend: 400, clicks: 14, conversions: 4 },
    ]);
    expect(r.campaigns).toHaveLength(2);
    expect(r.campaigns[0]).toMatchObject({ objective: "OUTCOME_LEADS", reach: 400, conversions: 2 });
    expect(r.platforms).toEqual([{ platform: "instagram", spend: 360, impressions: 1200, clicks: 16, conversions: 4 }]);
    expect(r.ads[0]).toMatchObject({ name: "A", conversions: 0 });
    expect(r.conversionActions).toEqual(["lead"]);
    expect(urls[0].pathname).toBe("/v24.0/act_123/insights");
    expect(urls.some((u) => u.pathname === "/v24.0/act_456/insights")).toBe(true);
    // HMAC-SHA256("tok", key="secret")
    expect(urls[0].searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(urls[0].searchParams.get("time_range")!)).toEqual({ since: "2026-10-15", until: "2026-10-16" });
  });

  it("APIエラーはアカウントIDとメッセージ付きで投げる", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Invalid OAuth access token" } }, { status: 400 })));
    await expect(
      fetchMeta({ META_ACCESS_TOKEN: "bad" } as Env, ["1"], { startDate: "2026-10-16", endDate: "2026-10-16" }, { startDate: "2026-10-15", endDate: "2026-10-15" }),
    ).rejects.toThrow("Meta広告 API エラー (400, 1): Invalid OAuth access token");
  });
});
