import { describe, expect, it } from "vitest";
import { loadSites } from "../src/service";
import { siteProfile } from "../src/sites";
import type { Env } from "../src/types";

const base = JSON.stringify([
  { id: "corp", name: "コーポレートサイト", url: "https://www.rikcorp.jp/", ga4PropertyId: "1" },
  { id: "rikshare", name: "RIKシェア", url: "https://www.rik-support.net/share/", ga4PropertyId: "3" },
]);

describe("loadSites", () => {
  it("SITES_EXTRA_JSON のサイトを後ろに足し、同じ id は置き換える", () => {
    const env = {
      SITES_JSON: base,
      SITES_EXTRA_JSON: JSON.stringify([
        { id: "openex", name: "OPEN EX 業務管理", url: "https://open-ex.jp/", ga4PropertyId: "4", adsCampaignNameContains: "OPEN EX" },
        { id: "corp", name: "コーポ", url: "https://www.rikcorp.jp/", ga4PropertyId: "9" },
      ]),
    } as Env;
    const sites = loadSites(env);
    expect(sites.map((s) => s.id)).toEqual(["corp", "rikshare", "openex"]);
    expect(sites[0].ga4PropertyId).toBe("9");
    expect(sites[1].url).toBe("https://share.rikcorp.jp/");
  });

  it("SITES_EXTRA_JSON が空ならそのまま", () => {
    expect(loadSites({ SITES_JSON: base, SITES_EXTRA_JSON: " " } as Env)).toHaveLength(2);
  });

  it("SITES_EXTRA_JSON の形式が違えばエラー", () => {
    expect(() => loadSites({ SITES_JSON: base, SITES_EXTRA_JSON: '[{"id":"x"}]' } as Env)).toThrow("SITES_EXTRA_JSON");
  });
});

describe("siteProfile", () => {
  it("open-ex.jp は service（OPEN EX 業務管理）", () => {
    expect(siteProfile({ id: "x", url: "https://open-ex.jp/" }).role).toBe("service");
    expect(siteProfile({ id: "openex" }).role).toBe("service");
    expect(siteProfile({ id: "product" }).role).toBe("product");
  });
});
