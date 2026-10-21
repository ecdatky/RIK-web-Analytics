import { describe, expect, it } from "vitest";
import { diagnose } from "../src/diagnosis";
import { resolveRanges } from "../src/dates";
import { DEMO_SITES, demoAds, demoGa4, demoMeta } from "../src/demo";
import type { AdsReport, SiteReport } from "../src/types";

const { current, previous } = resolveRanges("28d", "prev", new Date("2026-10-21T00:00:00Z"));

function demoReport(siteIndex = 0): SiteReport {
  const site = DEMO_SITES[siteIndex];
  return {
    siteId: site.id,
    range: "28d",
    compare: "prev",
    current,
    previous,
    fetchedAt: "2026-10-20T22:00:00.000Z",
    demo: true,
    ga4: site.ga4PropertyId ? demoGa4(site, current, previous, "prev") : undefined,
    ads: demoAds(site, current, previous, "prev"),
    meta: demoMeta(site, current, "prev"),
  };
}

describe("diagnose", () => {
  it("診断日時・対象期間を記録し、優先度の高い順に並べる", () => {
    const now = new Date("2026-10-21T01:23:00Z");
    const d = diagnose(demoReport(), now);
    expect(d.checkedAt).toBe(now.toISOString());
    expect(d.period).toEqual(current);
    expect(d.dataFetchedAt).toBe("2026-10-20T22:00:00.000Z");
    const order = { high: 0, medium: 1, low: 2 };
    const ranks = d.items.map((i) => order[i.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    for (const i of d.items) {
      expect(i.action.length).toBeGreaterThan(0);
      expect(i.where.length).toBeGreaterThan(0);
    }
  });

  it("成果0のキャンペーンと、スマホへの費用の偏りを見つける", () => {
    const r = demoReport();
    const ads = r.ads as AdsReport;
    ads.totals.cost = { current: 100_000, previous: 100_000 };
    ads.totals.conversions = { current: 10, previous: 10 };
    ads.totals.clicks = { current: 50, previous: 50 };
    ads.campaigns = [
      { ...ads.campaigns[0], name: "良いキャンペーン", cost: 70_000, clicks: 30, conversions: 10 },
      { ...ads.campaigns[0], name: "成果なし", cost: 30_000, clicks: 20, conversions: 0 },
    ];
    ads.devices = [
      { ...ads.devices[0], device: "mobile", cost: 60_000, clicks: 30, conversions: 1 },
      { ...ads.devices[0], device: "desktop", cost: 40_000, clicks: 20, conversions: 9 },
    ];
    ads.searchTerms = [];
    const ids = diagnose(r).items.map((i) => i.id);
    expect(ids).toContain("ads-zero-成果なし");
    expect(ids).toContain("ads-device-mobile");
  });

  it("広告が無いサイトでは広告の診断を出さない", () => {
    const r = demoReport();
    delete r.ads;
    delete r.meta;
    const d = diagnose(r);
    expect(d.items.every((i) => i.area === "ga4")).toBe(true);
  });
});
