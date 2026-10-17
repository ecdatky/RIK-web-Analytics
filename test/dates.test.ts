import { describe, expect, it } from "vitest";
import { eachDay, resolveRanges, todayJst } from "../src/dates";

describe("dates", () => {
  it("日本時間で日付を切り替える", () => {
    expect(todayJst(new Date("2026-10-16T14:59:00Z"))).toBe("2026-10-16");
    expect(todayJst(new Date("2026-10-16T15:00:00Z"))).toBe("2026-10-17");
  });

  it("昨日までの期間と、同じ日数の直前期間を返す", () => {
    const { current, previous } = resolveRanges("7d", new Date("2026-10-17T00:00:00Z"));
    expect(current).toEqual({ startDate: "2026-10-10", endDate: "2026-10-16" });
    expect(previous).toEqual({ startDate: "2026-10-03", endDate: "2026-10-09" });
    expect(eachDay(current)).toHaveLength(7);
    expect(eachDay(resolveRanges("28d").previous)).toHaveLength(28);
  });
});
