// ==========================
// Core Result Types
// ==========================

/**
 * Union of recognized service error codes.
 *
 * Each code maps to a specific HTTP status:
 * - `"BAD_INPUT"` -- 400
 * - `"UNAUTHENTICATED"` -- 401
 * - `"FORBIDDEN"` -- 403
 * - `"NOT_FOUND"` -- 404
 * - `"CONFLICT"` -- 409
 * - `"TOO_MANY_REQUESTS"` -- 429
 * - `"INTERNAL"` -- 500
 * - `"UNAVAILABLE"` -- 503
 */
export type ServiceErrorCode =
  | "BAD_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL"
  | "UNAVAILABLE";

/**
 * Structured service error with a machine-readable code, human-readable
 * message, and corresponding HTTP status code.
 *
 * @typeParam C - The error code string literal (defaults to `string`)
 */
export type ServiceError<C extends string = string> = {
  code: C;
  message: string;
  status: 400 | 401 | 403 | 404 | 405 | 406 | 408 | 409 | 410 | 412 | 413 | 415 | 416 | 421 | 422 | 429 | 500 | 501 | 502 | 503 | 504;
};

export type Result<T = void, E extends ServiceError = ServiceError> = { ok: true; data: T } | { ok: false; error: E };

export type PageParams = {
  page?: number;
  perPage?: number;
};

export type Paginated<T> = {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  hasNext: boolean;
};

// ==========================
// Constructors
// ==========================

/**
 * Builds a successful service result.
 *
 * When called with no arguments, produces `Result<void>` with `data: undefined`.
 * When called with a value, wraps it as `Result<T>`.
 *
 * @example
 * ok()          // { ok: true, data: undefined }
 * ok({ id: 1 }) // { ok: true, data: { id: 1 } }
 */
export function ok(): Result<void, never>;
export function ok<T>(data: T): Result<T, never>;
export function ok(data?: unknown): Result<unknown, never> {
  return { ok: true, data: arguments.length === 0 ? undefined : data };
}

/**
 * Builds a successful paginated result.
 *
 * Wraps an array of items together with pagination metadata. The `hasNext`
 * flag is calculated as `page * perPage < total`.
 *
 * @param items - The page of results
 * @param info - Pagination metadata (current page, perPage, total count)
 * @returns A successful `Result` containing a {@link Paginated} payload
 */
export const okMany = <T>(items: T[], info: { page: number; perPage: number; total: number }): Result<Paginated<T>, never> => ({
  ok: true,
  data: {
    items,
    ...info,
    hasNext: info.page * info.perPage < info.total,
  },
});

/**
 * Builds a failed service result wrapping a {@link ServiceError}.
 *
 * @param error - The service error to wrap
 * @returns A failed `Result` containing the error
 */
export const fail = <E extends ServiceError>(error: E): Result<never, E> => ({
  ok: false,
  error,
});

// ==========================
// Error Helpers
// ==========================

/**
 * Factory functions for creating {@link ServiceError} objects.
 *
 * Each factory pre-fills the `code` and `status` fields, requiring only
 * a human-readable message (or a subject noun for `notFound`). `conflict`
 * takes its whole sentence as given.
 */
export const err = {
  /** Creates a 400 BAD_INPUT error. @param why - Reason the input is invalid */
  badInput: (why: string) =>
    ({
      code: "BAD_INPUT" as const,
      message: why,
      status: 400 as const,
    }) satisfies ServiceError<ServiceErrorCode>,
  /** Creates a 401 UNAUTHENTICATED error. @param why - Optional reason (defaults to `"Authentication required"`) */
  unauthenticated: (why = "Authentication required") =>
    ({
      code: "UNAUTHENTICATED" as const,
      message: why,
      status: 401 as const,
    }) satisfies ServiceError<ServiceErrorCode>,
  /** Creates a 403 FORBIDDEN error. @param why - Optional reason (defaults to `"Insufficient permissions"`) */
  forbidden: (why = "Insufficient permissions") =>
    ({
      code: "FORBIDDEN" as const,
      message: why,
      status: 403 as const,
    }) satisfies ServiceError<ServiceErrorCode>,
  /** Creates a 404 NOT_FOUND error. Message becomes `"<what> not found"`. @param what - The entity that was not found */
  notFound: (what: string) =>
    ({
      code: "NOT_FOUND" as const,
      message: `${what} not found`,
      status: 404 as const,
    }) satisfies ServiceError<ServiceErrorCode>,
  /**
   * Creates a 409 CONFLICT error. The message is the caller's own sentence, taken as given, such as
   * `"Email already exists"` or `"Task changed; read it and retry"`: a conflict is not always an existing entity.
   * @param message - The full sentence the person or agent reads
   */
  conflict: (message: string) =>
    ({
      code: "CONFLICT" as const,
      message,
      status: 409 as const,
    }) satisfies ServiceError<ServiceErrorCode>,
  /** Creates a 429 TOO_MANY_REQUESTS error. @param why - Optional reason (defaults to `"Too many requests"`) */
  tooManyRequests: (why = "Too many requests") =>
    ({
      code: "TOO_MANY_REQUESTS" as const,
      message: why,
      status: 429 as const,
    }) satisfies ServiceError<ServiceErrorCode>,
  /** Creates a 500 INTERNAL error. @param why - Optional reason (defaults to `"Internal server error"`) */
  internal: (why = "Internal server error") =>
    ({
      code: "INTERNAL" as const,
      message: why,
      status: 500 as const,
    }) satisfies ServiceError<ServiceErrorCode>,
  /** Creates a 503 UNAVAILABLE error. @param why - Optional reason (defaults to `"Service unavailable"`) */
  unavailable: (why = "Service unavailable") =>
    ({
      code: "UNAVAILABLE" as const,
      message: why,
      status: 503 as const,
    }) satisfies ServiceError<ServiceErrorCode>,
};

