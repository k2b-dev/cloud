import type {
  AdminBaseRow,
  AdminBasesPage,
  BaseLimits,
  InternalTarget,
  InternalTargetsPage,
  OrphanDatabasesPage,
  PulsePolicy,
  PulsePolicyUpdate,
  ReadProfileName,
} from "../../store/admin-contracts";
import { jsonFetch } from "../http";

/** A refusal of the Pulse admin API: its fixed code only, never a remote message. */
export class AdminClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const failure = (status: number, body: unknown): AdminClientError =>
  new AdminClientError(
    status,
    body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "ADMIN_REQUEST_FAILED",
  );
const request = <T>(path: string, init?: RequestInit) =>
  jsonFetch<T>(`/api/pulse/admin${path}`, { ...init, credentials: "same-origin" }, "ADMIN_REQUEST_FAILED", failure);
const page = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
};

export const adminClient = {
  policy: (signal?: AbortSignal) => request<PulsePolicy>("/policy", { signal }),
  savePolicy: (input: PulsePolicyUpdate, signal?: AbortSignal) =>
    request<PulsePolicy>("/policy", { method: "PUT", body: JSON.stringify(input), signal }),
  bases: (params: { limit?: number; offset?: number; q?: string }, signal?: AbortSignal) =>
    request<AdminBasesPage>(`/bases${page(params)}`, { signal }),
  saveLimits: (baseId: string, input: { profile?: ReadProfileName; limits?: Partial<BaseLimits> }, signal?: AbortSignal) =>
    request<AdminBaseRow>(`/bases/${encodeURIComponent(baseId)}/limits`, { method: "PUT", body: JSON.stringify(input), signal }),
  baseAction: (baseId: string, action: "retry" | "recheck" | "recreate", signal?: AbortSignal) =>
    request<AdminBaseRow>(`/bases/${encodeURIComponent(baseId)}/${action}`, { method: "POST", signal }),
  orphans: (params: { limit?: number; after?: string }, signal?: AbortSignal) =>
    request<OrphanDatabasesPage>(`/orphans${page(params)}`, { signal }),
  deleteOrphan: (database: string, signal?: AbortSignal) =>
    request<{ ok: true }>(`/orphans/${encodeURIComponent(database)}`, { method: "DELETE", signal }),
  targets: (params: { limit?: number; offset?: number; baseId?: string }, signal?: AbortSignal) =>
    request<InternalTargetsPage>(`/targets${page(params)}`, { signal }),
  addTarget: (input: { baseId: string; entry: string }, signal?: AbortSignal) =>
    request<InternalTarget>("/targets", { method: "POST", body: JSON.stringify(input), signal }),
  removeTarget: (targetId: string, signal?: AbortSignal) =>
    request<{ ok: true }>(`/targets/${encodeURIComponent(targetId)}`, { method: "DELETE", signal }),
};
