import type { LogEntry, LogLevel } from "./contracts";

/** One line of the log table, formatted once for server and browser alike. */
export type LogRow = {
  id: string;
  level: LogLevel;
  source: string;
  message: string;
  /** "10:43:48.377", or with the day in front when the entry is not from `today`. */
  time: string;
  /** The minute the entry belongs to, its group key: "2026-11-24 10:43". */
  minute: string;
  /** The minute in words: "10:43", or with the day. */
  minuteLabel: string;
  requestId: string | null;
  /** "1.392 ms" */
  duration: string | null;
};

const REQUEST_KEYS = ["requestId", "request_id", "reqId"] as const;
const DURATION_KEYS = ["durationMs", "duration_ms", "duration"] as const;

const firstText = (metadata: Record<string, unknown> | null, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
};

/** The request an entry belongs to, from its metadata (`requestId`, `request_id` or `reqId`). */
export const requestIdOf = (metadata: Record<string, unknown> | null): string | null => firstText(metadata, REQUEST_KEYS);

const UNITS = [
  { unit: "day", ms: 86_400_000 },
  { unit: "hour", ms: 3_600_000 },
  { unit: "minute", ms: 60_000 },
  { unit: "second", ms: 1000 },
] as const;

/**
 * A duration in the largest units that say it: "64 ms", "1,4 s", "17 min 3 s", "1 h 17 min", "2 d 3 h" in the reader's
 * language. A negative or unreadable value is no duration (null), never "-1 ms".
 */
export const logDurationFormatter = (locale: string) => {
  const unit = (name: string, digits = 0) =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "short", maximumFractionDigits: digits });
  const ms = unit("millisecond");
  const seconds = unit("second", 1);
  const whole = Object.fromEntries(UNITS.map((entry) => [entry.unit, unit(entry.unit)])) as Record<(typeof UNITS)[number]["unit"], Intl.NumberFormat>;
  return (value: number): string | null => {
    if (!Number.isFinite(value) || value < 0) return null;
    if (Math.round(value) < 1000) return ms.format(Math.round(value));
    if (value < 60_000) return seconds.format(value / 1000);
    // two units at most: the largest one and the next, the rest is rounded away
    const index = UNITS.findIndex((entry) => value >= entry.ms);
    const big = UNITS[index]!;
    const small = UNITS[index + 1]!;
    let count = Math.floor(value / big.ms);
    let rest = Math.round((value - count * big.ms) / small.ms);
    // 59.6 min rounds to 60 min: that is one more hour
    if (rest * small.ms >= big.ms) {
      count += 1;
      rest = 0;
    }
    return rest > 0 ? `${whole[big.unit].format(count)} ${whole[small.unit].format(rest)}` : whole[big.unit].format(count);
  };
};

const part = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) =>
  parts.find((entry) => entry.type === type)?.value ?? "";

/**
 * Formats log entries for the table in the reader's language and time zone. `today` (YYYY-MM-DD in that zone) comes
 * from the server, so the first picture and every later load agree on which entries need their day.
 */
export const logRowFormatter = (locale: string, timeZone: string) => {
  const clock = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  const day = new Intl.DateTimeFormat(locale, { timeZone, day: "2-digit", month: "2-digit" });
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const duration = logDurationFormatter(locale);
  return {
    /** Today's date in the reader's zone, as the server knows it. */
    today: (now: Date) => {
      const parts = key.formatToParts(now);
      return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
    },
    row: (entry: LogEntry, today: string): LogRow => {
      const at = new Date(entry.createdAt);
      const keyParts = key.formatToParts(at);
      const date = `${part(keyParts, "year")}-${part(keyParts, "month")}-${part(keyParts, "day")}`;
      const hourMinute = `${part(keyParts, "hour")}:${part(keyParts, "minute")}`;
      const dayPrefix = date === today ? "" : `${day.format(at)} `;
      const durationValue = firstText(entry.metadata, DURATION_KEYS);
      return {
        id: entry.id,
        level: entry.level,
        source: entry.source,
        message: entry.message,
        time: `${dayPrefix}${clock.format(at)}`,
        minute: `${date} ${hourMinute}`,
        minuteLabel: `${dayPrefix}${hourMinute}`,
        requestId: requestIdOf(entry.metadata),
        duration: durationValue === null ? null : duration(Number(durationValue)),
      };
    },
  };
};
