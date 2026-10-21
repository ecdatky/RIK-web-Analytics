import type { DateRange, Env, MetaGa4Results } from "../types";
import { dim, num, post, type Report } from "../google/ga4";

// Meta広告（Facebook・Instagram）から来た訪問を GA4 で数える。
// Metaピクセルが無いサイトでは Meta 側の CV が0になるため、サイトでの成果（キーイベント）をGA4から補う。
// 参照元は Meta の自動 UTM（ig / paid、fb / paid など）を想定する
const META_FILTER = {
  andGroup: {
    expressions: [
      {
        filter: {
          fieldName: "sessionSource",
          stringFilter: { matchType: "FULL_REGEXP", value: "(ig|fb|facebook|instagram|an|msg|messenger|meta|threads)(\\.com)?", caseSensitive: false },
        },
      },
      { filter: { fieldName: "sessionMedium", stringFilter: { matchType: "PARTIAL_REGEXP", value: "paid|cpc|ppc|^ad", caseSensitive: false } } },
    ],
  },
};

export async function fetchMetaViaGa4(env: Env, propertyId: string, current: DateRange, previous: DateRange): Promise<MetaGa4Results> {
  const run = (dimensions: string[], ranges: DateRange[], limit = 100) =>
    post<Report>(env, `properties/${propertyId}:runReport`, {
      dateRanges: ranges.map((r, i) => ({ ...r, name: i ? "previous" : "current" })),
      dimensions: dimensions.map((name) => ({ name })),
      metrics: [{ name: "sessions" }, { name: "keyEvents" }],
      dimensionFilter: META_FILTER,
      limit,
    });
  const [totals, campaigns] = await Promise.all([run([], [current, previous]), run(["sessionCampaignName"], [current])]);
  const period = (p: string) => (totals.rows ?? []).find((r) => dim(r, 0) === p);
  const val = (p: string, i: number) => {
    const r = period(p);
    return r ? num(r, i) : 0;
  };
  return {
    sessions: { current: val("current", 0), previous: val("previous", 0) },
    keyEvents: { current: val("current", 1), previous: val("previous", 1) },
    campaigns: (campaigns.rows ?? [])
      .map((r) => ({ name: dim(r, 0), sessions: num(r, 0), keyEvents: num(r, 1) }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 20),
  };
}
