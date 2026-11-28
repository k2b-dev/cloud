/** Core owns the production outbox lifecycle; its DDL is shared with app test databases. */
import { sql } from "@k2b/cloud";
import { migrateEventsSchema } from "@k2b/cloud/services/events-schema";
import { withTableLock } from "@k2b/cloud/services/migration-ddl";
import type { SQL } from "bun";

export const migrate = async (db: SQL = sql): Promise<void> => {
  // Bounds the transaction's lock waits and retries it, so a start never queues the outbox's writers for long.
  await withTableLock(db, "events.outbox", migrateEventsSchema);
  console.log("  ✓ events.outbox table");
};
