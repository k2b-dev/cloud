import { lazySync, sql } from "@k2b/cloud";

// These handles only retire registrations owned by the removed Mail product.
// Never call process() or reconcile(): queued work must not be admitted again.
const schedules = lazySync((sync) =>
  sync.scheduler({ id: "mail:workflow-schedules", delivery: { maxAttempts: 5, backoffMs: [5_000, 20_000, 60_000, 120_000] } }),
);
const backfills = lazySync((sync) =>
  sync.pump<unknown, never, { key: string }>({
    id: "mail:incoming-automation-backfill",
    retention: { terminalMs: 30 * 24 * 60 * 60 * 1_000 },
    batchSize: 100,
    retry: { maxAttempts: 3, backoffMs: [1_000, 2_000, 4_000] },
    pull: async () => {
      throw new Error("Mail rule backfills are retired");
    },
    dispatch: async () => {
      throw new Error("Mail rule backfills are retired");
    },
  }),
);

/** Idempotent startup cleanup; any broker failure prevents the new Mail worker starting. */
export const retireMailRuleBroker = async (): Promise<void> => {
  for (const schedule of await schedules().list()) {
    if (!schedule.id.startsWith("mail:workflow-schedule:")) throw new Error("Unexpected retired Mail schedule registration");
    await schedules().delete({ id: schedule.id });
  }
  let after = "0";
  for (;;) {
    // Every accepted backfill persisted its activity before pump.start(). Keep
    // all activity/history; cancel each exact operation, in bounded pages.
    const rows = await sql<{ id: string; automation_id: string; operation_id: string }[]>`
      SELECT id::text, target_id AS automation_id, metadata->>'operationId' AS operation_id
      FROM mail.activity_events WHERE action = 'incoming_automation.backfill.start' AND id > ${after}::bigint
      ORDER BY id LIMIT 100
    `;
    for (const row of rows) {
      if (!row.automation_id || !row.operation_id) throw new Error("Retired Mail backfill is missing its operation identity");
      await backfills().cancel({ key: `${row.automation_id}:${row.operation_id}` });
      after = row.id;
    }
    if (rows.length < 100) break;
  }
};
