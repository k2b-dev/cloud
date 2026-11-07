/** Core owns the production outbox lifecycle; its DDL is shared with app test databases. */
import { sql } from "@k2b/cloud";
import { migrateEventsSchema } from "@k2b/cloud/services/events-schema";
import type { SQL } from "bun";

export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(migrateEventsSchema);
  console.log("  ✓ events.outbox table");
};
