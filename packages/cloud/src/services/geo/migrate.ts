import { type SQL, sql } from "bun";
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.geo.migrations', 0))`;
    await tx`CREATE SCHEMA IF NOT EXISTS geo`.simple();
    await tx`CREATE TABLE IF NOT EXISTS geo.usage (
      scope text NOT NULL CHECK (scope IN ('cloud', 'person')),
      subject text NOT NULL,
      period text NOT NULL,
      used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
      PRIMARY KEY (scope, subject, period)
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS geo.shares (
      scope text NOT NULL, subject text NOT NULL, period text NOT NULL,
      function_group text NOT NULL, used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
      PRIMARY KEY (scope, subject, period, function_group),
      FOREIGN KEY (scope, subject, period) REFERENCES geo.usage(scope, subject, period)
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS geo.audit_transitions (
      event text NOT NULL, period text NOT NULL, PRIMARY KEY (event, period)
    )`.simple();
  });
};
