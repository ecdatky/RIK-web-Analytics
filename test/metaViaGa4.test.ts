import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMetaViaGa4 } from "../src/meta/metaViaGa4";
import type { Env } from "../src/types";

vi.mock("../src/google/auth", () => ({ serviceAccountToken: async () => "tok" }));

afterEach(() => vi.unstubAllGlobals());

const row = (dims: string[], mets: number[]) => ({
  dimensionValues: dims.map((value) => ({ value })),
  metricValues: mets.map((v) => ({ value: String(v) })),
});

describe("fetchMetaViaGa4", () => {
  it("Meta広告から来た訪問とキーイベントを2期間で返す", async () => {
    const bodies: { dimensions?: { name: string }[]; dimensionFilter: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.dimensions?.length) return Response.json({ rows: [row(["点群LP"], [100, 2]), row(["RIKCAD事例"], [300, 10])] });
        return Response.json({ rows: [row(["current"], [400, 12]), row(["previous"], [200, 3])] });
      }),
    );
    const r = await fetchMetaViaGa4({} as Env, "1", { startDate: "2026-10-10", endDate: "2026-10-16" }, { startDate: "2026-10-03", endDate: "2026-10-09" });
    expect(r.sessions).toEqual({ current: 400, previous: 200 });
    expect(r.keyEvents).toEqual({ current: 12, previous: 3 });
    expect(r.campaigns[0]).toEqual({ name: "RIKCAD事例", sessions: 300, keyEvents: 10 });
    expect(JSON.stringify(bodies[0].dimensionFilter)).toContain("sessionSource");
  });
});
