import { expect, test } from "bun:test";
import { type FreshnessSource, SourceExpectationSchema, sourceStaleSince } from "./source-staleness";

const source: FreshnessSource = {
  kind: "metrics",
  enabled: true,
  scrapeIntervalSeconds: 60,
  expectEverySeconds: null,
  expectDailyBy: null,
  newestDataAt: "2026-10-20T10:00:00Z",
  createdAt: "2026-10-19T10:00:00Z",
};
const stale = (changes: Partial<FreshnessSource>, at: string) => sourceStaleSince({ ...source, ...changes }, "Europe/Berlin", new Date(at));
test("scraping uses newest data and exactly three missed intervals, not contact", () => {
  expect(stale({}, "2026-10-20T10:02:59Z")).toBeNull();
  expect(stale({}, "2026-10-20T10:03:00Z")).toBe("2026-10-20T10:03:00.000Z");
  expect(stale({ newestDataAt: null }, "2026-10-19T10:03:00Z")).toBe("2026-10-19T10:03:00.000Z");
  expect(stale({ enabled: false }, "2026-10-21T00:00:00Z")).toBeNull();
  expect(stale({ deleted: true }, "2026-10-21T00:00:00Z")).toBeNull();
});
test("a push source without an expectation is never stale; explicit intervals are exact", () => {
  expect(stale({ kind: "http_ingest" }, "2027-01-01T00:00:00Z")).toBeNull();
  expect(stale({ kind: "http_ingest", expectEverySeconds: 3600 }, "2026-10-20T10:59:59Z")).toBeNull();
  expect(stale({ kind: "http_ingest", expectEverySeconds: 3600 }, "2026-10-20T11:00:00Z")).toBe("2026-10-20T11:00:00.000Z");
});
test.each([
  ["2026-03-29T01:59:59Z", "2026-03-29T02:00:00Z", "2026-03-28T04:00:00Z", "2026-03-28T02:00:00Z"],
  ["2026-10-25T02:59:59Z", "2026-10-25T03:00:00Z", "2026-10-24T03:00:00Z", "2026-10-24T01:00:00Z"],
])("daily 04:00 follows the base calendar across DST (%s)", (before, due, freshData, oldData) => {
  const daily = { ...source, kind: "http_ingest" as const, expectDailyBy: "04:00", createdAt: "2026-01-01T00:00:00Z" };
  expect(sourceStaleSince({ ...daily, newestDataAt: oldData }, "Europe/Berlin", new Date(before))).toBeNull();
  expect(sourceStaleSince({ ...daily, newestDataAt: oldData }, "Europe/Berlin", new Date(due))).toBe(new Date(due).toISOString());
  expect(sourceStaleSince({ ...daily, newestDataAt: freshData }, "Europe/Berlin", new Date(due))).toBeNull();
});
test("ambiguous daily times wait for the later occurrence and new sources get a complete window", () => {
  const daily = { ...source, kind: "http_ingest" as const, expectDailyBy: "02:30", newestDataAt: "2026-10-24T00:00:00Z" };
  expect(sourceStaleSince(daily, "Europe/Berlin", new Date("2026-10-25T00:30:00Z"))).toBeNull();
  expect(sourceStaleSince(daily, "Europe/Berlin", new Date("2026-10-25T01:30:00Z"))).toBe("2026-10-25T01:30:00.000Z");
  expect(
    sourceStaleSince(
      { ...daily, createdAt: "2026-10-25T01:35:00Z", newestDataAt: null },
      "Europe/Berlin",
      new Date("2026-10-25T04:00:00Z"),
    ),
  ).toBeNull();
});
test("push expectation rejects conflicting modes and invalid wall times", () => {
  expect(SourceExpectationSchema.safeParse({ expectEverySeconds: null, expectDailyBy: "04:00" }).success).toBe(true);
  for (const value of [
    { expectEverySeconds: 60, expectDailyBy: "04:00" },
    { expectEverySeconds: 0, expectDailyBy: null },
    { expectEverySeconds: null, expectDailyBy: "24:00" },
  ])
    expect(SourceExpectationSchema.safeParse(value).success).toBe(false);
});
