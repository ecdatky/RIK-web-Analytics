import { describe, expect, it } from "vitest";
import { addNote, applyNotes, deleteNote, itemScope, listNotes, notesForItem, notesUpdatedAt, rewriteKey, updateNote } from "../src/notes";
import type { Diagnosis, DiagnosisItem } from "../src/diagnosis";
import { DEMO_SITES } from "../src/demo";
import type { Env } from "../src/types";

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: string) {
      const v = store.get(key);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

const site = DEMO_SITES[0];
const offsite: DiagnosisItem = {
  id: "measure-meta-offsite",
  area: "measure",
  severity: "medium",
  title: "Meta広告の行き先がPeatixのため、このダッシュボードでは申込数を測れません",
  evidence: "費用の100%がPeatix行き。",
  action: "Peatixの管理画面で申込数を見る。",
  where: "Peatix",
};
const lowGa4: DiagnosisItem = { id: "ga4-x", area: "ga4", severity: "high", title: "訪問が減っています", evidence: "-", action: "記事を見直す。", where: "GA4" };
const diag = (items: DiagnosisItem[]): Diagnosis => ({
  siteId: site.id,
  checkedAt: "2026-11-03T00:00:00Z",
  range: "28d",
  compare: "prev",
  period: { startDate: "2026-10-06", endDate: "2026-11-02" },
  dataFetchedAt: "2026-11-03T00:00:00Z",
  items,
  passed: [],
});

describe("担当者のコメント", () => {
  it("追加・編集・削除でき、期間に関係なくサイトごとに残る", async () => {
    const env = { CACHE: memoryKv() } as unknown as Env;
    const a = await addNote(env, site.id, { target: "item:measure-meta-offsite", targetLabel: offsite.title, text: " Peatixに誘導しています " }, "a@rikcorp.jp");
    expect(a.text).toBe("Peatixに誘導しています");
    await addNote(env, site.id, { target: "scope:meta", text: "11月は配信を止めています" }, "b@rikcorp.jp");
    expect(await listNotes(env, site.id)).toHaveLength(2);
    expect(await listNotes(env, "other")).toHaveLength(0);

    const later = new Date(Date.now() + 60_000);
    const u = await updateNote(env, site.id, a.id, "Peatixに誘導。申込はPeatixで確認", "b@rikcorp.jp", later);
    expect(u.updatedBy).toBe("b@rikcorp.jp");
    expect(notesUpdatedAt(await listNotes(env, site.id))).toBe(later.toISOString());

    await deleteNote(env, site.id, a.id);
    expect((await listNotes(env, site.id)).map((n) => n.target)).toEqual(["scope:meta"]);
    await expect(deleteNote(env, site.id, a.id)).rejects.toThrow("見つかりません");
  });

  it("空のコメントや不正な付け先は受け付けない", async () => {
    const env = { CACHE: memoryKv() } as unknown as Env;
    await expect(addNote(env, site.id, { target: "item:x", text: "  " }, "a")).rejects.toThrow("空");
    await expect(addNote(env, site.id, { target: "scope:foo", text: "x" }, "a")).rejects.toThrow("付け先");
    await expect(addNote(env, site.id, { target: "item:x", text: "あ".repeat(1001) }, "a")).rejects.toThrow("1000文字");
  });

  it("項目・その領域・サイト全体のコメントを項目に当てる", async () => {
    expect(itemScope(offsite)).toBe("meta");
    expect(itemScope({ id: "ads-zero-x", area: "measure" })).toBe("ads");
    expect(itemScope(lowGa4)).toBe("ga4");
    const env = { CACHE: memoryKv() } as unknown as Env;
    await addNote(env, site.id, { target: "scope:meta", text: "Peatix" }, "a");
    await addNote(env, site.id, { target: "scope:site", text: "全体" }, "a");
    const notes = await listNotes(env, site.id);
    expect(notesForItem(offsite, notes).map((n) => n.text)).toEqual(["Peatix", "全体"]);
    expect(notesForItem(lowGa4, notes).map((n) => n.text)).toEqual(["全体"]);
  });

  it("AIが使えないときは、項目のコメントを添えるだけで文面は変えない", async () => {
    const env = { CACHE: memoryKv() } as unknown as Env;
    await addNote(env, site.id, { target: "item:measure-meta-offsite", text: "Peatixに誘導" }, "a");
    const d = await applyNotes(env, site, diag([lowGa4, offsite]));
    const item = d.items.find((i) => i.id === offsite.id)!;
    expect(item.title).toBe(offsite.title);
    expect(item.notes?.[0].text).toBe("Peatixに誘導");
    expect(item.original).toBeUndefined();
    expect(d.notes).toHaveLength(1);
  });

  it("書き直しがあれば文面と優先度を差し替え、事情で説明がつく項目は後ろへ回す", async () => {
    const kv = memoryKv();
    const env = { CACHE: kv } as unknown as Env;
    await addNote(env, site.id, { target: "item:measure-meta-offsite", text: "Peatixに誘導" }, "a");
    const notes = await listNotes(env, site.id);
    const key = await rewriteKey("claude-haiku-5-5", offsite, notes);
    await kv.put(
      key,
      JSON.stringify({ id: offsite.id, relevant: true, title: "Peatix誘導のため計測対象外", action: "対応は不要です。", severity: "low", explained: true }),
    );
    const d = await applyNotes(env, site, diag([offsite, { ...lowGa4, severity: "low" }]));
    expect(d.items.map((i) => i.id)).toEqual(["ga4-x", "measure-meta-offsite"]);
    const item = d.items[1];
    expect(item.title).toBe("Peatix誘導のため計測対象外");
    expect(item.severity).toBe("low");
    expect(item.explained).toBe(true);
    expect(item.original?.title).toBe(offsite.title);
    // 元の診断は変えない
    expect(offsite.title).toContain("Peatixのため");
  });
});
