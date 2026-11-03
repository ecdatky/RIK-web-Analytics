import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import type { Env, SiteConfig } from "./types";
import type { Diagnosis, DiagnosisItem, DiagnosisSeverity } from "./diagnosis";

// 担当者のコメント（事情・補足）。診断の項目や、サイト全体・領域ごとに書ける。
// 例: 「コーポのMeta広告はPeatixに誘導しているので、申込はPeatixの管理画面で見る」。
// 診断・AIのひとこと・AIへの質問は、このコメントを事実として踏まえた表現に変える。
// サイトごとに1つのKVキーにまとめ、期間をまたいで残す（期限なし）。

/** 診断の項目以外にコメントを付けられる先 */
export const NOTE_SCOPES = {
  site: "サイト全体",
  ga4: "アクセス解析",
  ads: "Google広告",
  meta: "SNS広告",
} as const;
export type NoteScope = keyof typeof NOTE_SCOPES;

export interface SiteNote {
  id: string;
  siteId: string;
  /** "item:<診断項目のid>" か "scope:<site|ga4|ads|meta>" */
  target: string;
  /** 書いた時点の診断項目の見出し（項目がいまの診断に出ていなくても何のコメントか分かるように） */
  targetLabel: string;
  text: string;
  by: string;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

/** 診断の項目に、コメントを踏まえた表現を重ねたもの */
export interface NotedItem extends DiagnosisItem {
  notes?: { id: string; text: string; by: string; updatedAt: string; scope: string }[];
  /** コメントを踏まえて書き直した場合、元の診断 */
  original?: { title: string; action: string; severity: DiagnosisSeverity };
  /** コメントで事情の説明がつき、いまは手を打たなくてよい */
  explained?: boolean;
}

export type NotedDiagnosis = Omit<Diagnosis, "items"> & { items: NotedItem[]; notes: SiteNote[] };

export const MAX_NOTE_CHARS = 1000;
const MAX_NOTES_PER_SITE = 100;
const DEFAULT_MODEL = "claude-haiku-5-5";

const notesKey = (siteId: string) => `notes:v1:${siteId}`;

export async function listNotes(env: Env, siteId: string): Promise<SiteNote[]> {
  return (await env.CACHE.get<SiteNote[]>(notesKey(siteId), "json")) ?? [];
}

/** コメントがいつ最後に変わったか（AIのひとことが古いかどうかの判定に使う） */
export function notesUpdatedAt(notes: SiteNote[]): string | undefined {
  return notes.reduce<string | undefined>((max, n) => (!max || n.updatedAt > max ? n.updatedAt : max), undefined);
}

async function saveNotes(env: Env, siteId: string, notes: SiteNote[]): Promise<void> {
  await env.CACHE.put(notesKey(siteId), JSON.stringify(notes));
}

const cleanText = (text: unknown) => {
  if (typeof text !== "string" || !text.trim()) throw new NoteError("コメントが空です");
  if (text.length > MAX_NOTE_CHARS) throw new NoteError(`コメントは${MAX_NOTE_CHARS}文字までです`);
  return text.trim();
};

export class NoteError extends Error {}

export function isValidTarget(target: unknown): target is string {
  if (typeof target !== "string") return false;
  if (target.startsWith("scope:")) return target.slice(6) in NOTE_SCOPES;
  return /^item:.{1,200}$/.test(target);
}

export async function addNote(
  env: Env,
  siteId: string,
  input: { target?: unknown; targetLabel?: unknown; text?: unknown },
  by: string,
  now = new Date(),
): Promise<SiteNote> {
  if (!isValidTarget(input.target)) throw new NoteError("コメントの付け先が不正です");
  const text = cleanText(input.text);
  const notes = await listNotes(env, siteId);
  if (notes.length >= MAX_NOTES_PER_SITE) throw new NoteError(`コメントは1サイト${MAX_NOTES_PER_SITE}件までです。不要なものを消してください`);
  const target = input.target;
  const label =
    typeof input.targetLabel === "string" && input.targetLabel.trim()
      ? input.targetLabel.trim().slice(0, 200)
      : target.startsWith("scope:")
        ? NOTE_SCOPES[target.slice(6) as NoteScope]
        : target.slice(5);
  const at = now.toISOString();
  const note: SiteNote = { id: crypto.randomUUID(), siteId, target, targetLabel: label, text, by, createdAt: at, updatedAt: at };
  await saveNotes(env, siteId, [...notes, note]);
  return note;
}

export async function updateNote(env: Env, siteId: string, id: string, text: unknown, by: string, now = new Date()): Promise<SiteNote> {
  const clean = cleanText(text);
  const notes = await listNotes(env, siteId);
  const note = notes.find((n) => n.id === id);
  if (!note) throw new NoteError("コメントが見つかりません（ほかの人が消した可能性があります）");
  note.text = clean;
  note.updatedAt = now.toISOString();
  note.updatedBy = by;
  await saveNotes(env, siteId, notes);
  return note;
}

export async function deleteNote(env: Env, siteId: string, id: string): Promise<void> {
  const notes = await listNotes(env, siteId);
  const rest = notes.filter((n) => n.id !== id);
  if (rest.length === notes.length) throw new NoteError("コメントが見つかりません（ほかの人が消した可能性があります）");
  await saveNotes(env, siteId, rest);
}

/** 診断項目がどの領域のものか（領域ごとのコメントを当てるため） */
export function itemScope(item: Pick<DiagnosisItem, "id" | "area">): Exclude<NoteScope, "site"> {
  if (item.area === "meta" || item.id.startsWith("measure-meta") || item.id.startsWith("meta-")) return "meta";
  if (item.area === "ads" || item.id.startsWith("ads-")) return "ads";
  return "ga4";
}

/** その項目に関係するコメント（項目そのもの・その領域・サイト全体） */
export function notesForItem(item: DiagnosisItem, notes: SiteNote[]): SiteNote[] {
  const scope = itemScope(item);
  return notes.filter((n) => n.target === `item:${item.id}` || n.target === `scope:${scope}` || n.target === "scope:site");
}

const scopeName = (n: SiteNote) => (n.target.startsWith("item:") ? "この項目" : NOTE_SCOPES[n.target.slice(6) as NoteScope]);

/** AIのひとこと・質問に渡す形 */
export function notesDigest(notes: SiteNote[]) {
  return notes.map((n) => ({
    about: n.target.startsWith("item:") ? `診断「${n.targetLabel}」` : NOTE_SCOPES[n.target.slice(6) as NoteScope],
    comment: n.text,
    by: n.by,
    updatedAt: n.updatedAt,
  }));
}

// ---- 診断への反映 ----

const Rewrite = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      relevant: z.boolean(),
      title: z.string(),
      action: z.string(),
      severity: z.enum(["high", "medium", "low"]),
      explained: z.boolean(),
    }),
  ),
});
type RewriteOut = z.infer<typeof Rewrite>["items"][number];

