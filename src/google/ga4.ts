import type { DateRange, Env, Ga4Report, Kpi } from "../types";
import { eachDay, todayJst } from "../dates";
import { serviceAccountToken } from "./auth";

const BASE = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export interface Row {
  dimensionValues?: { value: string }[];
  metricValues?: { value: string }[];
}
export interface Report {
  dimensionHeaders?: { name: string }[];
  rows?: Row[];
}

const TOTAL_METRICS = [
  "activeUsers",
  "newUsers",
  "sessions",
  "screenPageViews",
  "engagementRate",
  "averageSessionDuration",
  "keyEvents",
] as const;

const m = (name: string) => ({ name });
const d = (name: string) => ({ name });
export const num = (r: Row, i: number) => Number(r.metricValues?.[i]?.value ?? 0);
export const dim = (r: Row, i: number) => r.dimensionValues?.[i]?.value ?? "";
export const ymd = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;

// GA4 Data API は1プロパティあたり同時10リクエストまで（超えると 429 "Exhausted concurrent requests quota"）。
// 定期の先読み・画面からの取り直し・リアルタイムが重なっても超えないよう、1プロパティの同時実行数を抑える
const MAX_CONCURRENT_PER_PROPERTY = 3;
const RETRY_DELAYS_MS = [1000, 2500, 5000];

const running = new Map<string, number>();
const waiting = new Map<string, (() => void)[]>();

async function acquire(key: string): Promise<void> {
  if ((running.get(key) ?? 0) < MAX_CONCURRENT_PER_PROPERTY) {
    running.set(key, (running.get(key) ?? 0) + 1);
    return;
  }
  await new Promise<void>((resolve) => {
    const q = waiting.get(key) ?? [];
    q.push(resolve);
    waiting.set(key, q);
  });
}

function release(key: string): void {
  const next = waiting.get(key)?.shift();
  if (next) return next(); // 枠をそのまま次に渡す
  const n = (running.get(key) ?? 1) - 1;
  if (n > 0) running.set(key, n);
  else running.delete(key);
}

