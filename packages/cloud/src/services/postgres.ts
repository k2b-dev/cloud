import type { TransactionSQL } from "bun";

/**
 * Call inside the migration transaction directly after its advisory lock, as
 * its first statement reading pg_namespace (including through views like pg_tables).
 * The fresh relation lock applies catalog invalidations the advisory lock does not,
 * so this check and all later DDL see schemas other migrators committed while it waited.
 * The schema name must be a code constant and a plain lowercase Postgres identifier.
 */
export const ensureSchema = async (db: TransactionSQL, name: string): Promise<void> => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("Schema name must be a plain lowercase Postgres identifier");
  const [schema] = await db<{ exists: boolean }[]>`SELECT EXISTS(SELECT FROM pg_namespace WHERE nspname = ${name}) AS exists`;
  if (!schema?.exists) await db.unsafe(`CREATE SCHEMA ${name}`).simple();
};

/** Convert a JS string array to a Postgres TEXT[] literal (Bun sql can't serialize empty arrays). */
export const toPgTextArray = (values: string[] | null | undefined): string => {
  if (!Array.isArray(values) || values.length === 0) return "{}";
  return `{${values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
};

/** Convert UUID strings into a Postgres UUID[] literal for `ANY(...)`/`ALL(...)` filters. */
export const toPgUuidArray = (values: string[] | null | undefined): string => {
  if (!Array.isArray(values) || values.length === 0) return "{}";
  return `{${values.join(",")}}`;
};

/** Convert 32-bit integers into a Postgres INT[] literal. */
export const toPgIntArray = (values: number[] | null | undefined): string => {
  if (!Array.isArray(values) || values.length === 0) return "{}";
  if (values.some((value) => !Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647)) {
    throw new RangeError("Postgres INT[] values must be 32-bit integers");
  }
  return `{${values.join(",")}}`;
};

/** Escape a user string for safe use inside a LIKE/ILIKE pattern with `ESCAPE '\'`. */
export const escapeLikePattern = (value: string): string => value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

/** Normalize a Postgres JSON/JSONB value that may come back as a parsed value or a JSON string. */
export const parsePgJsonValue = (value: unknown): unknown => {
  if (value == null || typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

/** Normalize a Postgres JSON/JSONB object value to a plain record. */
export const parsePgJsonRecord = (value: unknown): Record<string, unknown> | null => {
  const parsed = parsePgJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
};

/**
 * Classify a thrown Postgres error. Use at service boundaries to turn
 * unique-constraint violations into typed 409 results instead of bubbling
 * up raw DB errors to API clients.
 *
 * Two driver shapes coexist in this repo:
 *   - postgres.js: SQLSTATE on `code`, constraint name on `constraint_name`
 *   - bun.sql: SQLSTATE on `errno`, constraint name on `constraint`
 *
 * Checking only `e.code` silently fails on Bun (the Wave-1.1 migration
 * idempotence bug had the same root cause). Treat either field carrying
 * "23505" as a unique violation so the helper works regardless of which
 * driver instantiated the error.
 */
export type PgError = {
  code?: string;
  errno?: string;
  constraint?: string;
  constraint_name?: string;
  detail?: string;
  message?: string;
};

export const isUniqueViolation = (error: unknown, constraintName?: string): boolean => {
  if (!error || typeof error !== "object") return false;
  const e = error as PgError;
  const sqlstate = e.code === "23505" || e.errno === "23505";
  if (!sqlstate) return false;
  if (!constraintName) return true;
  return e.constraint === constraintName || e.constraint_name === constraintName;
};
