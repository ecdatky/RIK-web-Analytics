import type { DateRange, RangeKey } from "./types";

const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<RangeKey, number> = { "7d": 7, "28d": 28, "90d": 90 };

export function isRangeKey(v: string | null): v is RangeKey {
  return v === "7d" || v === "28d" || v === "90d";
}

/** 日本時間の「今日」を YYYY-MM-DD で返す */
export function todayJst(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 集計期間は「昨日まで」の完了日で取る（当日分は GA4/広告とも途中値のため）。
 * 当日の速報は別枠（today / realtime）で表示する。
 */
export function resolveRanges(range: RangeKey, now: Date = new Date()): { current: DateRange; previous: DateRange } {
  const days = RANGE_DAYS[range];
  const end = addDays(todayJst(now), -1);
  const start = addDays(end, -(days - 1));
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  return {
    current: { startDate: start, endDate: end },
    previous: { startDate: prevStart, endDate: prevEnd },
  };
}

/** start〜end の日付一覧（両端含む） */
export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.startDate; d <= range.endDate; d = addDays(d, 1)) out.push(d);
  return out;
}
