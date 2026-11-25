import { expect, test } from "bun:test";
import { logDurationFormatter, logRowFormatter } from "./rows";

const entry = (createdAt: string, metadata: Record<string, unknown> | null) => ({
  id: "9001",
  level: "error" as const,
  source: "mail",
  message: "SMTP-Verbindung: Zeitüberschreitung",
  metadata,
  createdAt,
});

test("a row shows time to the millisecond, its minute, request ID and duration in the reader's zone", () => {
  const format = logRowFormatter("de", "Europe/Berlin");
  const today = format.today(new Date("2026-11-25T09:50:00.000Z"));
  expect(today).toBe("2026-11-25");
  expect(format.row(entry("2026-11-25T09:43:35.992Z", { requestId: "7f3a9c", durationMs: 30004 }), today)).toEqual({
    id: "9001",
    level: "error",
    source: "mail",
    message: "SMTP-Verbindung: Zeitüberschreitung",
    time: "10:43:35,992",
    minute: "2026-11-25 10:43",
    minuteLabel: "10:43",
    requestId: "7f3a9c",
    duration: "30 Sek.",
  });
});

test("an entry of another day carries its day; missing fields stay empty", () => {
  const format = logRowFormatter("en", "UTC");
  const row = format.row(entry("2026-11-24T23:59:01.005Z", { request_id: "b2", ms: 5 }), "2026-11-25");
  expect(row).toMatchObject({ time: "11/24 23:59:01.005", minuteLabel: "11/24 23:59", requestId: "b2", duration: null });
  expect(format.row(entry("2026-11-25T08:00:00.000Z", null), "2026-11-25")).toMatchObject({ requestId: null, duration: null });
});

test("a duration reads in the largest units that say it, and a negative or unreadable one is no duration", () => {
  const de = logDurationFormatter("de");
  expect([64, 999.6, 1392, 1_023_000, 4_611_686, 90_061_000].map(de)).toEqual([
    "64 ms",
    "1 Sek.",
    "1,4 Sek.",
    "17 Min. 3 Sek.",
    "1 Std. 17 Min.",
    "1 Tg. 1 Std.",
  ]);
  expect([-1, Number.NaN, Number.POSITIVE_INFINITY].map(de)).toEqual([null, null, null]);
  expect(logDurationFormatter("en")(4_611_686)).toBe("1 hr 17 min");
});

test("a row of a long run shows its duration in hours, and a duration of -1 shows none", () => {
  const format = logRowFormatter("de", "UTC");
  expect(format.row(entry("2026-11-25T08:00:00.000Z", { durationMs: 4_611_686 }), "2026-11-25").duration).toBe("1 Std. 17 Min.");
  expect(format.row(entry("2026-11-25T08:00:00.000Z", { durationMs: -1 }), "2026-11-25").duration).toBeNull();
});
