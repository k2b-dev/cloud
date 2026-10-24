import type { Dashboard, DashboardRange } from "../../dashboard-contracts";
import type { DashboardPanelResult, PublicDashboardPanel } from "../../service/dashboard-panels";
import { jsonFetch } from "../http";

export type { DashboardPanelResult, PublicDashboardPanel };
export type DashboardPage = { items: Dashboard[]; total: number; nextOffset: number | null };
export type PublicDashboard = { id: string; name: string; revision: number; panels: PublicDashboardPanel[] };
export type DashboardTarget = { baseId: string; dashboardId: string } | { token: string };
export type DashboardSnapshot = {
  items: Dashboard[];
  total: number;
  nextOffset: number | null;
  selected: Dashboard | null;
  error: { code: string; message: string } | null;
};
export class DashboardClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const request = <T>(url: string, init?: RequestInit) =>
  jsonFetch<T>(
    url,
    { cache: "no-store", referrerPolicy: "no-referrer", ...init },
    "REQUEST_FAILED",
    (status, body) =>
      new DashboardClientError(
        status,
        body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "REQUEST_FAILED",
      ),
  );
const path = (target: DashboardTarget) =>
  "token" in target
    ? `/api/pulse/public/${encodeURIComponent(target.token)}`
    : `/api/pulse/bases/${encodeURIComponent(target.baseId)}/dashboards/${encodeURIComponent(target.dashboardId)}`;
export const dashboardRangeSearch = (range: DashboardRange) => {
  const search = new URLSearchParams({ range: range.range ?? "24h" });
  if (range.from && range.to) {
    search.set("from", range.from);
    search.set("to", range.to);
  }
  return search.toString();
};
export const dashboardClient = {
  list: (baseId: string, offset: number, signal?: AbortSignal) =>
    request<DashboardPage>(`/api/pulse/bases/${encodeURIComponent(baseId)}/dashboards?offset=${offset}`, { signal }),
  panel: (target: DashboardTarget, panelId: string, range: DashboardRange, signal: AbortSignal) =>
    request<DashboardPanelResult>(`${path(target)}/panels/${encodeURIComponent(panelId)}?${dashboardRangeSearch(range)}`, { signal }),
  get: (target: DashboardTarget, signal?: AbortSignal) => request<Dashboard>(path(target), { signal }),
  publish: (
    target: Exclude<DashboardTarget, { token: string }>,
    expectedRevision: number,
    columns: Record<string, string[]>,
    key: string,
    signal: AbortSignal,
  ) =>
    request<{ href: string; revision: number }>(`${path(target)}/publish`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, columns }),
      headers: { "Idempotency-Key": key },
      signal,
    }),
  revoke: (target: Exclude<DashboardTarget, { token: string }>, expectedRevision: number, key: string, signal: AbortSignal) =>
    request<{ deleted: boolean; revision: number }>(`${path(target)}/unpublish`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
      headers: { "Idempotency-Key": key },
      signal,
    }),
};
