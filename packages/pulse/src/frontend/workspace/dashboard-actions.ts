import type { PulseDashboard, PulseDashboardConfig, PulseDashboardDslCompileResult } from "../../contracts";
import { jsonFetch } from "../http";

export const compileDashboardDslText = (baseId: string, text: string, signal?: AbortSignal): Promise<PulseDashboardDslCompileResult> =>
  jsonFetch<PulseDashboardDslCompileResult>("/api/pulse/dashboard-dsl/compile", {
    method: "POST",
    body: JSON.stringify({ baseId, text }),
    signal,
  });

export const dashboardDslCompileError = (error: unknown): PulseDashboardDslCompileResult => ({
  ok: false,
  diagnostics: [{ severity: "error", message: error instanceof Error ? error.message : "Could not compile dashboard", line: 1, column: 1 }],
  config: null,
});

export const savePulseDashboardConfig = (
  dashboard: PulseDashboard,
  config: PulseDashboardConfig,
  signal?: AbortSignal,
): Promise<PulseDashboard> =>
  jsonFetch<PulseDashboard>(`/api/pulse/dashboards/${dashboard.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: dashboard.name, config: { dsl: config.dsl, refreshIntervalSeconds: config.refreshIntervalSeconds } }),
    signal,
  });

export const createPublicDashboardToken = (
  dashboardId: string,
  signal?: AbortSignal,
): Promise<{ dashboard: PulseDashboard; token: string }> =>
  jsonFetch<{ dashboard: PulseDashboard; token: string }>(`/api/pulse/dashboards/${dashboardId}/public-token`, {
    method: "POST",
    body: "{}",
    signal,
  });

export const deletePublicDashboardToken = (dashboardId: string, signal?: AbortSignal): Promise<PulseDashboard> =>
  jsonFetch<PulseDashboard>(`/api/pulse/dashboards/${dashboardId}/public-token`, { method: "DELETE", signal });
