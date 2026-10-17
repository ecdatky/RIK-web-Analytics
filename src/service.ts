import type { Advice, CompareKey, Env, RangeKey, SiteConfig, SiteReport } from "./types";
import { resolveRanges, todayJst } from "./dates";
import { fetchGa4 } from "./google/ga4";
import { fetchAds } from "./google/ads";
import { fetchMeta } from "./meta/meta";
import { generateAdvice } from "./ai/advice";
import { DEMO_SITES, demoAdvice, demoAds, demoGa4, demoMeta } from "./demo";

export function isDemo(env: Env): boolean {
  return env.DEMO_MODE === "true" || !env.SITES_JSON;
}

export function loadSites(env: Env): SiteConfig[] {
  if (isDemo(env) && !env.SITES_JSON) return DEMO_SITES;
  const parsed = JSON.parse(env.SITES_JSON!) as SiteConfig[];
  if (!Array.isArray(parsed) || parsed.some((s) => !s.id || !s.name)) {
    throw new Error("SITES_JSON の形式が正しくありません（id と name が必須）");
  }
  return parsed;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** GA4・Google広告・Meta広告を並列で取りに行く。どれかが失敗しても残りは表示する */
export async function buildReport(env: Env, site: SiteConfig, range: RangeKey, compare: CompareKey): Promise<SiteReport> {
  const { current, previous } = resolveRanges(range, compare);
  const demo = isDemo(env);
  const report: SiteReport = { siteId: site.id, range, compare, current, previous, fetchedAt: new Date().toISOString(), demo };

  if (demo) {
    if (site.ga4PropertyId) report.ga4 = demoGa4(site, current, previous, compare);
    if (site.adsCustomerIds?.length) report.ads = demoAds(site, current, previous, compare);
    if (site.metaAdAccountIds?.length) report.meta = demoMeta(site, current, compare);
    return report;
  }

  await Promise.all([
    site.ga4PropertyId &&
      fetchGa4(env, site.ga4PropertyId, current, previous).then(
        (g) => (report.ga4 = g),
        (e) => (report.ga4Error = errMsg(e)),
      ),
    site.adsCustomerIds?.length &&
      fetchAds(env, site.adsCustomerIds, current, previous).then(
        (a) => (report.ads = a),
        (e) => (report.adsError = errMsg(e)),
      ),
    site.metaAdAccountIds?.length &&
      fetchMeta(env, site.metaAdAccountIds, current, previous, site.metaConversionActions).then(
        (m) => (report.meta = m),
        (e) => (report.metaError = errMsg(e)),
      ),
  ]);
  return report;
}

// ---- キャッシュ ----

const reportKey = (siteId: string, range: RangeKey, compare: CompareKey) => `report:v2:${siteId}:${range}:${compare}`;
const adviceKey = (siteId: string) => `advice:v2:${siteId}`;
// KV には長めに残し、鮮度判定は fetchedAt で行う（古いデータでも即表示 → 裏で更新）
const KV_KEEP_SECONDS = 3 * 86_400;

export function freshnessSeconds(env: Env): number {
  return Number(env.CACHE_TTL_SECONDS || 600);
}

export async function getCachedReport(env: Env, siteId: string, range: RangeKey, compare: CompareKey): Promise<SiteReport | null> {
  return env.CACHE.get<SiteReport>(reportKey(siteId, range, compare), "json");
}

export async function refreshReport(env: Env, site: SiteConfig, range: RangeKey, compare: CompareKey): Promise<SiteReport> {
  const report = await buildReport(env, site, range, compare);
  // 全部エラーの時は、前回の正常データを上書きしない
  const failed =
    (site.ga4PropertyId ? !report.ga4 : true) &&
    (site.adsCustomerIds?.length ? !report.ads : true) &&
    (site.metaAdAccountIds?.length ? !report.meta : true);
  if (!failed) await env.CACHE.put(reportKey(site.id, range, compare), JSON.stringify(report), { expirationTtl: KV_KEEP_SECONDS });
  return report;
}

export function isStale(env: Env, report: SiteReport): boolean {
  return Date.now() - Date.parse(report.fetchedAt) > freshnessSeconds(env) * 1000;
}

export async function getAdvice(env: Env, siteId: string): Promise<Advice | null> {
  return env.CACHE.get<Advice>(adviceKey(siteId), "json");
}

export async function refreshAdvice(
  env: Env,
  site: SiteConfig,
  range: RangeKey = "28d",
  compare: CompareKey = "prev",
): Promise<Advice> {
  let advice: Advice;
  if (isDemo(env) && !env.ANTHROPIC_API_KEY) {
    advice = demoAdvice(site, range, compare);
  } else {
    const report = (await getCachedReport(env, site.id, range, compare)) ?? (await refreshReport(env, site, range, compare));
    advice = await generateAdvice(env, site, report);
  }
  await env.CACHE.put(adviceKey(site.id), JSON.stringify(advice), { expirationTtl: 14 * 86_400 });
  return advice;
}

export function adviceIsFromToday(advice: Advice | null): boolean {
  return !!advice && todayJst(new Date(advice.generatedAt)) === todayJst();
}
