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

const part = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";

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
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
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
      const duration = firstText(entry.metadata, DURATION_KEYS);
      const durationNumber = duration === null ? Number.NaN : Number(duration);
      return {
        id: entry.id,
        level: entry.level,
        source: entry.source,
        message: entry.message,
        time: `${dayPrefix}${clock.format(at)}`,
        minute: `${date} ${hourMinute}`,
        minuteLabel: `${dayPrefix}${hourMinute}`,
        requestId: firstText(entry.metadata, REQUEST_KEYS),
        duration: Number.isFinite(durationNumber) ? `${number.format(durationNumber)} ms` : null,
      };
    },
  };
};
