import type { SavedQueriesPage, SavedQuery } from "../../service/saved-queries";
import type { SqlErrorCode } from "../../service/sql-errors";
import type { SqlLimits, SqlResult } from "../../service/sql-service";
import { jsonFetch } from "../http";

// Type-only imports keep database, admission and store implementations out of browser bundles.
export type { SavedQueriesPage, SavedQuery, SqlErrorCode, SqlLimits, SqlResult };
export type SqlParams = Record<string, string>;
export type SaveSqlQuery = { name: string; sql: string; params?: SqlParams; pinned?: boolean };
export type SqlClientErrorCode = SqlErrorCode | "CONFLICT" | "NOT_FOUND" | "FORBIDDEN" | "REQUEST_FAILED";
export type SqlErrorDetails = { line?: number; column?: number; retryAfter?: number; resetAt?: string; parameterName?: string };

export class SqlClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: SqlErrorDetails = {},
  ) {
    super(message);
  }
}
const sqlError = (status: number, body: unknown, headers: Headers): SqlClientError => {
  const value = body && typeof body === "object" ? body : {};
  const code = "code" in value && typeof value.code === "string" ? value.code : "REQUEST_FAILED";
  const message = "message" in value && typeof value.message === "string" ? value.message : code;
  const details: SqlErrorDetails = {};
  for (const key of ["line", "column", "retryAfter"] as const) {
    if (key in value) {
      const detail = Reflect.get(value, key);
      if (typeof detail === "number") details[key] = detail;
    }
  }
  if ("resetAt" in value && typeof value.resetAt === "string") details.resetAt = value.resetAt;
  const retryAfter = headers.get("Retry-After");
  if (details.retryAfter === undefined && retryAfter !== null) {
    if (/^\d+$/.test(retryAfter)) details.retryAfter = Number(retryAfter);
    else if (Number.isFinite(Date.parse(retryAfter))) details.resetAt ??= new Date(retryAfter).toISOString();
  }
  return new SqlClientError(code, message, status, details);
};
const path = (baseId: string) => `/api/pulse/bases/${encodeURIComponent(baseId)}`;
const request = <T>(url: string, init?: RequestInit) => jsonFetch<T>(url, init, "REQUEST_FAILED", sqlError);
export const createSqlRunId = (): string => crypto.randomUUID();

export const sqlClient = {
  run: (baseId: string, input: { sql: string; params?: SqlParams; runId?: string }, signal?: AbortSignal) =>
    request<SqlResult>(`${path(baseId)}/sql`, {
      method: "POST",
      body: JSON.stringify({ ...input, runId: input.runId ?? createSqlRunId() }),
      signal,
    }),
  cancel: (baseId: string, runId: string, signal?: AbortSignal) =>
    request<{ cancelled: boolean }>(`${path(baseId)}/sql/cancel`, { method: "POST", body: JSON.stringify({ runId }), signal }),
  limits: (baseId: string, signal?: AbortSignal) => request<SqlLimits>(`${path(baseId)}/sql/limits`, { signal }),
  list: (baseId: string, page: { limit?: number; offset?: number } = {}, signal?: AbortSignal) => {
    const search = new URLSearchParams();
    if (page.limit !== undefined) search.set("limit", String(page.limit));
    if (page.offset !== undefined) search.set("offset", String(page.offset));
    return request<SavedQueriesPage>(`${path(baseId)}/queries${search.size ? `?${search}` : ""}`, { signal });
  },
  get: (baseId: string, queryId: string, signal?: AbortSignal) =>
    request<SavedQuery>(`${path(baseId)}/queries/${encodeURIComponent(queryId)}`, { signal }),
  create: (baseId: string, input: SaveSqlQuery, signal?: AbortSignal, idempotencyKey?: string) =>
    request<SavedQuery>(`${path(baseId)}/queries`, {
      method: "POST",
      body: JSON.stringify(input),
      signal,
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    }),
  update: (
    baseId: string,
    queryId: string,
    input: SaveSqlQuery & { expectedRevision: number },
    signal?: AbortSignal,
    idempotencyKey?: string,
  ) =>
    request<SavedQuery>(`${path(baseId)}/queries/${encodeURIComponent(queryId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
      signal,
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    }),
  delete: (baseId: string, queryId: string, expectedRevision: number, signal?: AbortSignal, idempotencyKey?: string) =>
    request<{ deleted: boolean }>(`${path(baseId)}/queries/${encodeURIComponent(queryId)}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision }),
      signal,
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    }),
};
export type SqlClient = typeof sqlClient;
