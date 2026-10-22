import { afterEach, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { adsOAuthToken } from "../src/google/auth";
import type { Env } from "../src/types";

afterEach(() => vi.unstubAllGlobals());

describe("adsOAuthToken", () => {
  it("リフレッシュトークンが無ければ、サービスアカウントで adwords スコープのトークンを取る", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const sa = { client_email: "sa@example.iam.gserviceaccount.com", private_key: await exportPKCS8(privateKey) };
    let body: URLSearchParams | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_: string, init: RequestInit) => {
        body = new URLSearchParams(String(init.body));
        return Response.json({ access_token: "sa-token", expires_in: 3600 });
      }),
    );
    expect(await adsOAuthToken({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) } as Env)).toBe("sa-token");
    expect(body?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const claims = JSON.parse(atob(body!.get("assertion")!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.scope).toBe("https://www.googleapis.com/auth/adwords");
  });

  it("どちらも無ければ分かるエラーにする", () => {
    expect(() => adsOAuthToken({} as Env)).toThrow("Google広告の認証情報");
  });
});
