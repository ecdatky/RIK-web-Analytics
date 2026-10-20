import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./types";

// Cloudflare Access（Entra ID でSSO）を通過したリクエストには Cf-Access-Jwt-Assertion が付く。
// Access の設定漏れや workers.dev 経由の直アクセスに備えて、Worker 側でも署名と AUD を検証する。

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export interface AccessUser {
  email: string;
}

export async function verifyAccess(request: Request, env: Env): Promise<AccessUser | Response> {
  if (env.AUTH_DISABLED === "true") return { email: "local@dev" };

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return new Response("Cloudflare Access の設定（ACCESS_TEAM_DOMAIN / ACCESS_AUD）が未設定です", { status: 500 });
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return new Response("認証が必要です（Cloudflare Access を経由してアクセスしてください）", { status: 401 });

  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
    return { email: String(payload.email ?? "") };
  } catch {
    return new Response("認証トークンが無効です", { status: 403 });
  }
}
