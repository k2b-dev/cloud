/**
 * Bun decodes JSONB for SELECT and RETURNING. Preserve that native value,
 * including JSON-looking strings; only nullish values use the caller's default.
 * Callers own schema validation. Do not decode historical double-encoded rows.
 */
export const parseJsonbRow = <T>(value: unknown, fallback: T): T => (value ?? fallback) as T;
