import { expect, test } from "bun:test";
import { logRowFormatter } from "./rows";

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
    duration: "30.004 ms",
  });
});

test("an entry of another day carries its day; missing fields stay empty", () => {
  const format = logRowFormatter("en", "UTC");
  const row = format.row(entry("2026-11-24T23:59:01.005Z", { request_id: "b2", ms: 5 }), "2026-11-25");
  expect(row).toMatchObject({ time: "11/24 23:59:01.005", minuteLabel: "11/24 23:59", requestId: "b2", duration: null });
  expect(format.row(entry("2026-11-25T08:00:00.000Z", null), "2026-11-25")).toMatchObject({ requestId: null, duration: null });
});
