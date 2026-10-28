import type { CompareKey, Env, RangeKey, SiteConfig } from "./types";
import { siteProfile } from "./sites";
import { isCompareKey, isRangeKey } from "./dates";
import { verifyAccess } from "./access";
import { fetchRealtime } from "./google/ga4";
import { answerQuestion, buildAskContext, normalizeTurns, type AskSiteContext } from "./ai/ask";
import {
  adviceIsFromToday,
  getAdvice,
  getAdviceJob,
  getCachedReport,
  countQuestion,
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

// 質問は1人あたり1時間にこの回数まで（API費用の暴走防止）
const ASK_LIMIT_PER_HOUR = 60;

/** 質問に答える。表示中のサイト（サマリーなら全サイト）のデータ・診断・ひとことを文脈にし、回答をイベントストリームで少しずつ返す */
async function askStream(request: Request, env: Env, ctx: ExecutionContext, sites: SiteConfig[], email: string): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { site?: string; range?: string; compare?: string; messages?: unknown } | null;
  if (!body) return json({ error: "リクエストが不正です" }, 400);
  const tab = body.site === "summary" ? "summary" : body.site;
  const scope = tab === "summary" ? sites : sites.filter((s) => s.id === tab);
  if (!scope.length) return json({ error: "site が不正です" }, 400);
  const range: RangeKey = isRangeKey(body.range ?? null) ? (body.range as RangeKey) : "28d";
  const compare: CompareKey = isCompareKey(body.compare ?? null) ? (body.compare as CompareKey) : "prev";
  let turns;
  try {
    turns = normalizeTurns(body.messages);
  } catch (e) {
    return json({ error: errMsg(e) }, 400);
  }
  if ((await countQuestion(env, email)) > ASK_LIMIT_PER_HOUR) {
    return json({ error: `質問は1時間に${ASK_LIMIT_PER_HOUR}回までです。少し時間をおいてからお試しください。` }, 429);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (o: unknown) => writer.write(enc.encode(`data: ${JSON.stringify(o)}\n\n`)).catch(() => undefined);
  const work = (async () => {
    const contexts: AskSiteContext[] = await Promise.all(
      scope.map(async (site) => {
        const report = (await getCachedReport(env, site.id, range, compare)) ?? (await refreshReport(env, site, range, compare).catch(() => null));
        const [diagnosis, advice] = await Promise.all([
          report ? getDiagnosis(env, site, range, compare).catch(() => null) : null,
          getAdvice(env, site.id, range, compare).catch(() => null),
        ]);
        return { site, report, diagnosis, advice };
      }),
    );
    if (isDemo(env) && !env.ANTHROPIC_API_KEY) {
      await send({ type: "text", text: "（デモ表示）AIの設定が無いため、サンプルの回答です。実際の画面では、表示中のサイト・期間のデータをもとにAIが答えます。" });
      return send({ type: "done" });
    }
    const context = buildAskContext({ tab: tab!, range, compare }, contexts);
    const { model } = await answerQuestion(env, context, turns, (text) => send({ type: "text", text }));
    console.log("ask", email, tab, range, compare, turns[turns.length - 1].content.slice(0, 200));
    return send({ type: "done", model });
  })()
    .catch((e) => {
      console.error("ask", e);
      return send({ type: "error", error: errMsg(e) });
    })
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

    case "/api/ask":
      if (request.method !== "POST") return json({ error: "POST で送ってください" }, 405);
      return askStream(request, env, ctx, sites, email);

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
