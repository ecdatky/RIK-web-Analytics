import type { CompareKey, Env, RangeKey } from "./types";
import { isCompareKey, isRangeKey } from "./dates";
import { verifyAccess } from "./access";
import { fetchRealtime } from "./google/ga4";
import {
  adviceIsFromToday,
  getAdvice,
  getCachedReport,
  getDiagnosis,
  hasGoogleAds,
  isDemo,
  isStale,
  loadSites,
  refreshAdvice,
  refreshDiagnosis,
  refreshReport,
} from "./service";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 定期実行で先読みしておく期間（90日と前年同期比は開いた時に取得）
const WARM_RANGES: RangeKey[] = ["28d", "7d"];
// AIアドバイスの再生成は1サイトにつきこの間隔以上あける（API費用の暴走防止）
const ADVICE_COOLDOWN_MS = 5 * 60_000;

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL, email: string): Promise<Response> {
  const sites = loadSites(env);
  const siteId = url.searchParams.get("site");
  const site = sites.find((s) => s.id === siteId);
  const rangeParam = url.searchParams.get("range");
  const range: RangeKey = isRangeKey(rangeParam) ? rangeParam : "28d";
  const compareParam = url.searchParams.get("compare");
  const compare: CompareKey = isCompareKey(compareParam) ? compareParam : "prev";

  switch (url.pathname) {
    case "/api/sites":
      return json({
        demo: isDemo(env),
        user: email,
        sites: sites.map((s) => ({
          id: s.id,
          name: s.name,
          url: s.url,
          hasGa4: !!s.ga4PropertyId,
          hasAds: hasGoogleAds(s),
          hasMeta: !!s.metaAdAccountIds?.length,
        })),
      });

    case "/api/report": {
      if (!site) return json({ error: "site が不正です" }, 400);
      const force = url.searchParams.get("refresh") === "1";
      if (!force) {
        const cached = await getCachedReport(env, site.id, range, compare);
        if (cached) {
          const stale = isStale(env, cached);
          // 古ければ裏で更新しておく。画面側は stale を見て最新版を取り直す
          if (stale) ctx.waitUntil(refreshReport(env, site, range, compare).catch(() => undefined));
          return json({ report: cached, stale });
        }
      }
      return json({ report: await refreshReport(env, site, range, compare), stale: false });
    }

    case "/api/realtime": {
      if (!site?.ga4PropertyId) return json({ error: "site が不正です" }, 400);
      if (isDemo(env)) {
        return json({ activeUsers: 3 + Math.floor(Math.random() * 20), pages: [], demo: true });
      }
      return json(await fetchRealtime(env, site.ga4PropertyId));
    }

    case "/api/advice": {
      if (!site) return json({ error: "site が不正です" }, 400);
      if (request.method === "POST") {
        const current = await getAdvice(env, site.id);
        if (current && Date.now() - Date.parse(current.generatedAt) < ADVICE_COOLDOWN_MS) {
          return json({ advice: current, cooldown: true });
        }
        return json({ advice: await refreshAdvice(env, site, range, compare) });
      }
      return json({ advice: await getAdvice(env, site.id) });
    }

    case "/api/diagnosis": {
      if (!site) return json({ error: "site が不正です" }, 400);
      if (request.method === "POST") return json({ diagnosis: await refreshDiagnosis(env, site) });
      return json({ diagnosis: await getDiagnosis(env, site) });
    }
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const auth = await verifyAccess(request, env);
    if (auth instanceof Response) return auth;

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, ctx, url, auth.email);
      } catch (e) {
        console.error(e);
        return json({ error: errMsg(e) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx): Promise<void> {
    const sites = loadSites(env);
    // 07:00 JST の実行ではAIアドバイスも作り直す（その日にまだ無ければ）
    const morning = event.cron === "0 22 * * *";
    for (const site of sites) {
      for (const range of WARM_RANGES) {
        ctx.waitUntil(refreshReport(env, site, range, "prev").catch((e) => console.error(site.id, range, e)));
      }
      if (morning) {
        ctx.waitUntil(
          (async () => {
            if (!adviceIsFromToday(await getAdvice(env, site.id))) await refreshAdvice(env, site);
          })().catch((e) => console.error("advice", site.id, e)),
        );
      }
    }
  },
} satisfies ExportedHandler<Env>;
