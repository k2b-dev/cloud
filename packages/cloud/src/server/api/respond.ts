import { isServiceError, ok, type Result, type ServiceError } from "@k2b/stdlib";
import type { Context, TypedResponse } from "hono";
import type { StatusCode } from "hono/utils/http-status";

type LegacyErrorStatus = ServiceError["status"] | 413 | 422 | 502 | 503 | 504;
type LegacyErrorResult<S extends number = number> = { ok: false; error: string; status: S; code?: string };
type LegacyResult<T = void> = { ok: true; data: T } | LegacyErrorResult;

type AnyResult<T = unknown> = Result<T> | LegacyResult<T>;
type ResultOrFn<T> = T | Promise<T> | (() => T | Promise<T>);
type SuccessStatus = 200 | 201;
export type ApiErrorStatus = ServiceError["status"] | LegacyErrorStatus;
type JsonTypedResponse<T, Status extends StatusCode> = Response & TypedResponse<T, Status, "json">;

export type ApiErrorBody = {
  message: string;
  code?: string;
};
export type ApiErrorResponse = JsonTypedResponse<ApiErrorBody, ApiErrorStatus>;

const toErrorResponse = (result: AnyResult): [ApiErrorBody, number] => {
  if (result.ok) {
    throw new Error("toErrorResponse called with successful result");
  }

  // Legacy shape: { ok: false, error: string, status: number, code?: string }
  if ("status" in result && typeof result.status === "number") {
    return [result.code ? { message: result.error, code: result.code } : { message: result.error }, result.status];
  }

  // New shape: { ok: false, error: ServiceError }
  if (isServiceError(result.error)) {
    return [
      {
        message: result.error.message,
        code: result.error.code,
      },
      result.error.status,
    ];
  }

  // Defensive fallback
  return [{ message: "Internal server error", code: "INTERNAL" }, 500];
};

export async function respond<E extends ServiceError>(
  c: Context,
  resultOrFn: ResultOrFn<Result<never, E>>,
  successStatus?: SuccessStatus,
): Promise<JsonTypedResponse<ApiErrorBody, E["status"]>>;
export async function respond<T>(
  c: Context,
  resultOrFn: ResultOrFn<Result<T, never>>,
  successStatus?: SuccessStatus,
): Promise<JsonTypedResponse<T, SuccessStatus>>;
export async function respond<T, E extends ServiceError>(
  c: Context,
  resultOrFn: ResultOrFn<Result<T, E>>,
  successStatus?: SuccessStatus,
): Promise<JsonTypedResponse<T, SuccessStatus> | JsonTypedResponse<ApiErrorBody, E["status"]>>;
export async function respond<S extends LegacyErrorStatus>(
  c: Context,
  resultOrFn: ResultOrFn<LegacyErrorResult<S>>,
  successStatus?: SuccessStatus,
): Promise<JsonTypedResponse<ApiErrorBody, S>>;
export async function respond<T>(
  c: Context,
  resultOrFn: ResultOrFn<AnyResult<T>>,
  successStatus?: SuccessStatus,
): Promise<JsonTypedResponse<T, SuccessStatus> | ApiErrorResponse>;
export async function respond<T>(
  c: Context,
  resultOrFn: ResultOrFn<AnyResult<T>>,
  successStatus: SuccessStatus = 200,
): Promise<JsonTypedResponse<T, SuccessStatus> | ApiErrorResponse> {
  const result = typeof resultOrFn === "function" ? await resultOrFn() : await resultOrFn;

  if (!result.ok) {
    const [body, status] = toErrorResponse(result);
    return c.json(body, status as ApiErrorStatus) as ApiErrorResponse;
  }

  return c.json(result.data, successStatus as 200 | 201) as JsonTypedResponse<T, SuccessStatus>;
}

export const respondMessage = (c: Context, resultPromise: Promise<Result<void>>, message: string) =>
  respond(c, async () => {
    const result = await resultPromise;
    if (!result.ok) return result;
    return ok({ message });
  });

export const api = {
  respond,
  respondMessage,
} as const;
