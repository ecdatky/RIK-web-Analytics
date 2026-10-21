import type { CompareKey, DateRange, RangeKey } from "./types";

const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<RangeKey, number> = { "7d": 7, "28d": 28, "90d": 90 };

export function isRangeKey(v: string | null): v is RangeKey {
  return v === "7d" || v === "28d" || v === "90d";
}

export function isCompareKey(v: string | null): v is CompareKey {
  return v === "prev" || v === "yoy";
}

export const COMPARE_LABEL: Record<CompareKey, string> = { prev: "直前の同じ日数との比較", yoy: "前年の同じ日付との比較" };

/** 日本時間の「今日」を YYYY-MM-DD で返す */
export function todayJst(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 同じ月日の1年前（2/29 は 2/28 に寄せる） */
function minusOneYear(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/**
 * 集計期間は「昨日まで」の完了日で取る（当日分は GA4/広告とも途中値のため）。
 * 当日の速報は別枠（today / realtime）で表示する。
 * 比較期間は compare=prev なら直前の同じ日数、yoy なら同じ日付の1年前。
 */
export function resolveRanges(
  range: RangeKey,
  compare: CompareKey = "prev",
  now: Date = new Date(),
): { current: DateRange; previous: DateRange } {
  const days = RANGE_DAYS[range];
  const end = addDays(todayJst(now), -1);
  const start = addDays(end, -(days - 1));
  const previous =
    compare === "yoy"
      ? { startDate: minusOneYear(start), endDate: minusOneYear(end) }
      : { startDate: addDays(start, -days), endDate: addDays(start, -1) };
  return { current: { startDate: start, endDate: end }, previous };
}

/** start〜end の日付一覧（両端含む） */
export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.startDate; d <= range.endDate; d = addDays(d, 1)) out.push(d);
  return out;
}
