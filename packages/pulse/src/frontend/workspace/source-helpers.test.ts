import { expect, test } from "bun:test";
import type { PulseSource } from "../../contracts";
import { sourceStatus } from "./source-helpers";

const labels = {
  paused: "paused",
  throttled: "throttled",
  throttledDetail: "detail",
  error: "error",
  stale: "stale",
  healthy: "healthy",
  waiting: "waiting",
};
const source: PulseSource = {
  id: "Src001",
  baseId: "Base01",
  kind: "http_ingest",
  name: "Push",
  enabled: true,
  endpointUrl: null,
  bearerTokenConfigured: false,
  scrapeIntervalSeconds: null,
  metricFilters: [],
  revision: 1,
  expectEverySeconds: 3600,
  expectDailyBy: null,
  staleSince: null,
  status: {
    newestDataAt: null,
    throttled: false,
    throttledAt: null,
    refusedHistograms: [],
    skippedSummaries: 0,
    lastError: null,
    lastErrorAt: null,
  },
  lastSeenAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-11-21T10:00:00.000Z",
  updatedAt: "2026-11-21T10:00:00.000Z",
};
const stale = { ...source, staleSince: "2026-11-21T11:00:00.000Z", status: { ...source.status, newestDataAt: "2026-11-21T09:00:00.000Z" } };

test("source status order: paused, throttled, error, stale, healthy, waiting", () => {
  expect(sourceStatus(source, labels).label).toBe("waiting");
  expect(sourceStatus({ ...source, lastSeenAt: "2026-11-21T09:00:00.000Z" }, labels).label).toBe("healthy");
  expect(sourceStatus(stale, labels)).toEqual({ label: "stale", tone: "warning" });
  const failing = { ...stale, status: { ...stale.status, lastError: "refused" } };
  expect(sourceStatus(failing, labels).label).toBe("error");
  const throttled = { ...failing, status: { ...failing.status, throttled: true } };
  expect(sourceStatus(throttled, labels).label).toBe("throttled");
  expect(sourceStatus({ ...throttled, enabled: false }, labels).label).toBe("paused");
});
