import type { StoreCheckResult } from "../../store/check-codes";
import { StoreCheckSchema, type StoreStatus } from "../../store/contracts";
import { jsonFetch } from "../http";

export class StoreClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly check?: StoreCheckResult,
  ) {
    super(code);
  }
}
const failure = (status: number, body: unknown): StoreClientError => {
  if (body && typeof body === "object" && "code" in body && typeof body.code === "string") {
    // The local API returns only fixed codes and sanitized check results.
    const check = StoreCheckSchema.safeParse("status" in body ? body.status : undefined);
    return new StoreClientError(status, body.code, check.success ? check.data : undefined);
  }
  return new StoreClientError(status, "STORE_REQUEST_FAILED");
};
const request = <T>(path = "", init?: RequestInit) =>
  jsonFetch<T>(
    `/api/pulse/admin/store${path}`,
    {
      ...init,
      credentials: "same-origin",
    },
    "STORE_REQUEST_FAILED",
    failure,
  );
export const storeClient = {
  get: (signal?: AbortSignal) => request<StoreStatus>("", { signal }),
  save: (input: { url: string; user: string; password?: string }, signal?: AbortSignal) =>
    request<StoreStatus>("", { method: "PUT", body: JSON.stringify(input), signal }),
  check: (signal?: AbortSignal) => request<StoreCheckResult>("/check", { method: "POST", signal }),
  setupSql: (input: { user?: string; password: string }, signal?: AbortSignal) =>
    request<{ sql: string }>("/setup-sql", { method: "POST", body: JSON.stringify(input), signal }),
};