// ==========================
// Helpers
// ==========================

/**
 * Normalizes pagination input and computes a stable offset for DB queries.
 *
 * Both `page` and `perPage` are clamped to a minimum of `1`.
 * The offset is calculated as `(page - 1) * perPage`.
 *
 * @param params - Optional page/perPage values (defaults to page 1, 20 per page)
 * @returns Object with normalized `page`, `perPage`, and computed `offset`
 */
export const paginate = (params?: PageParams) => {
  // Accept any input but coerce defensively. NaN, Infinity, fractional, and
  // negative inputs were previously passed through to (page-1)*perPage,
  // producing offsets like NaN or Infinity that downstream SQL drivers
  // either rejected loudly or — worse — used to issue full-table scans.
  const MAX_PER_PAGE = 1000;
  const safe = (v: unknown, fallback: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.floor(n);
  };
  const page = Math.max(1, safe(params?.page, 1));
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, safe(params?.perPage, 20)));
  return { page, perPage, offset: (page - 1) * perPage };
};

/**
 * Extracts the data from a successful `Result`, or throws on failure.
 *
 * When the result is not `ok`, throws an `Error` whose message is set to
 * the `ServiceError.message` and whose properties include the `code` and
 * `status` from the error (via `Object.assign`).
 *
 * @param result - The result to unwrap
 * @returns The unwrapped data of type `T`
 * @throws {Error} With `code` and `status` properties from the `ServiceError`
 */
export const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) {
    const err = new Error(result.error.message);
    Object.assign(err, result.error);
    throw err;
  }
  return result.data;
};

/**
 * Type guard that checks whether an unknown value conforms to the
 * {@link ServiceError} shape (`code: string`, `message: string`,
 * `status: number`).
 *
 * Useful for catching errors that may already be structured service
 * errors (e.g. re-thrown from inner service calls).
 *
 * @param value - The value to test
 * @returns `true` if `value` is a `ServiceError`
 */
export const isServiceError = (value: unknown): value is ServiceError => {
  if (typeof value !== "object" || value === null) return false;
  const e = value as { code?: unknown; message?: unknown; status?: unknown };
  return typeof e.code === "string" && typeof e.message === "string" && typeof e.status === "number";
};

/**
 * Wraps an async function in a try/catch and returns a `Result`.
 *
 * On success, returns `ok(value)`. On failure:
 * 1. If the caught error is already a `ServiceError`, it is wrapped with `fail()`.
 * 2. Otherwise, the optional `onError` mapper is called; if omitted, an
 *    `err.internal()` is created from the error message.
 *
 * This function never throws.
 *
 * @param fn - Async function to execute
 * @param onError - Optional mapper from unknown error to `ServiceError`
 * @returns A `Result<T>` that is always settled (never rejects)
 */
export const tryCatch = async <T>(fn: () => Promise<T>, onError?: (error: unknown) => ServiceError): Promise<Result<T>> => {
  try {
    return ok(await fn());
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    if (onError) {
      try {
        return fail(onError(error));
      } catch (mapErr) {
        // onError itself threw — fall back to a generic internal error so the
        // documented "never throws" contract holds even during error mapping.
        console.error("tryCatch: onError threw while mapping", mapErr);
        return fail(err.internal("internal error"));
      }
    }
    // Default: pass through the underlying error message. Note: this can
    // leak infrastructure detail (SQL strings, file paths) to clients —
    // pass an explicit `onError` mapper to redact in security-sensitive contexts.
    return fail(err.internal(error instanceof Error ? error.message : String(error)));
  }
};
