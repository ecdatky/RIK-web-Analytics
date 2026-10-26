import type { CompareKey, Env, RangeKey, SiteConfig } from "./types";
import { siteProfile } from "./sites";
import { isCompareKey, isRangeKey } from "./dates";
import { verifyAccess } from "./access";
import { fetchRealtime } from "./google/ga4";
import {
  adviceIsFromToday,
  getAdvice,
  getAdviceJob,
  getCachedReport,
  getDiagnosis,
  hasGoogleAds,
  isDemo,
  isStale,
  loadSites,
  purgeOldAdvice,
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

/** AIのひとことを作りながら、進み具合をイベントストリーム（data: JSON）で返す */
function adviceStream(env: Env, ctx: ExecutionContext, site: SiteConfig, range: RangeKey, compare: CompareKey, email: string): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (o: unknown) => writer.write(enc.encode(`data: ${JSON.stringify(o)}\n\n`)).catch(() => undefined);
  let last = "";
  const work = refreshAdvice(env, site, range, compare, {
    by: email,
    onProgress: (stage, pct) => {
      if (`${stage}:${pct}` === last) return;
      last = `${stage}:${pct}`;
      send({ type: "progress", stage, pct });
    },
  })
    .then(
      (advice) => send({ type: "done", advice }),
      (e) => {
        console.error("advice", site.id, e);
        return send({ type: "error", error: errMsg(e) });
      },
    )
    .finally(() => writer.close().catch(() => undefined));
  ctx.waitUntil(work);
  return new Response(readable, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
  });
}

// Google広告の画像（googlesyndication など）は広告ブロッカーや社内のフィルタで読めないことがあるので、Worker 経由で返す
const IMAGE_HOSTS = [/^tpc\.googlesyndication\.com$/, /\.googleusercontent\.com$/, /^[a-z0-9-]+\.gstatic\.com$/];

async function proxyImage(target: string | null): Promise<Response> {
  let u: URL;
  try {
    u = new URL(target ?? "");
  } catch {
    return json({ error: "u が不正です" }, 400);
  }
  if (u.protocol !== "https:" || !IMAGE_HOSTS.some((h) => h.test(u.hostname))) return json({ error: "このURLは表示できません" }, 400);
  const res = await fetch(u.toString(), { cf: { cacheTtl: 86400, cacheEverything: true } });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/")) return new Response(null, { status: 502 });
  return new Response(res.body, { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });
}

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
          // いまの状況の判定を、サイトの目的に合わせた指標で行うため
          role: siteProfile(s).role,
          sendTo: siteProfile(s).sendTo ?? [],
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
        const current = await getAdvice(env, site.id, range, compare);
        if (current && Date.now() - Date.parse(current.generatedAt) < ADVICE_COOLDOWN_MS) {
          return json({ advice: current, cooldown: true });
        }
        const running = await getAdviceJob(env, site.id, range, compare);
        if (running) return json({ job: running });
        return adviceStream(env, ctx, site, range, compare, email);
      }
      const [advice, job] = await Promise.all([getAdvice(env, site.id, range, compare), getAdviceJob(env, site.id, range, compare)]);
      return json({ advice, job });
    }

    case "/api/image":
      return proxyImage(url.searchParams.get("u"));

    case "/api/diagnosis": {
      if (!site) return json({ error: "site が不正です" }, 400);
      if (request.method === "POST") return json({ diagnosis: await refreshDiagnosis(env, site, range, compare) });
      return json({ diagnosis: await getDiagnosis(env, site, range, compare) });
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
    // 07:00 JST の実行では前日までのAIのひとことを消し、28日・直前比のものを作り直す
    const morning = event.cron === "0 22 * * *";
    // Google広告APIは Explorer 権限だと1日2,880回まで。広告アカウントを直接読むサイトの先読みは1時間おきにする
    const halfHour = new Date(event.scheduledTime).getUTCMinutes() >= 30;
    for (const site of sites) {
      for (const range of halfHour && site.adsCustomerIds?.length ? [] : WARM_RANGES) {
        ctx.waitUntil(refreshReport(env, site, range, "prev").catch((e) => console.error(site.id, range, e)));
      }
      if (morning) {
        ctx.waitUntil(
          (async () => {
            await purgeOldAdvice(env, site.id);
            if (!adviceIsFromToday(await getAdvice(env, site.id, "28d", "prev"))) await refreshAdvice(env, site);
          })().catch((e) => console.error("advice", site.id, e)),
        );
      }
    }
  },
} satisfies ExportedHandler<Env>;
