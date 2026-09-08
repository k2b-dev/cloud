import type { Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { logger } from "@valentinkolb/cloud/services";
import { sql } from "bun";

const log = logger("contacts:capability-retention");
const RETENTION_DAYS = 30;
const DELETE_BATCH_SIZE = 10_000;
const retentionScheduler = lazySync((sync) =>
  sync.scheduler({
    id: "contacts-capability-retention",
    delivery: { maxAttempts: 3, backoffMs: [5_000, 10_000] },
  }),
);

const deleteExpiredResults = async (): Promise<number> => {
  const rows = await sql<{ idempotency_key_hash: string }[]>`
    WITH expired AS (
      SELECT ctid
      FROM contacts.capability_action_results
      WHERE created_at < now() - (${RETENTION_DAYS} * interval '1 day')
      ORDER BY created_at
      LIMIT ${DELETE_BATCH_SIZE}
    )
    DELETE FROM contacts.capability_action_results result
    USING expired
    WHERE result.ctid = expired.ctid
    RETURNING result.idempotency_key_hash
  `;
  if (rows.length > 0) log.info("Removed expired capability idempotency records", { count: rows.length });
  return rows.length;
};

let worker: Worker | undefined;

export const capabilityRetention = {
  start: async (): Promise<void> => {
    if (worker) return;
    await retentionScheduler().create({
      id: "contacts:capability-results:cleanup",
      cron: "17 * * * *",
      timezone: "UTC",
      misfire: "latest",
      meta: { appId: "contacts", family: "maintenance", label: "Capability idempotency retention" },
      process: async (context) => {
        while (!context.signal.aborted && (await deleteExpiredResults()) === DELETE_BATCH_SIZE) {
          await context.heartbeat();
        }
        context.signal.throwIfAborted();
      },
    });
    worker = await retentionScheduler().process();
  },
  stop: async (): Promise<void> => {
    await worker?.drain();
    worker = undefined;
  },
};
