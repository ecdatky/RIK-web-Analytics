import { afterEach, describe, expect, it, vi } from "vitest";
import { creativeLink, fetchMeta, sumActions } from "../src/meta/meta";
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
        if (p.get("fields") === "creative") {
          return Response.json(Object.fromEntries(p.get("ids")!.split(",").map((id) => [id, { id, creative: { id: "cr1" } }])));
        }
        if (p.get("ids")) {
          expect(p.get("thumbnail_width")).toBe("600");
          return Response.json({
            cr1: { id: "cr1", thumbnail_url: "https://thumb.example/cr1.jpg", object_story_spec: { link_data: { link: "https://www.peatix.com/event/123?utm_source=meta" } } },
          });
        }
        if (p.get("level") === "ad") {
          return Response.json({ data: [{ ad_id: "ad1", ad_name: "A", campaign_name: "C", spend: "50", impressions: "200", reach: "100", inline_link_clicks: "3" }] });
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
    expect(r.ads[0]).toMatchObject({ id: "ad1", name: "A", conversions: 0, imageUrl: "https://thumb.example/cr1.jpg" });
    expect(r.ads[0].link).toBe("https://www.peatix.com/event/123?utm_source=meta");
    expect(r.destinations).toEqual([{ host: "peatix.com", spend: 100, clicks: 6, ads: 2, example: "https://www.peatix.com/event/123?utm_source=meta" }]);
    expect(r.conversionActions).toEqual(["lead"]);
    expect(urls.some((u) => u.pathname === "/v24.0/act_123/insights")).toBe(true);
    expect(urls.some((u) => u.pathname === "/v24.0/act_456/insights")).toBe(true);
    // HMAC-SHA256("tok", key="secret")
    expect(urls.every((u) => /^[0-9a-f]{64}$/.test(u.searchParams.get("appsecret_proof") ?? ""))).toBe(true);
    expect(urls[0].searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
    // 今期間と前期間は並列で取るので、順番に依存せずに両方の期間が指定されていることを見る
    const ranges = urls.map((u) => u.searchParams.get("time_range")).filter(Boolean).map((t) => JSON.parse(t!));
    expect(ranges).toContainEqual({ since: "2026-10-15", until: "2026-10-16" });
    expect(ranges).toContainEqual({ since: "2026-10-13", until: "2026-10-14" });
  });

  it("広告画像が取れなくても、レポートはそのまま返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const p = new URL(input).searchParams;
        if (p.get("ids")) return Response.json({ error: { message: "permission" } }, { status: 403 });
        if (p.get("level") === "ad") return Response.json({ data: [{ ad_id: "ad1", ad_name: "A", campaign_name: "C", spend: "50" }] });
        return Response.json({ data: [] });
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { META_ACCESS_TOKEN: "tok" } as Env;
    const r = await fetchMeta(env, ["1"], { startDate: "2026-10-15", endDate: "2026-10-16" }, { startDate: "2026-10-13", endDate: "2026-10-14" });
    expect(r.ads).toHaveLength(1);
    expect(r.ads[0].imageUrl).toBeUndefined();
  });

  it("APIエラーはアカウントIDとメッセージ付きで投げる", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Invalid OAuth access token" } }, { status: 400 })));
    await expect(
      fetchMeta({ META_ACCESS_TOKEN: "bad" } as Env, ["1"], { startDate: "2026-10-16", endDate: "2026-10-16" }, { startDate: "2026-10-15", endDate: "2026-10-15" }),
    ).rejects.toThrow("Meta広告 API エラー (400, 1): Invalid OAuth access token");
  });

  it("動画・ダイナミック広告でもリンク先を取り出す", () => {
    expect(creativeLink({ object_story_spec: { video_data: { call_to_action: { value: { link: "https://peatix.com/event/1" } } } } })).toBe("https://peatix.com/event/1");
    expect(creativeLink({ asset_feed_spec: { link_urls: [{ website_url: "https://example.com/a" }] } })).toBe("https://example.com/a");
    expect(creativeLink({ image_url: "x" })).toBeUndefined();
  });
});
