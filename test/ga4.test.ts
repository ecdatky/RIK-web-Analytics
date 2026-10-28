import { describe, expect, it } from "vitest";
import { aiServiceOf, groupAiReferrals, groupChannels, groupLinkClicks, RIKCAD_NEWS_LABEL, rikcadNewsTotals } from "../src/google/ga4";
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

describe("AIからのアクセス", () => {
  it("参照元をAIサービスに分ける（utm_source の値も含む）", () => {
    expect(aiServiceOf("chatgpt.com")).toBe("ChatGPT");
    expect(aiServiceOf("chat.openai.com")).toBe("ChatGPT");
    expect(aiServiceOf("perplexity.ai")).toBe("Perplexity");
    expect(aiServiceOf("www.perplexity.ai")).toBe("Perplexity");
    expect(aiServiceOf("gemini.google.com")).toBe("Gemini");
    expect(aiServiceOf("copilot.microsoft.com")).toBe("Copilot");
    expect(aiServiceOf("claude.ai")).toBe("Claude");
    expect(aiServiceOf("google")).toBeNull();
    expect(aiServiceOf("youtube.com")).toBeNull();
    expect(aiServiceOf("claude-shop.example.jp")).toBeNull();
  });

  it("AI別・期間別に集計し、ユーザー数は参照元で分けない合計を使う", () => {
    const out = groupAiReferrals(
      {
        dimensionHeaders: [{ name: "sessionSource" }, { name: "dateRange" }],
        rows: [
          row(["chatgpt.com", "current"], [30, 18, 2, 25]),
          row(["chat.openai.com", "current"], [5, 3, 0, 5]),
          row(["chatgpt.com", "previous"], [20, 10, 1, 18]),
          row(["perplexity.ai", "current"], [10, 6, 0, 9]),
          row(["claude-shop.example.jp", "current"], [99, 99, 9, 99]),
        ],
      },
      { dimensionHeaders: [{ name: "dateRange" }], rows: [row(["current"], [36]), row(["previous"], [18])] },
    );
    expect(out.sessions).toEqual({ current: 45, previous: 20 });
    expect(out.activeUsers).toEqual({ current: 36, previous: 18 });
    expect(out.keyEvents).toEqual({ current: 2, previous: 1 });
    expect(out.engagementRate.current).toBeCloseTo(27 / 45);
    expect(out.services.map((s) => s.name)).toEqual(["ChatGPT", "Perplexity"]);
    expect(out.services[0]).toMatchObject({ sessions: { current: 35, previous: 20 }, sources: ["chat.openai.com", "chatgpt.com"] });
  });
});
