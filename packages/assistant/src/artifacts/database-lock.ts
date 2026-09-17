import type { sql } from "bun";

/** Serialize artifact database operations with changes to the shared rsql settings. */
export const databaseConfigLock = (db: typeof sql) => db`SELECT pg_advisory_xact_lock_shared(hashtext('assistant-rsql-settings'))`;
