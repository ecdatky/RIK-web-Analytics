import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import type { Advice, AdsReport, Env, MetaReport, SiteConfig, SiteReport } from "../types";
import { COMPARE_LABEL } from "../dates";

const DEFAULT_MODEL = "claude-opus-5-5";

const Status = z.enum(["good", "steady", "flat", "caution", "bad"]);

const Section = z.object({
  status: Status,
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
  status: Status,
  headline: z.string(),
  summary: z.string(),
  glossary: z.array(z.object({ term: z.string(), meaning: z.string() })),
  ga4: Section.nullable(),
  ads: Section.nullable(),
  meta: Section.nullable(),
});

const SYSTEM = `あなたは株式会社ユニマットリック（エクステリア・ガーデン製品メーカー）のマーケティンググループを支援するWeb解析と広告運用の専門家です。
渡されるのは1サイト分のGA4（サイトのアクセス解析）、Google広告、Meta広告（Facebook・Instagram）の集計データで、対象期間と比較用の期間（直前の同じ日数、または前年の同じ日付）の値が入っています。
社内では「期」が年度を指すため、「前期」「今期」「前期間」とは書かず、「直前の28日」「前年の同じ日付」のように具体的に書きます。

読み手はマーケティンググループのメンバーと、Web広告の専門家ではない営業・経営層です。専門用語を知らない人でも、現状が良いのか悪いのか、次に何をすればよいのかが分かるように書きます。

出力は GA4（ga4）、Google広告（ads）、Meta広告（meta）を分けて書きます。データが無いものは null にします。
- status: 比較期間と比べた状況の判定。good（好調：成果が明確に伸びている）/ steady（順調：おおむね良い方向）/ flat（横ばい）/ caution（注意：悪化の兆しがある）/ bad（要対策：成果が明確に落ちている）から選びます。訪問者数より、問い合わせ・資料請求などの成果（キーイベント・CV）と、その獲得効率を重く見て判定します。件数が少なく増減が偶然の範囲なら flat にします。
- headline: サイト全体の状況を一文（40字程度まで）で言い切ります。例「アクセスは増えたが、問い合わせは減っている」。
- summary: サイト全体の状況を2〜3文で。何が良くて何が課題か、まず何をすべきかを書きます。GA4と広告をまたいだ見立て（広告から来た人がサイトで問い合わせまで進んでいるか、Google広告とMeta広告のどちらが効率よく成果を取れているか等）があれば入れます。
- review: その領域の総評。2〜3文で、比較期間に対して良くなったか悪くなったか、その主な原因を書きます。
- findings: 3〜5件。良い変化・悪い変化・注意点を、根拠の数値とともに書きます。
- actions: 2〜4件。担当者が来週から着手できる具体的な改善施策を優先度順に書きます。metric にはその施策で追う指標名を入れます。
- glossary: 本文で使った専門用語（CV、CVR、CPA、CTR、セッション、キーイベント、エンゲージメント率、インプレッションシェア、フリークエンシー など）を、使ったものだけ3〜8件、それぞれ一文で説明します。

書き方のルール
- 一文を短くし、結論を先に書きます。
- 数値は「1,234人」「56件」「1件あたり8,900円」のように、人数・件数・金額で具体的に書きます。増減は「直前の28日より12%増（+130人）」「前年の同じ日付より12%増」のように率と実数を並べます。
- 英字略語は初出で「CPA（1件の成果を得るのにかかった広告費）」のように括弧で意味を添えます。2回目以降は略語だけで構いません。
- 「〜と考えられる」「〜の可能性」を重ねず、データで言えることは言い切ります。数値の裏付けがない推測には「推測」と明記します。
- 誇張表現、前置き、敬語の重ね過ぎは不要です。

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

Google広告データの source が "ga4" の場合は、GA4にリンクされたGoogle広告の費用・クリック・表示回数と、Google広告から来たセッションのキーイベント（GA4で計測した成果）です。インプレッションシェアと広告側のコンバージョン値は無いので、それらには触れません。

データから読み取れる事実だけを根拠にします。`;

function pct(cur: number, prev: number) {
  return prev ? `${(((cur - prev) / prev) * 100).toFixed(1)}%` : "n/a";
}

const withChange = (o: Record<string, { current: number; previous: number }>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, change: pct(v.current, v.previous) }]));

function adsDigest(a: AdsReport) {
  const t = a.totals;
  const ratio = (x: number, y: number) => (y ? x / y : null);
  return {
    source: a.source ?? "api",
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
        content: `次のデータを分析して、GA4・Google広告・Meta広告それぞれの状況判定・総評・改善アドバイスと、用語の説明を出してください。\n\n${JSON.stringify(buildDigest(site, report))}`,
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
    status: out.status,
    headline: out.headline,
    summary: out.summary,
    glossary: out.glossary,
    // データが無い側はモデルの出力に関わらず null にする
    ga4: report.ga4 ? out.ga4 : null,
    ads: report.ads ? out.ads : null,
    meta: report.meta ? out.meta : null,
  };
}
