import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import type { Advice, Env, SiteConfig, SiteReport } from "../types";

const DEFAULT_MODEL = "claude-opus-5-5";

const AdviceSchema = z.object({
  summary: z.string(),
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

const SYSTEM = `あなたは株式会社ユニマットリック（エクステリア・ガーデン製品メーカー）のマーケティンググループを支援するWeb解析の専門家です。
渡されるのは1サイト分のGA4とGoogle広告の集計データ（今期間と前期間の比較）です。

- データから読み取れる事実だけを根拠にしてください。数値の裏付けがない推測は「推測」と明記します。
- findings は3〜5件。良い変化・悪い変化・注意点を、根拠となる数値（前期間比など）とともに書きます。
- actions は2〜4件。マーケティング担当者が来週から着手できる具体的な改善施策を、優先度順に書きます。metric にはその施策で追う指標名を入れます。
- summary は2文以内で、このサイトの今の状況を一言でまとめます。
- 文体は簡潔な日本語。誇張表現や前置きは不要です。`;

function pct(cur: number, prev: number) {
  return prev ? `${(((cur - prev) / prev) * 100).toFixed(1)}%` : "n/a";
}

/** AIに渡す要約。生データをそのまま渡さず、比較しやすい形に絞る */
export function buildDigest(site: SiteConfig, report: SiteReport) {
  const g = report.ga4;
  const a = report.ads;
  return {
    site: { name: site.name, url: site.url, goal: site.goal },
    period: { current: report.current, previous: report.previous },
    ga4: g && {
      totals: Object.fromEntries(Object.entries(g.totals).map(([k, v]) => [k, { ...v, change: pct(v.current, v.previous) }])),
      channels: g.channels,
      devices: g.devices,
      topPages: g.topPages.slice(0, 10),
      landingPages: g.landingPages.slice(0, 10),
      sourceMedium: g.sourceMedium,
    },
    ga4Error: report.ga4Error,
    ads: a && {
      totals: Object.fromEntries(Object.entries(a.totals).map(([k, v]) => [k, { ...v, change: pct(v.current, v.previous) }])),
      cpa: a.totals.conversions.current ? a.totals.cost.current / a.totals.conversions.current : null,
      campaigns: a.campaigns.slice(0, 15),
    },
    adsError: report.adsError,
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
        content: `次のデータを分析して、改善アドバイスを出してください。\n\n${JSON.stringify(buildDigest(site, report))}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("AIが回答を返しませんでした（refusal）");
  if (!response.parsed_output) throw new Error(`AIの出力を解釈できませんでした（stop_reason: ${response.stop_reason}）`);

  return {
    siteId: site.id,
    generatedAt: new Date().toISOString(),
    model: response.model,
    demo: false,
    ...response.parsed_output,
  };
}
