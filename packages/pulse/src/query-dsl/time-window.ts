import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import { intervalToMs } from "./interval";

export type QueryTimeRange = { since?: string; from?: string; to?: string };
const timestamp = z.iso.datetime({ offset: true });
const MAX_RANGE_MS = 3650 * 86_400_000; // The maximum supported base retention.
export const resolveQueryTimeRange = (range: QueryTimeRange, now = Date.now()): Result<{ from: Date; to: Date; durationMs: number }> => {
  let from: number, to: number;
  if (range.from !== undefined || range.to !== undefined) {
    if (range.since !== undefined) return fail(err.badInput("Use either since or from/to, never both"));
    if (!timestamp.safeParse(range.from).success || !timestamp.safeParse(range.to).success)
      return fail(err.badInput("From and to must be ISO timestamps with UTC or an explicit offset"));
    from = Date.parse(range.from!);
    to = Date.parse(range.to!);
  } else {
    const duration = range.since ? intervalToMs(range.since) : null;
    if (!duration) return fail(err.badInput("Use compact durations like 5m, 1h, or 7d"));
    to = now;
    from = to - duration;
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > MAX_RANGE_MS)
    return fail(err.badInput("Time range must be increasing and no longer than 3650 days"));
  return ok({ from: new Date(from), to: new Date(to), durationMs: to - from });
};
export const isCalendarBucket = (bucket: string | undefined | null): bucket is "day" | "week" | "month" =>
  bucket === "day" || bucket === "week" || bucket === "month";
export const validateEventBucket = (bucket: string | undefined | null, timeZone?: string): Result<void> => {
  if (isCalendarBucket(bucket)) {
    if (timeZone?.startsWith("+") || timeZone?.startsWith("-"))
      return fail(err.badInput("Use an IANA time zone name, not a numeric offset"));
    if (!timeZone) return fail(err.badInput("Calendar buckets require an explicit IANA time zone"));
    try {
      new Intl.DateTimeFormat("en", { timeZone }).format();
    } catch {
      return fail(err.badInput("Invalid IANA time zone"));
    }
  } else {
    if (timeZone !== undefined) return fail(err.badInput("Time zone requires a day, week or month bucket"));
    if (bucket !== undefined && bucket !== null && bucket !== "all" && !intervalToMs(bucket))
      return fail(err.badInput("Use a duration, day, week, month or all bucket"));
  }
  return ok(undefined);
};
export const queryTimeRangeText = (range: QueryTimeRange): string =>
  range.from !== undefined && range.to !== undefined ? `from ${range.from} to ${range.to}` : `since ${range.since}`;
