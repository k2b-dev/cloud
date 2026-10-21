export type SqlErrorCode =
  | "OVERDUE"
  | "SQL_ERROR"
  | "TIME_LIMIT"
  | "MEMORY_LIMIT"
  | "RESULT_TOO_LARGE"
  | "INPUT_TOO_LARGE"
  | "PARAMETER_MISSING"
  | "BUSY"
  | "QUEUE_FULL"
  | "QUOTA"
  | "STORE_UNAVAILABLE"
  | "NO_READ_ACCESS"
  | "CANCELLED";
export class SqlError extends Error {
  readonly status: 400 | 403 | 422 | 429 | 503;
  constructor(
    readonly code: SqlErrorCode,
    message: string,
    readonly details: { line?: number; column?: number; retryAfter?: number; resetAt?: string } = {},
  ) {
    super(message);
    this.status =
      code === "NO_READ_ACCESS"
        ? 403
        : code === "QUOTA"
          ? 429
          : ["BUSY", "QUEUE_FULL", "STORE_UNAVAILABLE", "OVERDUE"].includes(code)
            ? 503
            : ["TIME_LIMIT", "MEMORY_LIMIT", "RESULT_TOO_LARGE"].includes(code)
              ? 422
              : 400;
  }
  resultError() {
    return { code: this.code, message: this.message, status: this.status, ...this.details };
  }
}
