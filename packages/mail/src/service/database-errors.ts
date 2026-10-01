type ErrorWriter = (message: string, metadata?: Record<string, unknown>) => void;

export const databaseErrorCode = (error: unknown): string | null => {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = current as { code?: unknown; errno?: unknown; sqlState?: unknown; cause?: unknown };
    for (const candidate of [value.errno, value.sqlState, value.code]) {
      if (typeof candidate === "string" || typeof candidate === "number") {
        const code = String(candidate);
        if (/^\d{5}$/.test(code)) return code;
      }
    }
    current = value.cause;
  }
  return null;
};

/**
 * Postgres classes 22 (data exception) and 23 (integrity constraint violation): the same
 * statement with the same data fails the same way again, so a retry cannot succeed.
 */
export const isPermanentDataError = (error: unknown): boolean => {
  const code = databaseErrorCode(error);
  return code !== null && (code.startsWith("22") || code.startsWith("23"));
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
