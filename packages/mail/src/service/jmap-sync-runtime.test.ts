import { expect, test } from "bun:test";
import type { JmapAccountScan } from "./connectors/jmap-account-state";
import {
  diffJmapMemberships,
  JMAP_SCAN_RESTART_LIMIT,
  JMAP_SCAN_STALL_MS,
  jmapScanRestarts,
  nextJmapScan,
  orderJmapMemberships,
} from "./jmap-sync-runtime";

test("primary membership prefers Inbox then opaque text order without mutating input", () => {
  const folders = [
    { mailboxId: "z", role: "archive" },
    { mailboxId: "b", role: "inbox" },
    { mailboxId: "A", role: "other" },
    { mailboxId: "a", role: "inbox" },
  ];
  expect(
    orderJmapMemberships(folders).map((folder) => folder.mailboxId),
    "primary: inbox and text order",
  ).toEqual(["a", "b", "A", "z"]);
  expect(folders[0]?.mailboxId, "primary: original preserved").toBe("z");
  expect(orderJmapMemberships(folders.filter((folder) => folder.role !== "inbox"))[0]?.mailboxId, "primary: no inbox").toBe("A");
  expect(orderJmapMemberships([]), "primary: empty").toEqual([]);
});

test("membership difference deduplicates, keeps unchanged refs and describes moves and last removal", () => {
  expect(diffJmapMemberships(["b", "c", "c"], ["a", "b"]), "diff: move").toEqual({ add: ["c"], remove: ["a"] });
  expect(diffJmapMemberships(["a"], ["a"]), "diff: unchanged").toEqual({ add: [], remove: [] });
  expect(diffJmapMemberships([], ["a"]), "diff: last membership").toEqual({ add: [], remove: ["a"] });
  expect(diffJmapMemberships(["a"], []), "diff: initial").toEqual({ add: ["a"], remove: [] });
});

const scan: JmapAccountScan = {
  reason: "initial",
  startedAt: "2026-11-20T00:00:00.000Z",
  step: { kind: "query", before: null },
  pages: 2,
  restarts: 1,
  stalledAt: null,
};
const now = "2026-11-20T00:05:00.000Z";
const bucket = (position: number, queryState: string | null = null) =>
  ({ kind: "bucket", second: "2026-11-19T10:00:08Z", position, queryState }) as const;

test("scan budget: shared with the IMAP folder job's attempts and recheck pause", () => {
  expect([JMAP_SCAN_RESTART_LIMIT, JMAP_SCAN_STALL_MS], "budget: 5 restarts, 15 minutes").toEqual([5, 15 * 60_000]);
});

test("scan step: a page advances, a completed second resets restarts, a bucket keeps them", () => {
  expect(nextJmapScan(scan, { kind: "page", next: bucket(3, "q") }, now), "bucket page").toEqual({
    ...scan,
    step: bucket(3, "q"),
    pages: 3,
  });
  for (const next of [
    { kind: "query", before: "2026-11-19T10:00:08Z" },
    { kind: "verify", after: null },
  ] as const)
    expect(nextJmapScan(scan, { kind: "page", next }, now), `${next.kind} page`).toEqual({ ...scan, step: next, pages: 3, restarts: 0 });
});

test("scan step: restarts count, the limit stalls at database time, an expired stall starts a fresh count", () => {
  expect(nextJmapScan(scan, { kind: "restart", next: bucket(0) }, now), "restart").toEqual({ ...scan, step: bucket(0), restarts: 2 });
  const limit = { ...scan, restarts: JMAP_SCAN_RESTART_LIMIT - 1 };
  expect(nextJmapScan(limit, { kind: "restart", next: bucket(0) }, now), "limit").toEqual({
    ...limit,
    step: bucket(0),
    restarts: JMAP_SCAN_RESTART_LIMIT,
    stalledAt: now,
  });
  const expired = { ...scan, restarts: JMAP_SCAN_RESTART_LIMIT, stalledAt: "2026-11-19T23:00:00.000Z" };
  expect(jmapScanRestarts(expired, { kind: "restart", next: bucket(0) }), "expired: restart").toBe(1);
  expect(nextJmapScan(expired, { kind: "page", next: bucket(3, "q") }, now), "expired: page").toEqual({
    ...expired,
    step: bucket(3, "q"),
    pages: 3,
    restarts: 0,
    stalledAt: null,
  });
});

test("scan step: verify moves the cursor without counting a page and a short page ends the scan", () => {
  const verifying = { ...scan, step: { kind: "verify", after: null } } as const;
  const after = { folderId: "00000000-004c-4000-8000-000000000009", emailId: "M9" };
  expect(nextJmapScan(verifying, { kind: "verify", after, complete: false }, now), "verify page").toEqual({
    ...verifying,
    step: { kind: "verify", after },
    restarts: 0,
  });
  expect(nextJmapScan(verifying, { kind: "verify", after, complete: true }, now), "verify end").toBeNull();
});
