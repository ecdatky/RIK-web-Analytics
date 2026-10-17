import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import type { Advice, AdsReport, Env, MetaReport, SiteConfig, SiteReport } from "../types";
import { COMPARE_LABEL } from "../dates";

const DEFAULT_MODEL = "claude-opus-5-5";

const Section = z.object({
  review: z.string(),
  findings: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      tone: z.enum(["good", "warning", "critical", "info"]),
    }),
  ),
  actions: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      priority: z.enum(["high", "medium", "low"]),
      metric: z.string(),
    }),
  ),
});

const AdviceSchema = z.object({
  summary: z.string(),
  ga4: Section.nullable(),
  ads: Section.nullable(),
  meta: Section.nullable(),
});

const SYSTEM = `あなたは株式会社ユニマットリック（エクステリア・ガーデン製品メーカー）のマーケティンググループを支援するWeb解析と広告運用の専門家です。
渡されるのは1サイト分のGA4（サイトのアクセス解析）、Google広告、Meta広告（Facebook・Instagram）の集計データで、今期間と比較期間（前期間または前年同期）の値が入っています。

出力は GA4（ga4）、Google広告（ads）、Meta広告（meta）を分けて書きます。データが無いものは null にします。
- review: その領域の総評。2〜3文で、比較期間に対して良くなったか悪くなったか、その主因は何かを書きます。
- findings: 3〜5件。良い変化・悪い変化・注意点を、根拠の数値（比較期間比など）とともに書きます。
- actions: 2〜4件。担当者が来週から着手できる具体的な改善施策を優先度順に書きます。metric にはその施策で追う指標名を入れます。
- summary: サイト全体の状況を1〜2文で。GA4と広告をまたいだ見立て（広告流入がサイト内で成果につながっているか、Google広告とMeta広告のどちらが効率よくCVを取れているか等）があれば入れます。

Google広告では次の観点で効果を判断します。
- CPA・CVR・ROAS（コンバージョン値がある場合）の変化と、キャンペーン間の差
- 検索インプレッションシェアと、予算・広告ランクによる損失（取りこぼしの有無と原因）
- 費用が掛かっているのにコンバージョンが無いキーワード・検索語句（除外候補）
- デバイス別の費用対効果

Meta広告では次の観点で効果を判断します。CVは conversionActions に挙げた action_type の合計です。
- CPA・CVR（リンククリック→CV）の変化と、キャンペーン・広告（クリエイティブ）間の差
- CTR・CPC・CPM の変化（クリエイティブの反応や配信単価の上昇）
- フリークエンシー（表示回数÷リーチ）。3回を超えるキャンペーンは見飽きによる効率低下の可能性
- 配信面（Facebook / Instagram / Audience Network など）別の費用対効果
- 費用が掛かっているのにCVの無い広告（停止・差し替え候補）。ただし認知・トラフィック目的のキャンペーンはCV以外の指標でも評価します

データから読み取れる事実だけを根拠にし、数値の裏付けがない推測は「推測」と明記します。文体は簡潔な日本語で、誇張表現や前置きは不要です。`;

function pct(cur: number, prev: number) {
  return prev ? `${(((cur - prev) / prev) * 100).toFixed(1)}%` : "n/a";
}

const withChange = (o: Record<string, { current: number; previous: number }>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, change: pct(v.current, v.previous) }]));

function adsDigest(a: AdsReport) {
  const t = a.totals;
  const ratio = (x: number, y: number) => (y ? x / y : null);
  return {
    totals: withChange(t as unknown as Record<string, { current: number; previous: number }>),
    derived: {
      ctr: { current: ratio(t.clicks.current, t.impressions.current), previous: ratio(t.clicks.previous, t.impressions.previous) },
      cvr: { current: ratio(t.conversions.current, t.clicks.current), previous: ratio(t.conversions.previous, t.clicks.previous) },
      cpa: { current: ratio(t.cost.current, t.conversions.current), previous: ratio(t.cost.previous, t.conversions.previous) },
      roas: { current: ratio(t.conversionsValue.current, t.cost.current), previous: ratio(t.conversionsValue.previous, t.cost.previous) },
    },
    campaigns: a.campaigns.slice(0, 15),
    devices: a.devices,
    keywords: a.keywords.slice(0, 15),
    searchTerms: a.searchTerms.slice(0, 20),
  };
}

function metaDigest(m: MetaReport) {
  const t = m.totals;
  const ratio = (x: number, y: number) => (y ? x / y : null);
  const rate = (k: (p: "current" | "previous") => number | null) => ({ current: k("current"), previous: k("previous") });
  return {
    conversionActions: m.conversionActions,
    totals: withChange(t as unknown as Record<string, { current: number; previous: number }>),
    derived: {
      ctr: rate((p) => ratio(t.clicks[p], t.impressions[p])),
      cpc: rate((p) => ratio(t.spend[p], t.clicks[p])),
      cpm: rate((p) => ratio(t.spend[p] * 1000, t.impressions[p])),
      frequency: rate((p) => ratio(t.impressions[p], t.reach[p])),
      cvr: rate((p) => ratio(t.conversions[p], t.clicks[p])),
      cpa: rate((p) => ratio(t.spend[p], t.conversions[p])),
    },
    campaigns: m.campaigns.slice(0, 15).map((c) => ({ ...c, frequency: ratio(c.impressions, c.reach) })),
    platforms: m.platforms,
    ads: m.ads.slice(0, 15),
  };
}

/** AIに渡す要約。生データをそのまま渡さず、比較しやすい形に絞る */
export function buildDigest(site: SiteConfig, report: SiteReport) {
  const g = report.ga4;
  return {
    site: { name: site.name, url: site.url, goal: site.goal },
    period: { current: report.current, comparison: report.previous, comparisonType: COMPARE_LABEL[report.compare] },
    ga4: g && {
      totals: withChange(g.totals),
      channels: g.channels,
      devices: g.devices,
      topPages: g.topPages.slice(0, 10),
      landingPages: g.landingPages.slice(0, 10),
      sourceMedium: g.sourceMedium,
    },
    ga4Error: report.ga4Error,
    ads: report.ads && adsDigest(report.ads),
    adsError: report.adsError,
    meta: report.meta && metaDigest(report.meta),
    metaError: report.metaError,
  };
}

export async function generateAdvice(env: Env, site: SiteConfig, report: SiteReport): Promise<Advice> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.ADVICE_MODEL || DEFAULT_MODEL;

  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    // ポリシー判定で断られた場合はサーバー側で既定の代替モデルに切り替える
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(AdviceSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `次のデータを分析して、GA4・Google広告・Meta広告それぞれの総評と改善アドバイスを出してください。\n\n${JSON.stringify(buildDigest(site, report))}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("AIが回答を返しませんでした（refusal）");
  if (!response.parsed_output) throw new Error(`AIの出力を解釈できませんでした（stop_reason: ${response.stop_reason}）`);

  const out = response.parsed_output;
  return {
    siteId: site.id,
    generatedAt: new Date().toISOString(),
    model: response.model,
    demo: false,
    range: report.range,
    compare: report.compare,
    summary: out.summary,
    // データが無い側はモデルの出力に関わらず null にする
    ga4: report.ga4 ? out.ga4 : null,
    ads: report.ads ? out.ads : null,
    meta: report.meta ? out.meta : null,
  };
}
