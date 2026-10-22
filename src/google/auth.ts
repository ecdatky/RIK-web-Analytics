import { importPKCS8, SignJWT } from "jose";
import type { Env } from "../types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

// isolate 内で使い回すアクセストークン（期限の1分前まで有効とみなす）
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function cached(key: string, fetcher: () => Promise<{ token: string; expiresIn: number }>): Promise<string> {
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const { token, expiresIn } = await fetcher();
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

async function exchange(body: URLSearchParams): Promise<{ token: string; expiresIn: number }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Googleトークン取得に失敗しました: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim());
  }
  return { token: json.access_token, expiresIn: json.expires_in ?? 3600 };
}

/** GA4 Data API 用: サービスアカウントの鍵で JWT を作ってアクセストークンに交換する */
export function serviceAccountToken(env: Env, scope: string): Promise<string> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON が未設定です");
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
  return cached(`sa:${sa.client_email}:${scope}`, async () => {
    const key = await importPKCS8(sa.private_key, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(sa.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    return exchange(new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }));
  });
}

/**
 * Google広告 API 用のアクセストークン。
 * OAuth のリフレッシュトークンがあればそれを使い、無ければ GA4 と同じサービスアカウントで取る
 * （サービスアカウントのメールアドレスを Google広告のアカウントにユーザーとして追加しておく）
 */
export function adsOAuthToken(env: Env): Promise<string> {
  const { GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN } = env;
  if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GOOGLE_ADS_REFRESH_TOKEN) {
    if (env.GOOGLE_SERVICE_ACCOUNT_JSON) return serviceAccountToken(env, ADS_SCOPE);
    throw new Error("Google広告の認証情報（サービスアカウント、または OAuth の CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN）が未設定です");
  }
  return cached(`ads:${GOOGLE_ADS_CLIENT_ID}`, () =>
    exchange(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: GOOGLE_ADS_CLIENT_ID,
        client_secret: GOOGLE_ADS_CLIENT_SECRET,
        refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
      }),
    ),
  );
}
