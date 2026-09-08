import { describe, expect, test } from "bun:test";
import type { ScheduleInfo } from "@k2b/sync";
import { scheduleRuntimeState } from "./workflow-runtime";

const schedule = { cron: "0 * * * *", timezone: "UTC" };
const registered = (overrides: { failureCount?: number; lastError?: string } = {}): ScheduleInfo => ({
  id: "grids:workflow:one",
  cron: schedule.cron,
  timezone: schedule.timezone,
  misfire: "latest",
  meta: { revision: 3 },
  nextRunAt: new Date("2026-09-08T12:00:00.000Z"),
  runNumber: 4,
  failureCount: overrides.failureCount ?? 0,
  ...(overrides.lastError === undefined ? {} : { lastError: overrides.lastError }),
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  handlerAvailable: true,
});

describe("workflow schedule runtime state", () => {
  test("stays reconciled after an earlier failure once a later run succeeded", () => {
    // failureCount never resets; only lastError tells whether the latest run failed.
    expect(scheduleRuntimeState({ revision: 3, enabled: true }, schedule, registered({ failureCount: 2 }))).toEqual({
      ...schedule,
      state: "reconciled",
      nextRunAt: "2026-09-08T12:00:00.000Z",
      problem: null,
    });
  });

  test("reports the last error while the latest run failed", () => {
    expect(
      scheduleRuntimeState({ revision: 3, enabled: true }, schedule, registered({ failureCount: 1, lastError: "endpoint unreachable" })),
    ).toEqual({ ...schedule, state: "degraded", nextRunAt: null, problem: "endpoint unreachable" });
  });

  test("waits for reconciliation when the registration lags the revision", () => {
    expect(scheduleRuntimeState({ revision: 4, enabled: true }, schedule, registered()).state).toBe("pending");
    expect(scheduleRuntimeState({ revision: 4, enabled: false }, schedule, registered()).state).toBe("paused");
  });
});
