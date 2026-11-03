import { describe, expect, it } from "vitest";
import { diagnose } from "../src/diagnosis";
import { mergeMovedPages, siteRole, withCurrentUrl } from "../src/sites";
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
    const d = diagnose(demoReport(), DEMO_SITES[0], now);
    expect(d.checkedAt).toBe(now.toISOString());
    expect(d.period).toEqual(current);
    expect([d.range, d.compare]).toEqual(["28d", "prev"]);
    expect(d.dataFetchedAt).toBe("2026-10-20T22:00:00.000Z");
    const order = { high: 0, medium: 1, low: 2 };
    const ranks = d.items.map((i) => order[i.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    for (const i of d.items) {
      expect(i.action.length).toBeGreaterThan(0);
      expect(i.where.length).toBeGreaterThan(0);
    }
  });

  it("表示中の期間・比較をそのまま診断に記録する", () => {
    const r = { ...demoReport(), range: "7d" as const, compare: "yoy" as const };
    const d = diagnose(r);
    expect([d.range, d.compare]).toEqual(["7d", "yoy"]);
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
    expect(d.items.every((i) => i.area === "ga4" || i.area === "measure")).toBe(true);
  });

  it("Meta広告の行き先がPeatixなら、ピクセル未設置や成果0のキャンペーンとして扱わない", () => {
    const r = demoReport();
    const m = r.meta!;
    m.totals.conversions = { current: 0, previous: 0 };
    m.campaigns = m.campaigns.map((c) => ({ ...c, objective: "OUTCOME_LEADS", conversions: 0 }));
    m.destinations = [
      { host: "peatix.com", spend: 9000, clicks: 300, ads: 3, example: "https://peatix.com/event/1" },
      { host: "rikcorp.jp", spend: 1000, clicks: 20, ads: 1, example: "https://www.rikcorp.jp/" },
    ];
    const items = diagnose(r).items;
    const ids = items.map((i) => i.id);
    expect(ids).toContain("measure-meta-offsite");
    expect(ids).not.toContain("measure-meta-pixel");
    expect(ids.some((id) => id.startsWith("meta-zero-"))).toBe(false);
    expect(items.find((i) => i.id === "measure-meta-offsite")!.evidence).toContain("90.0%");

    m.destinations = [{ host: "rikcorp.jp", spend: 1000, clicks: 20, ads: 1, example: "https://www.rikcorp.jp/" }];
    expect(diagnose(r).items.map((i) => i.id)).toContain("measure-meta-pixel");
  });

  describe("サイトの目的に合わせた判定", () => {
    it("id・URLからサイトの種類を決め、診断に目的を記録する", () => {
      expect(siteRole({ id: "corp" })).toBe("corporate");
      expect(siteRole({ id: "x", url: "https://www.rikcorp.jp/" })).toBe("corporate");
      expect(siteRole({ id: "product", url: "https://products.rikcorp.jp/" })).toBe("product");
      expect(siteRole({ id: "x", url: "https://www.rik-support.net/share/" })).toBe("media");
      expect(siteRole({ id: "x", url: "https://share.rikcorp.jp/" })).toBe("media");
      expect(siteRole({ id: "corp", role: "media" })).toBe("media");
      const d = diagnose(demoReport(2), DEMO_SITES[2]);
      expect(d.role).toBe("media");
      expect(d.purpose?.kpis[0]).toContain("RIKCADお知らせ");
    });

    it("コーポレートは問い合わせ0件を優先度高にせず、送客の減少を見る", () => {
      const r = demoReport(0);
      const g = r.ga4!;
      g.totals.keyEvents = { current: 0, previous: 3 };
      g.linkClicks = [
        { domain: "products.rikcorp.jp", clicks: { current: 50, previous: 200 } },
        { domain: "peatix.com", clicks: { current: 30, previous: 30 } },
      ];
      g.totals.sessions = { current: 2000, previous: 2000 };
      const items = diagnose(r, DEMO_SITES[0]).items;
      const ids = items.map((i) => i.id);
      expect(ids).not.toContain("ga4-no-keyevents");
      expect(items.find((i) => i.id === "corp-no-contact")?.severity).toBe("low");
      expect(ids).toContain("corp-send-down");
      expect(items.find((i) => i.id === "corp-send-down")!.evidence).toContain("products.rikcorp.jp");
    });

    it("コーポレートでクリックが1件も無ければ計測の確認をすすめる", () => {
      const r = demoReport(0);
      r.ga4!.linkClicks = [];
      expect(diagnose(r, DEMO_SITES[0]).items.map((i) => i.id)).toContain("measure-corp-link-clicks");
    });

    it("RIKシェアはキーイベントを見ず、RIKCADお知らせ経由の閲覧を見る", () => {
      const r = demoReport(2);
      const g = r.ga4!;
      g.totals.keyEvents = { current: 0, previous: 0 };
      g.rikcadNews = {
        sessions: { current: 300, previous: 1000 },
        activeUsers: { current: 100, previous: 300 },
        engagementRate: { current: 0.5, previous: 0.5 },
      };
      const ids = diagnose(r, DEMO_SITES[2]).items.map((i) => i.id);
      expect(ids).not.toContain("ga4-no-keyevents");
      expect(ids).not.toContain("ga4-cvr-down");
      expect(ids).not.toContain("ga4-mobile-share");
      expect(ids).toContain("media-news-down");

      g.rikcadNews.sessions = { current: 0, previous: 1000 };
      expect(diagnose(r, DEMO_SITES[2]).items.map((i) => i.id)).toContain("measure-rikcad-news");
    });

    it("RIKシェアの移設で計測が止まっていた日を含む期間は、増減で判定しない", () => {
      const ranges = resolveRanges("7d", "prev", new Date("2026-11-03T00:00:00Z"));
      const r = { ...demoReport(2), range: "7d" as const, ...ranges };
      const g = r.ga4!;
      g.totals.activeUsers = { current: 50, previous: 800 };
      g.rikcadNews = {
        sessions: { current: 53, previous: 720 },
        activeUsers: { current: 16, previous: 244 },
        engagementRate: { current: 0.17, previous: 0.4 },
      };
      const d = diagnose(r, DEMO_SITES[2]);
      const ids = d.items.map((i) => i.id);
      expect(ids).toContain("measure-gap");
      expect(ids).not.toContain("media-news-down");
      expect(ids).not.toContain("media-users-down");
      expect(d.items.find((i) => i.id === "measure-gap")!.evidence).toContain("10/23〜11/1");

      // 移設後の日だけになれば、ふだんどおり判定する
      const later = resolveRanges("7d", "prev", new Date("2026-11-17T00:00:00Z"));
      const ids2 = diagnose({ ...r, ...later }, DEMO_SITES[2]).items.map((i) => i.id);
      expect(ids2).not.toContain("measure-gap");
      expect(ids2).toContain("media-news-down");

      // ほかのサイトには影響しない
      expect(diagnose({ ...demoReport(1), ...ranges }, DEMO_SITES[1]).items.map((i) => i.id)).not.toContain("measure-gap");
    });

    it("RIKシェアの旧URLは新URLに読み替え、/share/ 付きのページは同じ記事にまとめる", () => {
      expect(withCurrentUrl({ id: "rikshare", name: "RIKシェア", url: "https://www.rik-support.net/share/" }).url).toBe("https://share.rikcorp.jp/");
      expect(withCurrentUrl({ id: "corp", name: "コーポ", url: "https://www.rikcorp.jp/" }).url).toBe("https://www.rikcorp.jp/");
      const g = mergeMovedPages({
        ...demoReport(2).ga4!,
        topPages: [
          { path: "/share/rikcad-2d/", title: "2D", views: 300, users: 100, engagementRate: 0.5 },
          { path: "/rikcad-2d/", title: "2D", views: 100, users: 40, engagementRate: 0.3 },
          { path: "/share/", title: "トップ", views: 200, users: 80, engagementRate: 0.4 },
        ],
        landingPages: [
          { path: "/share/", sessions: 100, engagementRate: 0.4, keyEvents: 1 },
          { path: "/", sessions: 50, engagementRate: 0.1, keyEvents: 0 },
        ],
      });
      expect(g.topPages.map((p) => [p.path, p.views])).toEqual([
        ["/rikcad-2d/", 400],
        ["/", 200],
      ]);
      expect(g.topPages[0].engagementRate).toBeCloseTo(0.45);
      expect(g.landingPages).toEqual([{ path: "/", sessions: 150, engagementRate: 0.3, keyEvents: 1 }]);
    });

    it("製品サイトは今までどおり問い合わせ・資料請求で判定する", () => {
      const r = demoReport(1);
      r.ga4!.totals.keyEvents = { current: 0, previous: 5 };
      expect(diagnose(r, DEMO_SITES[1]).items.map((i) => i.id)).toContain("ga4-no-keyevents");
    });
  });
});
