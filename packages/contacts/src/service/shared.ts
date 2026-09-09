import type { sql } from "bun";

export type SqlExecutor = typeof sql;

/**
 * UUID validator used to guard casts before running `::uuid` SQL comparisons.
 */
export const isUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// PG array helpers re-exported from the canonical cloud/services source so all
// callers (oauth, faq, spaces, contacts) share one implementation.
export { toPgUuidArray } from "@k2b/cloud/services";

/**
 * Normalizes empty strings to `null` for user-facing optional profile fields.
 */
export const emptyToNull = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Converts SQL date values into a stable `YYYY-MM-DD` representation.
 */
export const toDateOnly = (value: Date | string | null): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
};