const REWRITE_SYSTEM = `あなたは株式会社ユニマットリックのマーケティンググループが使うWeb解析ダッシュボードで、自動診断の文面を整える担当です。
自動診断は決まったルールで数字だけを見て問題点を出すので、担当者しか知らない事情（外部サービスに誘導していて計測できない、意図して止めている、すでに対応済み など）を知りません。
担当者がその事情をコメントに書いたので、コメントを事実として受け止め、診断の見出し（title）・次にできる行動（action）・優先度（severity）を、事情を踏まえた表現に書き直してください。

ルール
- comments のうち、その項目に関係するものだけを使います。サイト全体や領域のコメントがその項目と関係しなければ relevant を false にし、title・action・severity は元のまま返します。
- 関係する場合は relevant を true にします。
- コメントで事情の説明がつき、いまは手を打つ必要が無い（計測できないのは仕組み上当然、意図して止めている、対応済み など）なら explained を true、severity を low にします。見出しは「〜のため計測対象外（申込はPeatixの管理画面で確認）」のように、事情が分かる中立的な表現にし、「〜していません」「〜が0件です」と問題として言い切る表現は避けます。action には、事情を踏まえて代わりに見るべきもの・確かめる場所があれば書き、無ければ「対応は不要です。」とだけ書きます。
- コメントが事情の一部しか説明しない、または対応中なら explained は false にし、残っている課題が分かる見出しと行動に書き直します。severity は残る課題の重さで決めます。
- コメントに無いことは作りません。数字は元の文面にあるものだけ使います。
- 見出しは60字程度まで、行動は2文程度までで、元の文体（です・ます、一文を短く）に合わせます。
- 社内では「期」が年度を指すため、「前期」「今期」とは書きません。`;

