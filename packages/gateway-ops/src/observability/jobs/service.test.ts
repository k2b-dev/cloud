import { describe, expect, test } from "bun:test";
import type { TraceSourceGroup } from "@k2b/cloud/services";
import type { SyncScheduleRow } from "../sync/service";
import { buildBackgroundJobRows, filterBackgroundJobRows, normalizeScheduleMetadata } from "./service";

const schedule = (overrides: Partial<SyncScheduleRow> = {}): SyncScheduleRow => ({
  schedulerId: "gateway-ops-lifecycle",
  id: "gateway:health-webhook-check",
  cron: "*/5 * * * *",
  timezone: "Europe/Berlin",
  createdAt: new Date(1).toISOString(),
  updatedAt: new Date(2).toISOString(),
  nextRunAt: new Date(3).toISOString(),
  appId: "gateway-ops",
  appName: "Gateway Ops",
  misfire: "latest",
  lastError: null,
  lastRunId: null,
  lastCompletedAt: null,
  runNumber: 4,
  failureCount: 0,
  handlerAvailable: true,
  meta: {
    appId: "gateway-ops",
    family: "gateway:health",
    label: "Gateway health webhook check",
    source: "gateway:health-webhook-check",
    resourceKind: "webhook",
    resourceId: "health",
    resourceLabel: "Health webhook",
    detailHref: "/admin/observability/health-webhooks",
  },
  ...overrides,
});

const group = (source: string, overrides: Partial<TraceSourceGroup> = {}): TraceSourceGroup => ({
  source,
  appId: "gateway-ops",
  categories: ["schedule"],
  names: ["Gateway health webhook check"],
  runs: 10,
  jobRuns: 0,
  scheduleRuns: 10,
  aiRuns: 0,
  customRuns: 0,
  running: 0,
  stuck: 0,
  anomalous: 0,
  succeeded: 9,
  failed: 1,
  errorRate: 10,
  avgDurationMs: 42,
  p95DurationMs: 84,
  p99DurationMs: 100,
  latestName: "Gateway health webhook check",
  latestCategory: "schedule",
  latestStatus: "ok",
  latestStartedAt: "2026-07-09T12:00:00.000Z",
  latestEndedAt: "2026-07-09T12:00:00.050Z",
  latestDurationMs: 50,
  ...overrides,
});

describe("jobs observability service", () => {
  test("normalizes scheduler meta with safe fallbacks", () => {
    expect(normalizeScheduleMetadata(schedule())).toEqual({
      appId: "gateway-ops",
      family: "gateway:health",
      label: "Gateway health webhook check",
      source: "gateway:health-webhook-check",
      resourceKind: "webhook",
      resourceId: "health",
      resourceLabel: "Health webhook",
      detailHref: "/admin/observability/health-webhooks",
    });

    expect(normalizeScheduleMetadata(schedule({ meta: { detailHref: "https://example.org/out", label: "  " } }))).toEqual({
      appId: "gateway-ops",
      family: "gateway:health-webhook-check",
      label: "gateway:health-webhook-check",
      source: "gateway:health-webhook-check",
      resourceKind: null,
      resourceId: null,
      resourceLabel: null,
      detailHref: null,
    });
  });

  test("builds schedule rows joined by trace source and keeps trace-only rows", () => {
    const rows = buildBackgroundJobRows(
      [schedule()],
      [group("gateway:health-webhook-check"), group("auth:ipa:backfill", { categories: ["job"], latestName: "IPA backfill" })],
    );

    const scheduleRow = rows.find((row) => row.kind === "schedule");
    expect(scheduleRow).toMatchObject({
      kind: "schedule",
      schedulerId: "gateway-ops-lifecycle",
      scheduleId: "gateway:health-webhook-check",
      source: "gateway:health-webhook-check",
      resourceKind: "webhook",
      resourceId: "health",
      detailHref: "/admin/observability/health-webhooks",
      trace: { runs: 10, failed: 1 },
    });

    const traceOnlyRow = rows.find((row) => row.kind === "trace");
    expect(traceOnlyRow).toMatchObject({
      kind: "trace",
      source: "auth:ipa:backfill",
      label: "IPA backfill",
      state: "trace-only",
      detailHref: null,
    });
  });

  test("filters rows by type, health, source, search, and trace requirement", () => {
    const rows = buildBackgroundJobRows(
      [
        schedule(),
        schedule({
          id: "gateway:telemetry:cleanup",
          meta: {
            appId: "gateway-ops",
            family: "gateway:telemetry",
            label: "Gateway telemetry cleanup",
            source: "gateway:telemetry:cleanup",
          },
        }),
      ],
      [
        group("gateway:health-webhook-check"),
        group("auth:ipa:backfill", { categories: ["job"], latestStatus: "error" }),
        group("mail:sender-rule-backfill", {
          categories: ["backfill"],
          latestCategory: "backfill",
          latestName: "Sender rule backfill",
        }),
      ],
    );

    expect(filterBackgroundJobRows(rows, { search: "telemetry" }).map((row) => row.source)).toEqual(["gateway:telemetry:cleanup"]);
    expect(filterBackgroundJobRows(rows, { type: "job" }).map((row) => row.source)).toEqual(["auth:ipa:backfill"]);
    expect(filterBackgroundJobRows(rows, { type: "backfill" }).map((row) => row.source)).toEqual(["mail:sender-rule-backfill"]);
    expect(filterBackgroundJobRows(rows, { health: "failed" }).map((row) => row.source)).toEqual(["auth:ipa:backfill"]);
    expect(filterBackgroundJobRows(rows, { source: "gateway:health-webhook-check" }).map((row) => row.source)).toEqual([
      "gateway:health-webhook-check",
    ]);
    expect(
      filterBackgroundJobRows(rows, { requireTraceMatch: true })
        .map((row) => row.source)
        .sort(),
    ).toEqual(["auth:ipa:backfill", "gateway:health-webhook-check", "mail:sender-rule-backfill"]);
  });
});

describe("partial scheduler availability", () => {
  test("keeps healthy schedules and surfaces unavailable app warnings", async () => {
    const { spyOn } = await import("bun:test");
    const { syncOpsService } = await import("../sync/runtime");
    const { jobsObservabilityService } = await import("./service");
    const overview = spyOn(syncOpsService, "overview").mockResolvedValue({
      sampledAt: "2026-09-08T12:00:00Z",
      apps: [
        { appId: "grids", appName: "Grids", appIcon: "", status: "unavailable", error: "Connection refused", health: null },
        { appId: "gateway-ops", appName: "Gateway Ops", appIcon: "", status: "ok", error: null, health: null },
      ],
      schedules: [schedule()],
      resources: [],
      deadLetters: [],
      truncatedStores: [],
    });
    try {
      const result = await jobsObservabilityService.listSchedules({});
      expect(result.schedules).toEqual([schedule()]);
      expect(result.warnings).toEqual(["Grids: Connection refused"]);
    } finally {
      overview.mockRestore();
    }
  });
});
