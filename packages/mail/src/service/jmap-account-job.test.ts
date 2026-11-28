import { describe, expect, test } from "bun:test";
import type { JmapAccountScan, JmapSyncState } from "./connectors/jmap-account-state";
import { onJmapAccountJobError, routeJmapAccountTurn, summarizeJmapAccountTurn } from "./jmap-account-job";
import { JMAP_SCAN_STALL_MS } from "./jmap-sync-runtime";

const now = new Date("2026-11-21T09:00:00Z");
const scan = (change: Partial<JmapAccountScan> = {}): JmapAccountScan => ({
  reason: "initial",
  startedAt: "2026-11-21T08:00:00.000Z",
  step: { kind: "query", before: null },
  pages: 0,
  restarts: 0,
  stalledAt: null,
  ...change,
});
const state = (change: Partial<JmapSyncState> = {}): JmapSyncState => ({
  version: 2,
  emailState: "Email:1",
  mailboxState: "Mailbox:1",
  scan: null,
  ...change,
});

describe("routeJmapAccountTurn", () => {
  test("an account without a checkpoint or with a missing state starts a scan as background work", () => {
    for (const read of [
      { state: null, now },
      { state: state({ emailState: null }), now },
      { state: state({ mailboxState: null }), now },
    ]) {
      expect(routeJmapAccountTurn(read, "delta")).toEqual({ work: "start", phase: "scan" });
      expect(routeJmapAccountTurn(read, "scan")).toEqual({ work: "start", phase: "scan" });
    }
  });

  test("a delta turn runs the delta first, even while a scan runs", () => {
    expect(routeJmapAccountTurn({ state: state(), now }, "delta")).toEqual({ work: "delta", phase: "delta" });
    expect(routeJmapAccountTurn({ state: state({ scan: scan() }), now }, "delta")).toEqual({ work: "delta", phase: "delta" });
  });

  test("a scan turn without a running scan asks for a delta; with one, it takes the next step", () => {
    expect(routeJmapAccountTurn({ state: state(), now }, "scan")).toEqual({ work: "delta", phase: "delta" });
    expect(routeJmapAccountTurn({ state: state({ scan: scan() }), now }, "scan")).toEqual({ work: "scan", phase: "scan" });
  });

  test("a stalled scan waits out its pause, then goes on", () => {
    const within = new Date(now.getTime() - JMAP_SCAN_STALL_MS + 1_000).toISOString();
    const expired = new Date(now.getTime() - JMAP_SCAN_STALL_MS - 1_000).toISOString();
    expect(routeJmapAccountTurn({ state: state({ scan: scan({ stalledAt: within }) }), now }, "scan")).toEqual({
      work: "stalled",
      phase: "scan",
    });
    expect(routeJmapAccountTurn({ state: state({ scan: scan({ stalledAt: expired }) }), now }, "scan")).toEqual({
      work: "scan",
      phase: "scan",
    });
  });
});

describe("onJmapAccountJobError", () => {
  const context = (attempt: number) => ({
    input: { remoteResourceId: "00000000-0000-4000-8000-000000000001", phase: "delta" as const },
    attempt,
  });

  test("retries until the folder job's last attempt, then dead-letters", () => {
    for (const attempt of [1, 2, 3, 4])
      expect(onJmapAccountJobError({ context: context(attempt), error: new Error("x") })).toEqual({ action: "retry" });
    expect(onJmapAccountJobError({ context: context(5), error: new Error("exhausted") })).toEqual({
      action: "dead_letter",
      reason: "exhausted",
    });
  });
});

describe("summarizeJmapAccountTurn", () => {
  const stats = { imported: 0, memberships: 0, flagsUpdated: 0, removed: 0, folders: 0, skippedDrafts: 0 };

  test("busy, parked, cooling and quiet turns leave no trace; changes, scans and refusals do", () => {
    expect(summarizeJmapAccountTurn({ kind: "deferred", code: "SYNC_BUSY" })).toBeNull();
    expect(summarizeJmapAccountTurn({ kind: "deferred", code: "MAIL_RATE_LIMITED", retryAfterMs: 1_000 })).toBeNull();
    expect(summarizeJmapAccountTurn({ kind: "ended", reason: "paused" })).toBeNull();
    expect(
      summarizeJmapAccountTurn({
        kind: "delta",
        result: { status: "committed", hasMore: false, stats, hydrationRequested: false, emailAdvanced: false },
      }),
    ).toBeNull();
    expect(
      summarizeJmapAccountTurn({
        kind: "delta",
        result: {
          status: "committed",
          hasMore: false,
          stats: { ...stats, imported: 1, memberships: 1 },
          hydrationRequested: true,
          emailAdvanced: true,
        },
      }),
    ).toEqual({ pass: "delta", ...stats, imported: 1, memberships: 1 });
    expect(summarizeJmapAccountTurn({ kind: "scan", result: { status: "delta_required" } })).toEqual({
      pass: "scan",
      status: "delta_required",
    });
    expect(summarizeJmapAccountTurn({ kind: "ended", reason: "auth_required" })).toEqual({ ended: "auth_required" });
  });
});
