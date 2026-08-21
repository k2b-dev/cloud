import { describe, expect, test } from "bun:test";
import {
  buildLoadReport,
  deterministicRecordId,
  LOAD_FIXTURE_MARKER,
  type LoadHealthSnapshot,
  LoadManifestSchema,
  loadRecordShortId,
  parsePositiveInteger,
  parseProfile,
  reserveLoadRecordShortIds,
} from "./load-test-support";

const health = (overrides: Partial<LoadHealthSnapshot["operational"]> = {}): LoadHealthSnapshot => ({
  capturedAt: "2026-07-22T10:00:00.000Z",
  operational: {
    status: "ok",
    outbox: { dead: 0, failed: 0, pending: 0 },
    workflows: { needsAttention: 0, staleRunning: 0 },
    effects: { needsAttention: 0 },
    ...overrides,
  },
  postgres: {
    activeConnections: 1,
    databaseBytes: 1_000,
    idleConnections: 2,
    maxConnections: 100,
    totalConnections: 3,
  },
  fixture: {
    workflowActive: 0,
    workflowFailed: 0,
    recordEventsPending: 0,
    recordEventsFailed: 0,
    recordEventsDead: 0,
  },
  containers: [],
});

describe("load test support", () => {
  test("creates stable valid UUIDs", () => {
    expect(deterministicRecordId("ABCDEF12", 1)).toBe("abcdef12-0000-4000-8000-000000000001");
    expect(deterministicRecordId("abcdef12", 0xffffffffffff)).toBe("abcdef12-0000-4000-8000-ffffffffffff");
    expect(() => deterministicRecordId("bad", 1)).toThrow();
    expect(() => deterministicRecordId("abcdef12", 0)).toThrow();
  });

  test("reserves a collision-free contiguous public Record ID range", () => {
    expect(loadRecordShortId(0)).toBe("000000");
    expect(loadRecordShortId(62)).toBe("000010");
    expect(loadRecordShortId(62 ** 6 - 1)).toBe("zzzzzz");
    expect(reserveLoadRecordShortIds(["000000", "000003"], 2)).toBe(1);
    expect(reserveLoadRecordShortIds(["000000", "000001", "000003"], 2)).toBe(4);
  });

  test("validates profiles and positive integers", () => {
    expect(parseProfile("soak")).toBe("soak");
    expect(() => parseProfile("fast")).toThrow();
    expect(parsePositiveInteger(undefined, 10, "rows")).toBe(10);
    expect(() => parsePositiveInteger("0", 10, "rows")).toThrow();
  });

  test("rejects manifests without the safety marker", () => {
    const result = LoadManifestSchema.safeParse({ version: 3, marker: "other" });
    expect(result.success).toBe(false);
    expect(LOAD_FIXTURE_MARKER).toBe("grids-local-load-fixture");
  });

  test("passes a healthy run and fails new queue damage", () => {
    const summary = {
      state: { testRunDurationMs: 10_000 },
      metrics: {
        http_reqs: { values: { count: 100 } },
        http_req_failed: { values: { rate: 0 } },
        business_errors: { values: { rate: 0 } },
        rate_limited_requests: { values: { count: 0 } },
        ingress_rate_limited_requests: { values: { count: 0 } },
        query_overloaded_requests: { values: { count: 0 } },
        checks: { values: { rate: 1 } },
        http_req_duration: { values: { "p(95)": 200, "p(99)": 400 } },
      },
    };
    const passing = buildLoadReport({
      profile: "load",
      k6ExitCode: 0,
      rows: 10_000,
      startedAt: "2026-07-22T10:00:00.000Z",
      finishedAt: "2026-07-22T10:00:10.000Z",
      summary,
      before: health(),
      after: health(),
    });
    expect(passing.passed).toBe(true);
    expect(passing.requestsPerSecond).toBe(10);
    expect(passing.rateLimitedRequests).toBe(0);
    expect(passing.ingressRateLimitedRequests).toBe(0);
    expect(passing.queryOverloadedRequests).toBe(0);

    const failing = buildLoadReport({
      ...passing,
      k6ExitCode: 0,
      summary,
      before: health(),
      after: health({ outbox: { dead: 1, failed: 0, pending: 0 } }),
    });
    expect(failing.passed).toBe(false);
    expect(failing.gates.find((gate) => gate.name === "Dead record events")?.passed).toBe(false);

    const crashed = buildLoadReport({ ...passing, k6ExitCode: 2, summary: {} });
    expect(crashed.passed).toBe(false);
    expect(crashed.gates.find((gate) => gate.name === "k6 process")?.passed).toBe(false);
  });
});