/** 混み合いによる一時的なエラー（同時実行数の超過・一時的な不調）か */
export function isRetryable(status: number, text: string): boolean {
  if (status === 503 || status === 500) return true;
  // 1日・1時間のトークン上限は待っても回復しないので取り直さない
  return status === 429 && /concurrent/i.test(text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function post<T>(env: Env, path: string, body: unknown): Promise<T> {
  const key = path.split(":")[0]; // properties/123
  for (let attempt = 0; ; attempt++) {
    await acquire(key);
    let res: Response;
    let text = "";
    try {
      const token = await serviceAccountToken(env, SCOPE);
      res = await fetch(`${BASE}/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;
      text = await res.text();
    } finally {
      release(key);
    }
    if (attempt < RETRY_DELAYS_MS.length && isRetryable(res.status, text)) {
      // 少しずらして待ってから取り直す（他のリクエストの完了を待つ）
      await sleep(RETRY_DELAYS_MS[attempt] * (0.75 + Math.random() * 0.5));
      continue;
    }
    if (res.status === 429 && /concurrent/i.test(text)) {
      throw new Error("GA4 が混み合っていて取得できませんでした（同時に取得できる上限を超えました）。少し待って「最新に更新」を押してください。");
    }
    throw new Error(`GA4 API エラー (${res.status}): ${text.slice(0, 300)}`);
  }
}

function dailySeries(report: Report, range: DateRange) {
  const byDate = new Map<string, Row>();
  for (const r of report.rows ?? []) byDate.set(ymd(dim(r, 0)), r);
  // データがない日も0で埋めてグラフを途切れさせない
  return eachDay(range).map((date) => {
    const r = byDate.get(date);
    return { date, activeUsers: r ? num(r, 0) : 0, sessions: r ? num(r, 1) : 0, keyEvents: r ? num(r, 2) : 0 };
  });
}

/** RIKCAD起動時の「お知らせ」(NewsViewer.exe) が開く記事リンクには WordPress が utm_medium=rss を付ける */
export const RIKCAD_NEWS_LABEL = "RIKCADお知らせ";

/** チャネル × メディアの行を集計する。rikcadNews のときは medium=rss を「RIKCADお知らせ」として別チャネルに分ける */
export function groupChannels(rows: Row[], rikcadNews: boolean): Ga4Report["channels"] {
  const acc = new Map<string, { sessions: number; engaged: number; keyEvents: number }>();
  for (const r of rows) {
    const channel = rikcadNews && dim(r, 1) === "rss" ? RIKCAD_NEWS_LABEL : dim(r, 0);
    const a = acc.get(channel) ?? { sessions: 0, engaged: 0, keyEvents: 0 };
    a.sessions += num(r, 0);
    a.engaged += num(r, 1);
    a.keyEvents += num(r, 2);
    acc.set(channel, a);
  }
  return [...acc]
    .map(([channel, a]) => ({ channel, sessions: a.sessions, engagementRate: a.sessions ? a.engaged / a.sessions : 0, keyEvents: a.keyEvents }))
    .sort((x, y) => y.sessions - x.sessions)
    .slice(0, 10);
}

/** 2期間を指定したレポートの、行が current / previous どちらの期間か */
function rangeOf(report: Report, r: Row): string {
  const i = report.dimensionHeaders?.findIndex((h) => h.name === "dateRange") ?? -1;
  return dim(r, i >= 0 ? i : (r.dimensionValues?.length ?? 1) - 1);
}

/** 他ドメインへのリンクのクリック数をドメイン別に（www. を除いて）まとめる */
export function groupLinkClicks(report: Report): NonNullable<Ga4Report["linkClicks"]> {
  const acc = new Map<string, { current: number; previous: number }>();
  for (const r of report.rows ?? []) {
    const domain = dim(r, 0).replace(/^www\./, "").toLowerCase();
    if (!domain || domain === "(not set)") continue;
    const a = acc.get(domain) ?? { current: 0, previous: 0 };
    a[rangeOf(report, r) === "previous" ? "previous" : "current"] += num(r, 0);
    acc.set(domain, a);
  }
  return [...acc]
    .map(([domain, clicks]) => ({ domain, clicks }))
    .sort((x, y) => y.clicks.current - x.clicks.current)
    .slice(0, 15);
}

/** RIKCADお知らせ（medium=rss）の訪問を current / previous に分ける */
export function rikcadNewsTotals(report: Report): NonNullable<Ga4Report["rikcadNews"]> {
  const out = {
    sessions: { current: 0, previous: 0 },
    activeUsers: { current: 0, previous: 0 },
    engagementRate: { current: 0, previous: 0 },
  };
  for (const r of report.rows ?? []) {
    const p = rangeOf(report, r) === "previous" ? "previous" : "current";
    out.sessions[p] = num(r, 0);
    out.activeUsers[p] = num(r, 1);
    out.engagementRate[p] = num(r, 2);
  }
  return out;
}

/**
 * AIサービスの参照元（sessionSource）。AIの回答に載ったリンクから来た訪問は、参照元のドメインか
 * AIが付ける utm_source（chatgpt.com など）で見分けられる。上から順に判定する
 */
export const AI_SERVICES: { name: string; pattern: RegExp }[] = [
  { name: "ChatGPT", pattern: /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com)$|^chatgpt$|^openai$/ },
  { name: "Gemini", pattern: /(^|\.)(gemini\.google\.com|bard\.google\.com)$|^gemini$/ },
  { name: "Perplexity", pattern: /(^|\.)perplexity\.ai$|^perplexity$/ },
  { name: "Copilot", pattern: /(^|\.)(copilot\.microsoft\.com|copilot\.cloud\.microsoft|copilot\.com)$|^copilot$/ },
  { name: "Claude", pattern: /(^|\.)claude\.ai$|^claude$/ },
  { name: "DeepSeek", pattern: /(^|\.)deepseek\.com$|^deepseek$/ },
  { name: "Grok", pattern: /(^|\.)(grok\.com|x\.ai)$|^grok$/ },
  { name: "Meta AI", pattern: /(^|\.)meta\.ai$/ },
  { name: "Le Chat（Mistral）", pattern: /(^|\.)mistral\.ai$/ },
  { name: "Felo", pattern: /(^|\.)felo\.ai$/ },
  { name: "Genspark", pattern: /(^|\.)genspark\.ai$/ },
  { name: "You.com", pattern: /(^|\.)you\.com$/ },
];

/** GA4に渡す絞り込み。細かい判定は aiServiceOf で行う */
const AI_SOURCE_FILTER = "chatgpt|openai|gemini|bard\\.google|perplexity|copilot|claude|deepseek|grok|x\\.ai|meta\\.ai|mistral|felo\\.ai|genspark|you\\.com";

/** 参照元がAIサービスならその名前。違えば null */
export function aiServiceOf(source: string): string | null {
  const s = source.trim().toLowerCase().replace(/^www\./, "");
  return AI_SERVICES.find((a) => a.pattern.test(s))?.name ?? null;
}

const kpi = () => ({ current: 0, previous: 0 });

/** AIサービスから来た訪問を、合計とAI別にまとめる。totalR は参照元で分けない合計（ユーザー数を重複なく数えるため） */
export function groupAiReferrals(bySourceR: Report, totalR: Report | undefined): NonNullable<Ga4Report["aiReferrals"]> {
  const services = new Map<string, { sessions: Kpi; engaged: Kpi; keyEvents: Kpi; sources: Set<string> }>();
  const sum = { sessions: kpi(), activeUsers: kpi(), engaged: kpi(), keyEvents: kpi() };
  for (const r of bySourceR.rows ?? []) {
    const source = dim(r, 0);
    const name = aiServiceOf(source);
    if (!name) continue;
    const p = rangeOf(bySourceR, r) === "previous" ? "previous" : "current";
    const a = services.get(name) ?? { sessions: kpi(), engaged: kpi(), keyEvents: kpi(), sources: new Set<string>() };
    a.sessions[p] += num(r, 0);
    a.engaged[p] += num(r, 1);
    a.keyEvents[p] += num(r, 2);
    a.sources.add(source.toLowerCase());
    services.set(name, a);
    sum.sessions[p] += num(r, 0);
    sum.activeUsers[p] += num(r, 3);
    sum.engaged[p] += num(r, 1);
    sum.keyEvents[p] += num(r, 2);
  }
  // 参照元で分けない合計が取れていれば、ユーザー数はそちらを使う（複数のAIから来た人を1人と数える）
  if (totalR?.rows?.length && services.size) {
    sum.activeUsers = kpi();
    for (const r of totalR.rows) sum.activeUsers[rangeOf(totalR, r) === "previous" ? "previous" : "current"] = num(r, 0);
  }
  const rate = (e: Kpi, s: Kpi) => ({ current: s.current ? e.current / s.current : 0, previous: s.previous ? e.previous / s.previous : 0 });
  return {
    sessions: sum.sessions,
    activeUsers: sum.activeUsers,
    engagementRate: rate(sum.engaged, sum.sessions),
    keyEvents: sum.keyEvents,
    services: [...services]
      .map(([name, a]) => ({
        name,
        sessions: a.sessions,
        engagementRate: rate(a.engaged, a.sessions).current,
        keyEvents: a.keyEvents.current,
        sources: [...a.sources].sort(),
      }))
      .sort((x, y) => y.sessions.current - x.sessions.current || y.sessions.previous - x.sessions.previous),
  };
}

export async function fetchGa4(
  env: Env,
  propertyId: string,
  current: DateRange,
  previous: DateRange,
  opts: { rikcadNews?: boolean } = {},
): Promise<Ga4Report> {
  const property = `properties/${propertyId}`;
  const today = todayJst();
  const cur = [{ ...current, name: "current" }];

  const both = [
    { ...current, name: "current" },
    { ...previous, name: "previous" },
  ];

  const aiFilter = {
    filter: { fieldName: "sessionSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: AI_SOURCE_FILTER, caseSensitive: false } },
  };
  const [batchA, batchB, batchC] = await Promise.all([
    post<{ reports: Report[] }>(env, `${property}:batchRunReports`, {
      requests: [
        { dateRanges: [{ ...current, name: "current" }, { ...previous, name: "previous" }], metrics: TOTAL_METRICS.map(m) },
        { dateRanges: cur, dimensions: [d("date")], metrics: [m("activeUsers"), m("sessions"), m("keyEvents")], limit: 400 },
        {
          dateRanges: [previous],
          dimensions: [d("date")],
          metrics: [m("activeUsers"), m("sessions"), m("keyEvents")],
          limit: 400,
        },
        {
          dateRanges: cur,
          dimensions: [d("sessionDefaultChannelGroup"), d("sessionMedium")],
          metrics: [m("sessions"), m("engagedSessions"), m("keyEvents")],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 500,
        },
        {
          dateRanges: cur,
          dimensions: [d("deviceCategory")],
          metrics: [m("sessions")],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        },
      ],
    }),
    post<{ reports: Report[] }>(env, `${property}:batchRunReports`, {
      requests: [
        {
          dateRanges: cur,
          dimensions: [d("pagePath"), d("pageTitle")],
          metrics: [m("screenPageViews"), m("activeUsers"), m("engagementRate")],
          orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
          limit: 15,
        },
        {
          dateRanges: cur,
          dimensions: [d("landingPage")],
          metrics: [m("sessions"), m("engagementRate"), m("keyEvents")],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 15,
        },
        {
          dateRanges: cur,
          dimensions: [d("sessionSourceMedium")],
          metrics: [m("sessions"), m("keyEvents")],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 10,
        },
        { dateRanges: [{ startDate: today, endDate: today }], metrics: [m("activeUsers"), m("sessions"), m("keyEvents")] },
      ],
    }),
    // サイトの目的に合わせた指標（他サイトへの送客、RIKCADお知らせ経由の閲覧）と、
    // AIサービス（ChatGPT・Gemini など）から来た訪問。取れなくても他の数字は出す。
    // 同時リクエスト数を抑えるため1回のバッチ（上限5件）にまとめる
    post<{ reports: Report[] }>(env, `${property}:batchRunReports`, {
      requests: [
        {
          dateRanges: both,
          dimensions: [d("linkDomain")],
          metrics: [m("eventCount")],
          dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "click" } } },
          orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
          limit: 50,
        },
        {
          dateRanges: both,
          dimensions: [d("sessionSource")],
          metrics: [m("sessions"), m("engagedSessions"), m("keyEvents"), m("activeUsers")],
          dimensionFilter: aiFilter,
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 100,
        },
        { dateRanges: both, metrics: [m("activeUsers")], dimensionFilter: aiFilter },
        ...(opts.rikcadNews
          ? [
              {
                dateRanges: both,
                dimensions: [d("sessionMedium")],
                metrics: [m("sessions"), m("activeUsers"), m("engagementRate")],
                dimensionFilter: { filter: { fieldName: "sessionMedium", stringFilter: { matchType: "EXACT", value: "rss" } } },
              },
            ]
          : []),
      ],
    }).catch((e) => {
      console.error("ga4 purpose / ai metrics", propertyId, e instanceof Error ? e.message : e);
      return undefined;
    }),
  ]);

  const [totalsR, dailyR, dailyPrevR, channelR, deviceR] = batchA.reports;
  const [pagesR, landingR, smR, todayR] = batchB.reports;

  // 2期間指定時は GA4 が "dateRange" ディメンションを自動で付ける
  const totalsRows = new Map<string, Row>();
  for (const r of totalsR.rows ?? []) totalsRows.set(dim(r, 0), r);
  const curRow = totalsRows.get("current");
  const prevRow = totalsRows.get("previous");
  const totals = Object.fromEntries(
    TOTAL_METRICS.map((name, i) => [
      name,
      { current: curRow ? num(curRow, i) : 0, previous: prevRow ? num(prevRow, i) : 0 },
    ]),
  ) as Ga4Report["totals"];

  const todayRow = todayR.rows?.[0];
  const [linkR, aiR, aiTotalR, newsR] = batchC?.reports ?? [];

  return {
    totals,
    daily: dailySeries(dailyR, current),
    dailyPrevious: dailySeries(dailyPrevR, previous),
    channels: groupChannels(channelR.rows ?? [], !!opts.rikcadNews),
    devices: (deviceR.rows ?? []).map((r) => ({ device: dim(r, 0), sessions: num(r, 0) })),
    topPages: (pagesR.rows ?? []).map((r) => ({
      path: dim(r, 0),
      title: dim(r, 1),
      views: num(r, 0),
      users: num(r, 1),
      engagementRate: num(r, 2),
    })),
    landingPages: (landingR.rows ?? []).map((r) => ({
      path: dim(r, 0),
      sessions: num(r, 0),
      engagementRate: num(r, 1),
      keyEvents: num(r, 2),
    })),
    sourceMedium: (smR.rows ?? []).map((r) => {
      const sm = dim(r, 0);
      const label = opts.rikcadNews && sm === "rss / rss" ? `${RIKCAD_NEWS_LABEL}（${sm}）` : sm;
      return { sourceMedium: label, sessions: num(r, 0), keyEvents: num(r, 1) };
    }),
    linkClicks: linkR && groupLinkClicks(linkR),
    rikcadNews: newsR && rikcadNewsTotals(newsR),
    aiReferrals: aiR && groupAiReferrals(aiR, aiTotalR),
    today: {
      activeUsers: todayRow ? num(todayRow, 0) : 0,
      sessions: todayRow ? num(todayRow, 1) : 0,
      keyEvents: todayRow ? num(todayRow, 2) : 0,
    },
  };
}

/** 直近30分のアクティブユーザー（Realtime API）。キャッシュせず毎回取得する */
export async function fetchRealtime(env: Env, propertyId: string): Promise<{ activeUsers: number; pages: { title: string; users: number }[] }> {
  const res = await post<{ reports?: Report[] } & Report>(env, `properties/${propertyId}:runRealtimeReport`, {
    dimensions: [d("unifiedScreenName")],
    metrics: [m("activeUsers")],
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
    limit: 5,
    metricAggregations: ["TOTAL"],
  });
  const rows = res.rows ?? [];
  const totals = (res as { totals?: Row[] }).totals;
  const activeUsers = totals?.[0] ? num(totals[0], 0) : rows.reduce((s, r) => s + num(r, 0), 0);
  return { activeUsers, pages: rows.map((r) => ({ title: dim(r, 0), users: num(r, 0) })) };
}
