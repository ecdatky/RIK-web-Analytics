import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/google/auth", () => ({ serviceAccountToken: async () => "token" }));

import { isRetryable, post } from "../src/google/ga4";
import { carryOver } from "../src/service";
import type { Env, SiteReport } from "../src/types";

const env = {} as Env;
const concurrent429 = () =>
  new Response(JSON.stringify({ error: { code: 429, message: "Exhausted concurrent requests quota." } }), { status: 429 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GA4 の同時リクエスト上限", () => {
  it("同時実行数の超過だけを取り直しの対象にする", () => {
    expect(isRetryable(429, "Exhausted concurrent requests quota")).toBe(true);
    expect(isRetryable(429, "Exhausted property tokens per day")).toBe(false);
    expect(isRetryable(503, "")).toBe(true);
    expect(isRetryable(400, "")).toBe(false);
  });

  it("1プロパティの同時実行は3件まで", async () => {
    let active = 0;
    let peak = 0;
    vi.stubGlobal("fetch", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response("{}", { status: 200 });
    });
    await Promise.all(Array.from({ length: 10 }, () => post(env, "properties/1:batchRunReports", {})));
    expect(peak).toBe(3);
  });

  it("429（同時実行数）は待って取り直す", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", async () => (++calls === 1 ? concurrent429() : new Response('{"ok":1}', { status: 200 })));
    const p = post<{ ok: number }>(env, "properties/2:runReport", {});
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it("取り直しても続くときは分かる言葉で伝える", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => concurrent429());
    const p = post(env, "properties/3:runReport", {});
    const check = expect(p).rejects.toThrow("混み合って");
    await vi.runAllTimersAsync();
    await check;
  });
});

describe("carryOver", () => {
  const base = { siteId: "corp", range: "28d", compare: "prev", demo: false } as unknown as SiteReport;
  it("取れなかった部分だけ前回のデータで補い、その時刻を残す", () => {
    const prev = { ...base, fetchedAt: "2026-11-03T09:30:00Z", ga4: { totals: {} }, meta: { x: 1 } } as unknown as SiteReport;
    const now = { ...base, fetchedAt: "2026-11-03T10:00:00Z", ga4Error: "429", meta: { x: 2 } } as unknown as SiteReport;
    carryOver(now, prev);
    expect(now.ga4).toBe(prev.ga4);
    expect(now.meta).toEqual({ x: 2 });
    expect(now.carriedOver).toEqual({ ga4: "2026-11-03T09:30:00Z" });
  });

  it("前回も補ったデータなら、元の取得時刻を引き継ぐ", () => {
    const prev = { ...base, fetchedAt: "2026-11-03T09:30:00Z", carriedOver: { ga4: "2026-11-03T09:00:00Z" }, ga4: {} } as unknown as SiteReport;
    const now = { ...base, fetchedAt: "2026-11-03T10:00:00Z", ga4Error: "429" } as unknown as SiteReport;
    carryOver(now, prev);
    expect(now.carriedOver?.ga4).toBe("2026-11-03T09:00:00Z");
  });
});