/** 同じ項目・同じコメントなら書き直しを使い回す（元の文面かコメントが変われば作り直す） */
export async function rewriteKey(model: string, item: DiagnosisItem, notes: SiteNote[]): Promise<string> {
  const src = JSON.stringify([model, item.id, item.title, item.action, item.severity, notes.map((n) => [n.target, n.text])]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src));
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `note-rw:v1:${item.id.slice(0, 80)}:${hex.slice(0, 32)}`;
}

async function rewriteWithAi(env: Env, site: SiteConfig, targets: { item: DiagnosisItem; notes: SiteNote[] }[]): Promise<RewriteOut[]> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY!, timeout: 25_000, maxRetries: 1 });
  const res = await client.beta.messages.parse({
    model: env.NOTE_MODEL || DEFAULT_MODEL,
    max_tokens: 4000,
    output_config: { format: betaZodOutputFormat(Rewrite) },
    system: REWRITE_SYSTEM,
    messages: [
      {
        role: "user",
        content: `サイト: ${site.name}\n次の診断項目を、担当者のコメントを踏まえて書き直してください。items は入力と同じ id・同じ順で全件返します。\n\n${JSON.stringify(
          targets.map(({ item, notes }) => ({
            id: item.id,
            title: item.title,
            evidence: item.evidence,
            action: item.action,
            severity: item.severity,
            comments: notes.map((n) => ({ about: scopeName(n), text: n.text })),
          })),
        )}`,
      },
    ],
  });
  if (!res.parsed_output) throw new Error(`AIの出力を解釈できませんでした（stop_reason: ${res.stop_reason}）`);
  return res.parsed_output.items;
}

/**
 * 診断にコメントを重ねる。コメントのある項目はAIで事情を踏まえた文面に書き直し、
 * 事情で説明がつくものは優先度を低にして後ろへ回す。AIが使えないときはコメントを添えるだけにする。
 */
export async function applyNotes(env: Env, site: SiteConfig, d: Diagnosis, notes?: SiteNote[]): Promise<NotedDiagnosis> {
  const all = notes ?? (await listNotes(env, site.id));
  const items: NotedItem[] = d.items.map((i) => ({ ...i }));
  const targets = items.map((item) => ({ item, notes: notesForItem(item, all) })).filter((t) => t.notes.length);
  if (!targets.length) return { ...d, items, notes: all };

  const model = env.NOTE_MODEL || DEFAULT_MODEL;
  const keys = await Promise.all(targets.map((t) => rewriteKey(model, t.item, t.notes)));
  const cached = await Promise.all(keys.map((k) => env.CACHE.get<RewriteOut>(k, "json")));
  const missing = targets.map((t, n) => ({ ...t, key: keys[n] })).filter((_, n) => !cached[n]);
  const fresh = new Map<string, RewriteOut>();
  if (missing.length && env.ANTHROPIC_API_KEY) {
    try {
      const out = await rewriteWithAi(env, site, missing);
      for (const m of missing) {
        const r = out.find((o) => o.id === m.item.id);
        if (!r) continue;
        fresh.set(m.item.id, r);
        await env.CACHE.put(m.key, JSON.stringify(r), { expirationTtl: 30 * 86_400 });
      }
    } catch (e) {
      console.error("note rewrite", site.id, e);
    }
  }

  targets.forEach(({ item, notes: ns }, n) => {
    item.notes = ns.map((x) => ({ id: x.id, text: x.text, by: x.by, updatedAt: x.updatedAt, scope: scopeName(x) }));
    const r = cached[n] ?? fresh.get(item.id);
    if (!r?.relevant) {
      // 項目そのものに書かれたコメントだけ添える（AIが関係なしとした領域・サイト全体のコメントは出さない）
      const own = item.notes.filter((x) => x.scope === "この項目");
      item.notes = own.length ? own : undefined;
      return;
    }
    item.original = { title: item.title, action: item.action, severity: item.severity };
    item.title = r.title;
    item.action = r.action;
    item.severity = r.severity;
    item.explained = r.explained;
  });
  const order: Record<DiagnosisSeverity, number> = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => Number(!!a.explained) - Number(!!b.explained) || order[a.severity] - order[b.severity]);
  return { ...d, items, notes: all };
}
