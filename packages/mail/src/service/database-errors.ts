type ErrorWriter = (message: string, metadata?: Record<string, unknown>) => void;

export const databaseErrorCode = (error: unknown): string | null => {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = current as { code?: unknown; errno?: unknown; sqlState?: unknown; cause?: unknown };
    for (const candidate of [value.errno, value.sqlState, value.code]) {
      if (typeof candidate === "string" || typeof candidate === "number") {
        const code = String(candidate);
        // SQLSTATE: a numeric two-character class and three digits or capitals (22P05, 57P01).
        if (/^\d{2}[0-9A-Z]{3}$/.test(code)) return code;
      }
    }
    current = value.cause;
  }
  return null;
};

/**
 * Errors the same statement with the same data raises again, so a retry cannot succeed: class
 * 22 (data exception), 23502 (not null) and 23514 (check) violations, and class 54 (program
 * limit exceeded, such as an oversized index entry). Unique, foreign key, and exclusion
 * violations stay retryable because a concurrent writer can cause them.
 */
export const isPermanentDataError = (error: unknown): boolean => {
  const code = databaseErrorCode(error);
  return code !== null && (code.startsWith("22") || code === "23502" || code === "23514" || code.startsWith("54"));
};

/** Bun's codes for a Postgres connection that failed, closed, or timed out. */
const LOST_DATABASE_CONNECTION_CODES = new Set([
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_CONNECTION_FAILED",
  "ERR_POSTGRES_CONNECTION_REFUSED",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "ERR_POSTGRES_IDLE_TIMEOUT",
  "ERR_POSTGRES_LIFETIME_TIMEOUT",
]);

/**
 * Errors that say nothing about the statement or its data, so the same work succeeds once the
 * database recovers: a lost connection, class 08 (connection exception), serialization failures
 * and deadlocks, too many connections, and a server that is shutting down or starting.
 */
export const isTransientDatabaseError = (error: unknown): boolean => {
  const value = error as { code?: unknown } | null;
  if (typeof value?.code === "string" && LOST_DATABASE_CONNECTION_CODES.has(value.code)) return true;
  const code = databaseErrorCode(error);
  return code !== null && (code.startsWith("08") || ["40001", "40P01", "53300", "57P01", "57P03"].includes(code));
};

export const databaseErrorConstraint = (error: unknown): string | null => {
  const value = error as { constraint?: unknown; constraint_name?: unknown } | null;
  return typeof value?.constraint === "string"
    ? value.constraint
    : typeof value?.constraint_name === "string"
      ? value.constraint_name
      : null;
};

export const logDatabaseFailure = (
  write: ErrorWriter,
  operation: string,
  resource: "provider binding" | "provider connection" | "sender identity transport",
  error: unknown,
): void => {
  const value = error as { code?: unknown; errno?: unknown; constraint?: unknown; constraint_name?: unknown } | null;
  write(`Failed to ${operation} ${resource}`, {
    code: typeof value?.code === "string" ? value.code : typeof value?.errno === "string" ? value.errno : "UNKNOWN",
    constraint:
      typeof value?.constraint === "string" ? value.constraint : typeof value?.constraint_name === "string" ? value.constraint_name : null,
  });
};
