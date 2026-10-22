import { lazySync } from "@k2b/cloud";
import type { Worker } from "@k2b/sync";
import { sql } from "bun";
import { BASE_SCHEMA_VERSIONS, LATEST_BASE_SCHEMA_VERSION } from "../store/base-schema";
import { BaseOperationSuperseded, BaseStoreError, baseStore, loadStoreRow, type StoreRow, storeErrorCode } from "../store/base-store";
import { acceptCheckpoint, insertCheckpoint, prepareCheckpoint } from "../store/maintenance";
import { pulseStoreConfigured } from "../store/service";

const BASE_DELETE_BATCH_SIZE = 50_000;

type BaseJobInput = {
  baseId: string;
  publicBaseId: string;
};

const deleteSourceScrapesChunk = async (baseId: string, db: typeof sql = sql): Promise<number> => {
  const result = await db`
    WITH victim AS (
      SELECT ctid
      FROM pulse.source_scrapes
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.source_scrapes item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteIngestIdempotencyChunk = async (baseId: string, db: typeof sql = sql): Promise<number> => {
  const result = await db`
    WITH victim AS (
      SELECT item.source_id, item.idempotency_key
      FROM pulse.ingest_idempotency item
      JOIN pulse.sources source ON source.id = item.source_id
      WHERE source.base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.ingest_idempotency item
    USING victim
    WHERE item.source_id = victim.source_id
      AND item.idempotency_key = victim.idempotency_key
  `;
  return result.count ?? 0;
};

const deleteMetricSeriesChunk = async (baseId: string, db: typeof sql = sql): Promise<number> => {
  const result = await db`
    WITH victim AS (
      SELECT ctid
      FROM pulse.metric_series
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.metric_series item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteMetricDefsChunk = async (baseId: string, db: typeof sql = sql): Promise<number> => {
  const result = await db`
    WITH victim AS (
      SELECT ctid
      FROM pulse.metric_defs
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.metric_defs item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteSourcesChunk = async (baseId: string, db: typeof sql = sql): Promise<number> => {
  const result = await db`
    WITH victim AS (
      SELECT ctid
      FROM pulse.sources
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.sources item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteBaseAccessChunk = async (baseId: string, db: typeof sql = sql): Promise<number> => {
  const result = await db`
    WITH victim AS (
      SELECT access_id
      FROM pulse.base_access
      WHERE base_id = ${baseId}::uuid
      LIMIT 1000
    )
    DELETE FROM auth.access item
    USING victim
    WHERE item.id = victim.access_id
  `;
  return result.count ?? 0;
};

const deleteMetricHoursChunk = async (baseId: string, db: typeof sql = sql): Promise<number> => {
  const result = await db`WITH victim AS(SELECT hour FROM pulse.metric_hours WHERE base_id=${baseId}::uuid LIMIT ${BASE_DELETE_BATCH_SIZE})
 DELETE FROM pulse.metric_hours h USING victim WHERE h.base_id=${baseId}::uuid AND h.hour=victim.hour`;
  return result.count ?? 0;
};

const deleteRegistryChunk = async (baseId: string, table: "state_variants" | "state_keys" | "event_kinds", db: typeof sql) => {
  const result =
    await db`WITH victim AS (SELECT ctid FROM ${sql(`pulse.${table}`)} WHERE base_id=${baseId}::uuid LIMIT ${BASE_DELETE_BATCH_SIZE})
    DELETE FROM ${sql(`pulse.${table}`)} r USING victim WHERE r.ctid=victim.ctid`;
  return result.count ?? 0;
};

const BASE_DELETE_STEPS: Array<{ phase: string; run: (baseId: string, db: typeof sql) => Promise<number> }> = [
  { phase: "state_variants", run: (id, db) => deleteRegistryChunk(id, "state_variants", db) },
  { phase: "state_keys", run: (id, db) => deleteRegistryChunk(id, "state_keys", db) },
  { phase: "event_kinds", run: (id, db) => deleteRegistryChunk(id, "event_kinds", db) },
  { phase: "metric_hours", run: deleteMetricHoursChunk },
  { phase: "source_scrapes", run: deleteSourceScrapesChunk },
  { phase: "ingest_idempotency", run: deleteIngestIdempotencyChunk },
  { phase: "metric_series", run: deleteMetricSeriesChunk },
  { phase: "metric_defs", run: deleteMetricDefsChunk },
  { phase: "sources", run: deleteSourcesChunk },
];

const BASE_DATA_CLEAR_STEPS: Array<{ phase: string; run: (baseId: string, db: typeof sql) => Promise<number> }> = [
  { phase: "state_variants", run: (id, db) => deleteRegistryChunk(id, "state_variants", db) },
  { phase: "state_keys", run: (id, db) => deleteRegistryChunk(id, "state_keys", db) },
  { phase: "event_kinds", run: (id, db) => deleteRegistryChunk(id, "event_kinds", db) },
  { phase: "metric_hours", run: deleteMetricHoursChunk },
  { phase: "source_scrapes", run: deleteSourceScrapesChunk },
  { phase: "ingest_idempotency", run: deleteIngestIdempotencyChunk },
  { phase: "metric_series", run: deleteMetricSeriesChunk },
  { phase: "metric_defs", run: deleteMetricDefsChunk },
];

export const createBaseLifecycle =
  (configuredStore = baseStore) =>
  async (baseId: string): Promise<{ done: boolean }> => {
    const store = { ...configuredStore, query: await configuredStore.prepare() };
    const initial = await loadStoreRow(baseId);
    if (!initial || initial.state === "failed") return { done: true };
    const operation = initial.state === "active" ? "reconcile" : initial.operation;
    if (!operation) return { done: true };
    const step = (name: string, run: (row: StoreRow, db: typeof sql) => Promise<void>) =>
      store.step(
        baseId,
        operation,
        name,
        (row, db) => run.call(store, row, db),
        operation === "reconcile" ? undefined : initial.updated_at_version,
      );
    try {
      if (operation === "delete") {
        await step("drop_reader", store.dropReader);
        let work = false;
        for (const batch of BASE_DELETE_STEPS) {
          await step(`postgres:${batch.phase}`, async (_row, db) => {
            work = (await batch.run(baseId, db)) > 0;
          });
          if (work) return { done: false };
        }
        await step("drop_database", store.dropDatabase);
        await step("access", async (_row, db) => {
          work = (await deleteBaseAccessChunk(baseId, db)) > 0;
        });
        if (work) return { done: false };
        await step("base", async (_row, db) => {
          await db`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
        });
        return { done: true };
      }
      if (operation === "clear") {
        for (const batch of BASE_DATA_CLEAR_STEPS) {
          let work = false;
          await step(`postgres:${batch.phase}`, async (_row, db) => {
            work = (await batch.run(baseId, db)) > 0;
          });
          if (work) return { done: false };
        }
      }
      await step("password", store.password);
      if (operation !== "reconcile") await step("database", store.database);
      for (const _version of BASE_SCHEMA_VERSIONS) await step("schema", store.schema);
      await step("ttl", store.ttl);
      await step("reader", store.reader);
      await step("grants", store.grants);
      if (operation === "clear") await step("truncate", store.truncate);
      if (operation !== "reconcile") {
        await step("checkpoint_pending", prepareCheckpoint);
        let inserted: Awaited<ReturnType<typeof insertCheckpoint>> | undefined;
        await step("checkpoint_insert", async (row) => {
          inserted = await insertCheckpoint(row, store);
        });
        await step("checkpoint_accept", async (row, db) => acceptCheckpoint(row, db, inserted, store.clock));
      }
      await step("active", async (_row, db) => {
        await db`UPDATE pulse.base_stores SET state='active',operation=NULL,attempts=0,last_error=NULL,last_error_at=NULL,reconcile_needed=CASE WHEN updated_at::text=${initial.updated_at_version} THEN false ELSE reconcile_needed END,
        sealed_before=CASE WHEN ${operation === "clear"} THEN NULL ELSE sealed_before END,
        usage_bytes=CASE WHEN ${operation === "clear"} THEN NULL ELSE usage_bytes END,
        usage_rows=CASE WHEN ${operation === "clear"} THEN NULL ELSE usage_rows END,
        usage_measured_at=CASE WHEN ${operation === "clear"} THEN NULL ELSE usage_measured_at END,
        storage_exceeded_at=CASE WHEN ${operation === "clear"} THEN NULL ELSE storage_exceeded_at END,
        write_block_reason=CASE WHEN ${operation === "clear"} THEN NULL ELSE write_block_reason END,
        write_blocked_at=CASE WHEN ${operation === "clear"} THEN NULL ELSE write_blocked_at END,updated_at=now() WHERE base_id=${baseId}::uuid`;
        if (operation === "clear") {
          await db`UPDATE pulse.bases SET data_clear_completed_at=now(),data_clear_failed_at=NULL,data_clear_error=NULL WHERE id=${baseId}::uuid`;
          await db`UPDATE pulse.sources SET last_seen_at=NULL,last_data_at=NULL,throttled_at=NULL,last_error=NULL,last_error_at=NULL,
            last_scrape_slot_at=NULL,scrape_lease_until=NULL,refused_histograms='[]'::jsonb,skipped_summaries=0 WHERE base_id=${baseId}::uuid`;
        }
      });
      return { done: true };
    } catch (error) {
      if (error instanceof BaseOperationSuperseded) return { done: false };
      const code = storeErrorCode(error);
      await sql`UPDATE pulse.base_stores SET attempts=attempts+1,last_error=${code},last_error_at=now(),
      state=CASE WHEN attempts+1>=5 AND state<>'active' THEN 'failed' ELSE state END,updated_at=now()
      WHERE base_id=${baseId}::uuid AND state=${initial.state} AND operation IS NOT DISTINCT FROM ${initial.operation} AND (${operation === "reconcile"} OR updated_at::text=${initial.updated_at_version})`;
      throw new BaseStoreError(code);
    }
  };
export const runBaseLifecycle = createBaseLifecycle();
const lifecycleJob = lazySync((sync) =>
  sync.job<BaseJobInput>({
    id: "pulse:base-lifecycle",
    delivery: { ackWaitMs: 300_000, maxAttempts: 5, backoffMs: [5_000, 10_000, 20_000, 40_000] },
  }),
);
let worker: Worker | undefined;
export const submitBaseLifecycleJob = async (baseId: string, publicBaseId: string) => {
  await lifecycleJob().submit({ key: `base:${baseId}`, coalesce: true, input: { baseId, publicBaseId } });
};
export const startPulseBaseJobs = async (run = runBaseLifecycle) => {
  worker ??= await lifecycleJob().process(
    {
      onError: async ({ context }) => {
        const row = await loadStoreRow(context.input.baseId);
        return row?.state === "failed" ? { action: "dead_letter", reason: "STORE_LIFECYCLE_FAILED" } : { action: "retry" };
      },
    },
    async (context) => {
      if (!(await run(context.input.baseId)).done) context.resubmit();
    },
  );
};
export const stopPulseBaseJobs = async () => {
  await worker?.drain();
  worker = undefined;
};
export const resumePulseBaseJobs = async () => {
  if (!(await pulseStoreConfigured())) return;
  const rows = await sql<
    { base_id: string; short_id: string }[]
  >`SELECT s.base_id,b.short_id FROM pulse.base_stores s JOIN pulse.bases b ON b.id=s.base_id
    WHERE s.state IN ('provisioning','clearing','deleting') OR (s.state='active' AND (s.reconcile_needed OR s.schema_version<${LATEST_BASE_SCHEMA_VERSION}))
    ORDER BY s.updated_at,s.base_id LIMIT 50`;
  for (const row of rows) await submitBaseLifecycleJob(row.base_id, row.short_id);
};
