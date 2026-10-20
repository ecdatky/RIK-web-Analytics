import { describe, expect, it } from "vitest";
import { eachDay, resolveRanges, todayJst } from "../src/dates";

describe("dates", () => {
  it("日本時間で日付を切り替える", () => {
    expect(todayJst(new Date("2026-10-16T14:59:00Z"))).toBe("2026-10-16");
    expect(todayJst(new Date("2026-10-16T15:00:00Z"))).toBe("2026-10-17");
  });

  it("昨日までの期間と、同じ日数の直前期間を返す", () => {
    const { current, previous } = resolveRanges("7d", "prev", new Date("2026-10-17T00:00:00Z"));
    expect(current).toEqual({ startDate: "2026-10-10", endDate: "2026-10-16" });
    expect(previous).toEqual({ startDate: "2026-10-03", endDate: "2026-10-09" });
    expect(eachDay(current)).toHaveLength(7);
    expect(eachDay(resolveRanges("28d").previous)).toHaveLength(28);
  });

  it("前年同期は同じ日付の1年前", () => {
    const { current, previous } = resolveRanges("28d", "yoy", new Date("2026-10-17T00:00:00Z"));
    expect(current).toEqual({ startDate: "2026-09-19", endDate: "2026-10-16" });
    expect(previous).toEqual({ startDate: "2025-09-19", endDate: "2025-10-16" });
  });

  it("うるう日は前年の2/28に寄せる", () => {
    const { current, previous } = resolveRanges("7d", "yoy", new Date("2028-03-01T00:00:00Z"));
    expect(current.endDate).toBe("2028-02-29");
    expect(previous.endDate).toBe("2027-02-28");
  });
});
