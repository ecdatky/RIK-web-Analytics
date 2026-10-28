import { describe, expect, it } from "vitest";
import { buildAskContext, MAX_QUESTION_CHARS, MAX_TURNS, normalizeTurns } from "../src/ai/ask";
import { diagnose } from "../src/diagnosis";
import { resolveRanges } from "../src/dates";
import { DEMO_SITES, demoAds, demoGa4, demoMeta } from "../src/demo";
import type { SiteReport } from "../src/types";

function demoReport(siteIndex = 0): SiteReport {
  const site = DEMO_SITES[siteIndex];
  const { current, previous } = resolveRanges("28d", "prev");
  return {
    siteId: site.id,
    range: "28d",
    compare: "prev",
    current,
    previous,
    fetchedAt: new Date().toISOString(),
    demo: true,
    ga4: demoGa4(site, current, previous, "prev"),
    ads: demoAds(site, current, previous, "prev"),
    meta: demoMeta(site, current, "prev"),
  };
}

describe("質問の会話の整え方", () => {
  it("利用者の発言から始まり、利用者の質問で終わる会話にする", () => {
    const turns = normalizeTurns([
      { role: "assistant", content: "こんにちは" },
      { role: "user", content: "CPAとは？" },
      { role: "assistant", content: "1件あたりの費用です" },
      { role: "system", content: "無視される" },
      { role: "user", content: "  " },
      { role: "user", content: "今月はどう？" },
    ]);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(turns.at(-1)?.content).toBe("今月はどう？");
  });

  it("最後が質問でなければエラーにする", () => {
    expect(() => normalizeTurns([{ role: "user", content: "a" }, { role: "assistant", content: "b" }])).toThrow();
    expect(() => normalizeTurns("x")).toThrow();
  });

  it("長い会話は直近だけ、長い質問は切って渡す", () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
    const turns = normalizeTurns(many);
    expect(turns.length).toBeLessThanOrEqual(MAX_TURNS);
    expect(turns[0].role).toBe("user");
    expect(turns.at(-1)?.content).toBe("m30");
    expect(normalizeTurns([{ role: "user", content: "あ".repeat(5000) }])[0].content).toHaveLength(MAX_QUESTION_CHARS);
  });
});

describe("質問に渡す画面の文脈", () => {
  it("サイトの目的・集計データ・診断を入れる", () => {
    const site = DEMO_SITES[0];
    const report = demoReport();
    const ctx = buildAskContext({ tab: site.id, range: "28d", compare: "prev" }, [
      { site, report, diagnosis: diagnose(report, site), advice: null },
    ]);
    expect(ctx.view.compare).toBe("直前の同じ日数と比較");
    expect(ctx.sites[0].profile.kpis.length).toBeGreaterThan(0);
    expect(ctx.sites[0].report?.ga4?.totals.sessions).toBeDefined();
    expect(ctx.sites[0].report?.today).toBeDefined();
    expect(ctx.sites[0].diagnosis?.items).toBeDefined();
    expect(ctx.sites[0].advice).toBeNull();
  });

  it("データが取れなかったサイトも、目的だけは渡す", () => {
    const ctx = buildAskContext({ tab: "summary", range: "7d", compare: "yoy" }, [
      { site: DEMO_SITES[1], report: null, diagnosis: null, advice: null },
    ]);
    expect(ctx.sites[0].report).toBeNull();
    expect(ctx.sites[0].profile.purpose).toBeTruthy();
  });
});
