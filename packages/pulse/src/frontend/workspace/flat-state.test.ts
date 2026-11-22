import { describe, expect, test } from "bun:test";
import type { PulseSource } from "../../contracts";
import type { AlertAttention } from "../../service/base-attention";
import { attentionItems, basePageState, newestArrival, sourceProblem, sourcesSummary } from "./flat-state";

const source = (id: string, overrides: Partial<PulseSource> = {}, status: Partial<PulseSource["status"]> = {}): PulseSource => ({
  id,
  baseId: "Base01",
  kind: "http_ingest",
  name: id,
  enabled: true,
  endpointUrl: null,
  bearerTokenConfigured: false,
  scrapeIntervalSeconds: null,
  metricFilters: [],
  revision: 1,
  expectEverySeconds: null,
  expectDailyBy: null,
  staleSince: null,
  status: {
    newestDataAt: "2026-10-19T12:00:00.000Z",
    throttled: false,
    throttledAt: null,
    refusedHistograms: [],
    skippedSummaries: 0,
    lastError: null,
    lastErrorAt: null,
    ...status,
  },
  lastSeenAt: "2026-10-19T12:00:00.000Z",
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
  ...overrides,
});
const alert = (id: string, state: AlertAttention["state"], severity: AlertAttention["severity"], since: string): AlertAttention => ({
  reference: id,
  name: id,
  state,
  severity,
  since,
  lastCheckedAt: null,
  errorCode: null,
  key: null,
  value: null,
  comparison: "above",
  threshold: null,
});

describe("base page state", () => {
  test("no access wins, a base switch replaces the page, a lost store comes before an empty base", () => {
    const base = { denied: false, switching: false, storeDown: false, sourceCount: 3 };
    expect(basePageState({ ...base, denied: true, switching: true, storeDown: true })).toBe("noAccess");
    expect(basePageState({ ...base, switching: true, storeDown: true })).toBe("loading");
    expect(basePageState({ ...base, storeDown: true, sourceCount: 0 })).toBe("storeDown");
    expect(basePageState({ ...base, sourceCount: 0 })).toBe("empty");
    expect(basePageState(base)).toBe("ready");
  });
});

describe("sources summary", () => {
  test("says whether data arrives", () => {
    expect(sourcesSummary([])).toEqual({ kind: "empty" });
    expect(sourcesSummary([source("a"), source("b")])).toEqual({ kind: "all", total: 2 });
    expect(sourcesSummary([source("a"), source("b", { lastSeenAt: null }, { newestDataAt: null })])).toEqual({
      kind: "some",
      received: 1,
      total: 2,
    });
    expect(sourcesSummary([source("a", { staleSince: "2026-10-19T11:00:00.000Z" }), source("b", {}, { lastError: "timeout" })])).toEqual({
      kind: "attention",
      count: 2,
    });
  });

  test("a paused source never needs attention, and refused requests outrank its other problems", () => {
    expect(sourceProblem(source("a", { enabled: false }, { lastError: "timeout" }))).toBeNull();
    expect(
      sourceProblem(
        source(
          "a",
          { staleSince: "2026-10-19T11:00:00.000Z" },
          { lastError: "x", rejected: { last24h: 2, lastReason: null, lastAt: null } },
        ),
      ),
    ).toBe("rejected");
    expect(sourceProblem(source("a", {}, { rejected: { last24h: 0, lastReason: null, lastAt: null } }))).toBeNull();
  });

  test("the newest arrival is the latest over all sources", () => {
    expect(newestArrival([source("a"), source("b", {}, { newestDataAt: "2026-10-19T12:30:00.000Z" })])).toBe("2026-10-19T12:30:00.000Z");
    expect(newestArrival([])).toBeNull();
  });
});

describe("attention order", () => {
  test("sources that send without arriving, critical then warning alerts, throttled, stale, then unchecked alerts", () => {
    const items = attentionItems(
      [
        source("stale", { staleSince: "2026-10-19T09:00:00.000Z" }),
        source("throttled", {}, { throttled: true, throttledAt: "2026-10-19T10:00:00.000Z" }),
        source("refused", {}, { rejected: { last24h: 4, lastReason: "value is text", lastAt: "2026-10-19T12:10:00.000Z" } }),
        source("fine"),
      ],
      [
        alert("unchecked", "error", null, "2026-10-19T08:00:00.000Z"),
        alert("warn", "firing", "warn", "2026-10-19T08:00:00.000Z"),
        alert("critical", "firing", "critical", "2026-10-19T11:00:00.000Z"),
      ],
    );
    expect(items.map((item) => (item.kind === "source" ? item.source.id : item.alert.reference))).toEqual([
      "refused",
      "critical",
      "warn",
      "throttled",
      "stale",
      "unchecked",
    ]);
    expect(items.map((item) => item.tone)).toEqual(["danger", "danger", "warning", "warning", "warning", "warning"]);
  });

  test("older problems come first within one rank", () => {
    const items = attentionItems(
      [
        source("later", {}, { lastError: "x", lastErrorAt: "2026-10-19T12:00:00.000Z" }),
        source("earlier", {}, { lastError: "x", lastErrorAt: "2026-10-19T10:00:00.000Z" }),
      ],
      [
        alert("no-data-later", "no_data", null, "2026-10-19T09:00:00.000Z"),
        alert("no-data-earlier", "no_data", null, "2026-10-19T08:00:00.000Z"),
      ],
    );
    expect(items.map((item) => item.id)).toEqual(["source:earlier", "source:later", "alert:no-data-earlier", "alert:no-data-later"]);
  });
});
