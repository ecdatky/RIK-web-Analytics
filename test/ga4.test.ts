import { describe, expect, it } from "vitest";
import { groupChannels, groupLinkClicks, RIKCAD_NEWS_LABEL, rikcadNewsTotals } from "../src/google/ga4";
import { hasRikcadNews } from "../src/service";

const row = (dims: string[], mets: number[]) => ({
  dimensionValues: dims.map((value) => ({ value })),
  metricValues: mets.map((v) => ({ value: String(v) })),
});

describe("groupChannels", () => {
  const rows = [
    row(["Unassigned", "rss"], [800, 400, 10]),
    row(["Direct", "(none)"], [500, 150, 5]),
    row(["Unassigned", "(not set)"], [20, 2, 0]),
    row(["Organic Search", "organic"], [300, 150, 9]),
  ];

  it("RIKシェアでは rss を「RIKCADお知らせ」として分け、残りは元のチャネルにまとめる", () => {
    const r = groupChannels(rows, true);
    expect(r.map((c) => c.channel)).toEqual([RIKCAD_NEWS_LABEL, "Direct", "Organic Search", "Unassigned"]);
    expect(r[0]).toEqual({ channel: RIKCAD_NEWS_LABEL, sessions: 800, engagementRate: 0.5, keyEvents: 10 });
    expect(r[3].sessions).toBe(20);
  });

  it("ほかのサイトではチャネル名をそのまま使う", () => {
    const r = groupChannels(rows, false);
    expect(r[0]).toEqual({ channel: "Unassigned", sessions: 820, engagementRate: 402 / 820, keyEvents: 10 });
  });
});

describe("hasRikcadNews", () => {
  it("RIKシェアのURLなら有効、指定があればそれに従う", () => {
    expect(hasRikcadNews({ id: "rikshare", name: "RIKシェア", url: "https://www.rik-support.net/share/" })).toBe(true);
    expect(hasRikcadNews({ id: "corp", name: "コーポ", url: "https://www.rikcorp.jp/" })).toBe(false);
    expect(hasRikcadNews({ id: "x", name: "x", rikcadNews: true })).toBe(true);
  });
});

describe("目的に合わせた指標", () => {
  const headers = [{ name: "linkDomain" }, { name: "dateRange" }];
  it("リンクのクリックを www. を除いたドメインごとに、期間別に集計する", () => {
    const out = groupLinkClicks({
      dimensionHeaders: headers,
      rows: [
        row(["products.rikcorp.jp", "current"], [120]),
        row(["products.rikcorp.jp", "previous"], [90]),
        row(["www.rik-support.net", "current"], [10]),
        row(["(not set)", "current"], [5]),
      ],
    });
    expect(out).toEqual([
      { domain: "products.rikcorp.jp", clicks: { current: 120, previous: 90 } },
      { domain: "rik-support.net", clicks: { current: 10, previous: 0 } },
    ]);
  });

  it("RIKCADお知らせの訪問を期間別に分ける", () => {
    const out = rikcadNewsTotals({
      dimensionHeaders: [{ name: "sessionMedium" }, { name: "dateRange" }],
      rows: [row(["rss", "previous"], [800, 300, 0.5]), row(["rss", "current"], [900, 320, 0.55])],
    });
    expect(out.sessions).toEqual({ current: 900, previous: 800 });
    expect(out.engagementRate).toEqual({ current: 0.55, previous: 0.5 });
  });
});
