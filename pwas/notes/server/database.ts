import type { SQL } from "bun";
import initial from "../migrations/001-initial.sql" with { type: "text" };

import runtimeOwner from "../migrations/002-runtime-owner.sql" with { type: "text" };

import moderationBudget from "../migrations/003-moderation-budget.sql" with { type: "text" };

const migrations = [
  { version: 1, sql: initial },
  { version: 2, sql: runtimeOwner },
  { version: 3, sql: moderationBudget },
];
export const schemaVersion = migrations.at(-1)!.version;

/** Migrations share one transaction and a database-scoped lock, including first boot. */
export const migrate = async (db: SQL): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(726628313)`;
    await tx`CREATE TABLE IF NOT EXISTS notes_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const applied = await tx<{ version: number }[]>`SELECT version FROM notes_schema_migrations ORDER BY version`;
    if (applied.some((entry) => entry.version > schemaVersion)) throw new Error("notes_schema_newer_than_server");
    for (const migration of migrations) {
      if (applied.some((entry) => entry.version === migration.version)) continue;
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO notes_schema_migrations(version) VALUES(${migration.version})`;
    }
  });
};

export const databaseReady = async (db: SQL): Promise<boolean> => {
  const rows = await db<{ version: number }[]>`SELECT version FROM notes_schema_migrations ORDER BY version`;
  return rows.length === migrations.length && rows.every((row, index) => row.version === migrations[index]!.version);
};
