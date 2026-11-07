import { lazySync, sql } from "@k2b/cloud";

// Match the existing Contacts idempotency-retention maintenance budget.
const DELETE_BATCH_SIZE = 10_000;
const scheduler = lazySync((sync) =>
  sync.scheduler({ id: "spaces-item-create-retention", delivery: { maxAttempts: 3, backoffMs: [5_000, 10_000] } }),
);

export const deleteExpiredCreateRequests = async (): Promise<number> => {
  const rows = await sql<{ request_key: string }[]>`
    WITH expired AS (
      SELECT ctid FROM spaces.item_create_requests WHERE expires_at <= now()
      ORDER BY expires_at LIMIT ${DELETE_BATCH_SIZE} FOR UPDATE SKIP LOCKED
    )
    DELETE FROM spaces.item_create_requests request USING expired
    WHERE request.ctid = expired.ctid RETURNING request.request_key
  `;
  return rows.length;
};

let worker: Awaited<ReturnType<ReturnType<typeof scheduler>["process"]>> | undefined;
export const itemCreateRetention = {
  async start() {
    if (worker) return;
    await scheduler().create({
      id: "spaces:item-create:cleanup",
      cron: "47 * * * *",
      timezone: "UTC",
      misfire: "latest",
      meta: { appId: "spaces", family: "maintenance", label: "Task create receipt retention" },
      async process(context) {
        while (!context.signal.aborted && (await deleteExpiredCreateRequests()) === DELETE_BATCH_SIZE) await context.heartbeat();
        context.signal.throwIfAborted();
      },
    });
    worker = await scheduler().process();
  },
  async stop() {
    await worker?.drain();
    worker = undefined;
  },
};
