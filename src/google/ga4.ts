import type { DateRange, Env, Ga4Report } from "../types";
import { eachDay, todayJst } from "../dates";
import { serviceAccountToken } from "./auth";

const BASE = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

interface Row {
  dimensionValues?: { value: string }[];
  metricValues?: { value: string }[];
}
interface Report {
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
const num = (r: Row, i: number) => Number(r.metricValues?.[i]?.value ?? 0);
const dim = (r: Row, i: number) => r.dimensionValues?.[i]?.value ?? "";
const ymd = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;

async function post<T>(env: Env, path: string, body: unknown): Promise<T> {
  const token = await serviceAccountToken(env, SCOPE);
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GA4 API エラー (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
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

export async function fetchGa4(env: Env, propertyId: string, current: DateRange, previous: DateRange): Promise<Ga4Report> {
  const property = `properties/${propertyId}`;
  const today = todayJst();
  const cur = [{ ...current, name: "current" }];

  const [batchA, batchB] = await Promise.all([
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
          dimensions: [d("sessionDefaultChannelGroup")],
          metrics: [m("sessions"), m("engagementRate"), m("keyEvents")],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 10,
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

  return {
    totals,
    daily: dailySeries(dailyR, current),
    dailyPrevious: dailySeries(dailyPrevR, previous),
    channels: (channelR.rows ?? []).map((r) => ({
      channel: dim(r, 0),
      sessions: num(r, 0),
      engagementRate: num(r, 1),
      keyEvents: num(r, 2),
    })),
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
    sourceMedium: (smR.rows ?? []).map((r) => ({ sourceMedium: dim(r, 0), sessions: num(r, 0), keyEvents: num(r, 1) })),
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
