import { afterEach, describe, expect, it, vi } from "vitest";
import { getAdvice, getAdviceJob, purgeOldAdvice, refreshAdvice } from "../src/service";
import { DEMO_SITES } from "../src/demo";
import type { Env } from "../src/types";

/** テスト用の KV（get / put / list / delete と metadata だけ） */
function memoryKv() {
  const store = new Map<string, { value: string; metadata?: unknown }>();
  return {
    store,
    async get(key: string, type?: string) {
      const v = store.get(key)?.value;
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
      store.set(key, { value, metadata: opts?.metadata });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix }: { prefix: string }) {
      return { keys: [...store].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })) };
    },
  };
}

const site = DEMO_SITES[0];

afterEach(() => vi.useRealTimers());

describe("AIのひとことの保存", () => {
  it("期間ごとに別々に保存し、別の期間に切り替えても消えない", async () => {
    const kv = memoryKv();
    const env = { CACHE: kv } as unknown as Env;
    await refreshAdvice(env, site, "28d", "prev");
    await refreshAdvice(env, site, "7d", "yoy");

    expect((await getAdvice(env, site.id, "28d", "prev"))?.range).toBe("28d");
    expect((await getAdvice(env, site.id, "7d", "yoy"))?.compare).toBe("yoy");
    expect(await getAdvice(env, site.id, "90d", "prev")).toBeNull();
    // 生成が終わったら「作成中」の印は消える
    expect(await getAdviceJob(env, site.id, "28d", "prev")).toBeNull();
  });

  it("生成した日が変わると表示せず、朝の掃除でまとめて消す", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T03:00:00Z")); // 10/21 12:00 JST
    const kv = memoryKv();
    const env = { CACHE: kv } as unknown as Env;
    await refreshAdvice(env, site, "28d", "prev");
    await refreshAdvice(env, site, "90d", "prev");
    expect(await getAdvice(env, site.id, "28d", "prev")).not.toBeNull();

    vi.setSystemTime(new Date("2026-10-21T22:00:00Z")); // 10/22 07:00 JST
    expect(await getAdvice(env, site.id, "28d", "prev")).toBeNull();
    expect(await purgeOldAdvice(env, site.id)).toBe(2);
    expect([...kv.store.keys()].filter((k) => k.startsWith("advice:"))).toEqual([]);
  });

  it("進み具合を順に知らせる", async () => {
    const env = { CACHE: memoryKv() } as unknown as Env;
    const stages: string[] = [];
    await refreshAdvice(env, site, "28d", "prev", { onProgress: (stage) => stages.push(stage) });
    expect(stages[0]).toBe("data");
    expect(stages.at(-1)).toBe("saving");
  });
});
