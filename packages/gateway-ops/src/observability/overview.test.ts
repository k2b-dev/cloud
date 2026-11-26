import { describe, expect, test } from "bun:test";
import { buildOverviewSignals, type OverviewSignalInput, overviewVerdict } from "./overview";

const healthyInput = (overrides: Partial<OverviewSignalInput> = {}): OverviewSignalInput => ({
  range: "24h",
  jobsWindow: "24h",
  offlineApps: [],
  serverErrors: 0,
  rateLimited: 0,
  failedRuns: 0,
  stuckRuns: 0,
  logErrors: 0,
  unavailable: {},
  ...overrides,
});

describe("observability overview triage", () => {
  test("keeps a healthy system empty and explicit", () => {
    const signals = buildOverviewSignals(healthyInput());
    expect(signals).toEqual([]);
    expect(overviewVerdict(signals)).toMatchObject({ tone: "ok", label: "No active incidents" });
  });

  test("orders critical issues before unavailable and warning signals", () => {
    const signals = buildOverviewSignals(
      healthyInput({
        offlineApps: ["mail", "grids", "contacts", "spaces", "files"],
        serverErrors: 3,
        failedRuns: 2,
        rateLimited: 4,
        unavailable: { logs: "connection refused" },
      }),
    );

    expect(signals.map((signal) => signal.id)).toEqual([
      "offline-apps",
      "server-errors",
      "unavailable-logs",
      "failed-runs",
      "rate-limited",
    ]);
    expect(signals[0]?.detail).toBe("mail, grids, contacts, spaces and 1 more");
    expect(overviewVerdict(signals)).toMatchObject({ tone: "error", label: "Needs attention" });
  });

  test("does not mistake missing observability data for a healthy system", () => {
    const signals = buildOverviewSignals(healthyInput({ unavailable: { telemetry: "query timed out" } }));
    expect(overviewVerdict(signals)).toEqual({
      tone: "degraded",
      label: "Visibility degraded",
      description: "1 signal source could not be read.",
    });
  });

  test("each signal leads to the v2 page that looks at it, in the overview's window", () => {
    const signals = buildOverviewSignals(
      healthyInput({ range: "6h", jobsWindow: "12h", serverErrors: 1, stuckRuns: 1, failedRuns: 1, unavailable: { runs: "down" } }),
    );
    expect(Object.fromEntries(signals.map((signal) => [signal.id, signal.href]))).toEqual({
      "server-errors": "/admin/observability/telemetry?range=6h&only=errors",
      "stuck-runs": "/admin/observability/runs?kind=job&status=running&time=last-12h",
      "unavailable-runs": "/admin/observability/runs?kind=job&time=last-12h",
      "failed-runs": "/admin/observability/runs?kind=job&status=failed&time=last-12h",
    });
  });
});
