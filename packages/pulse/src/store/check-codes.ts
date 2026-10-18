/**
 * Fixed check steps and result codes, shared by the server check, the API contract, the CLI and the
 * browser page. Keep this module free of imports: the admin island bundles it for the browser.
 */
export const REQUIRED_RIGHTS = [
  "CREATE DATABASE",
  "CREATE TABLE",
  "ALTER TABLE",
  "INSERT",
  "SELECT",
  "CREATE USER",
  "ALTER USER",
  "DROP USER",
  "GRANT SELECT",
  "DROP TABLE",
  "DROP DATABASE",
  "TRUNCATE",
  "OPTIMIZE",
  "SYSTEM PARTS",
  "SYSTEM DISKS",
  "KILL QUERY",
] as const;
export type StoreCheckCode =
  | "UNREACHABLE"
  | "AUTH_FAILED"
  | "VERSION_TOO_OLD"
  | "TOO_MANY_RIGHTS"
  | `MISSING_RIGHT:${(typeof REQUIRED_RIGHTS)[number]}`
  | `PROFILE_MISSING:${string}`;
export const CHECK_STEPS = ["reach", "auth", "version", "rights", "profiles"] as const;
export type StoreCheckResult = {
  ok: boolean;
  code?: StoreCheckCode;
  version?: string;
  latencyMs?: number;
  checkedAt: string;
  steps: Record<(typeof CHECK_STEPS)[number], "ok" | "failed" | "skipped">;
};
