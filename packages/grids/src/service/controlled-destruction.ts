import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { ScheduleContext, Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { logger } from "@valentinkolb/cloud/services";
import { type SQL, sql } from "bun";
import {
  CONTROLLED_DESTRUCTION_BATCH_MAX,
  type ControlledDestructionOverview,
  type ControlledDestructionPreview,
  type ControlledDestructionRun,
  type StartControlledDestructionInput,
} from "../controlled-destruction-contracts";
import { logAudit } from "./audit";
import { serviceMessagesFor } from "./messages";
import { admitDestruction } from "./preservation-holds";
import { insertWithShortIdForDb } from "./short-id";

type Actor = { id: string | null; displayName: string | null };

const log = logger("grids:controlled-destruction");
const DESTRUCTION_DELIVERY = { ackWaitMs: 30_000, maxAttempts: 3, backoffMs: [1_000, 2_000] };
/** A run heartbeats after every item; silence longer than the whole transport budget means no worker owns it. */
const STUCK_RUN_MS =
  DESTRUCTION_DELIVERY.ackWaitMs * DESTRUCTION_DELIVERY.maxAttempts + DESTRUCTION_DELIVERY.backoffMs.reduce((sum, ms) => sum + ms, 0);
const STUCK_RUN_MESSAGE = "The destruction worker stopped before finishing. Ask an operator to inspect the Grids logs.";
const RECONCILE_BATCH_SIZE = 100;

type PreviewCountRow = {
  total: number;
  eligible: number;
  retained: number;
  held: number;
  unknown: number;
  eligible_bytes: number | string;
  minimum_days: number | null;
  observed_at: Date;
};

type CandidateRow = {
  file_id: string;
  table_id: string;
  table_short_id: string;
  table_name: string;
  filename: string;
  size_bytes: number | string;
  unreferenced_at: Date;
  not_before: Date;
};

type RunRow = {
  id: string;
  short_id: string;
  base_short_id: string;
  status: ControlledDestructionRun["status"];
  requested_by_display_name: string | null;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  last_error: string | null;
};

type ItemRow = {
  file_short_id: string;
  table_short_id: string;
  table_name: string;
  filename: string;
  size_bytes: number | string;
  status: ControlledDestructionRun["items"][number]["status"];
  message: string | null;
};

const classify = (client: SQL, baseId: string) => client`
  WITH candidate_state AS (
    SELECT candidate.file_id, candidate.base_id, candidate.table_id, candidate.table_short_id, candidate.table_name,
      candidate.unreferenced_at, file.short_id AS file_short_id, file.filename, file.size_bytes,
      policy.minimum_days,
      candidate.unreferenced_at + (policy.minimum_days * interval '1 day') AS not_before,
      EXISTS (SELECT 1 FROM grids.file_attachments attachment WHERE attachment.file_id = candidate.file_id) AS attached,
      EXISTS (SELECT 1 FROM grids.file_protected_references protected WHERE protected.file_id = candidate.file_id) AS protected,
      EXISTS (
        SELECT 1 FROM grids.preservation_holds hold
        WHERE hold.base_id = candidate.base_id AND hold.released_at IS NULL
          AND (hold.scope_type = 'base' OR hold.table_id = candidate.table_id)
      ) AS held
    FROM grids.file_retention_candidates candidate
    JOIN grids.files file ON file.id = candidate.file_id
    LEFT JOIN grids.retention_policies policy ON policy.base_id = candidate.base_id
    WHERE candidate.base_id = ${baseId}::uuid
  )
`;

export const preview = async (baseId: string): Promise<ControlledDestructionPreview> => {
  const [count] = await sql<PreviewCountRow[]>`
    ${classify(sql, baseId)}
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE table_id IS NOT NULL AND table_short_id IS NOT NULL AND table_name IS NOT NULL
        AND minimum_days IS NOT NULL AND NOT attached AND NOT protected AND NOT held AND not_before <= now())::int AS eligible,
      count(*) FILTER (WHERE table_id IS NOT NULL AND table_short_id IS NOT NULL AND table_name IS NOT NULL
        AND minimum_days IS NOT NULL AND NOT attached AND NOT protected AND NOT held AND not_before > now())::int AS retained,
      count(*) FILTER (WHERE table_id IS NOT NULL AND table_short_id IS NOT NULL AND table_name IS NOT NULL
        AND minimum_days IS NOT NULL AND NOT attached AND NOT protected AND held)::int AS held,
      count(*) FILTER (WHERE table_id IS NULL OR table_short_id IS NULL OR table_name IS NULL
        OR minimum_days IS NULL OR attached OR protected)::int AS unknown,
      COALESCE(sum(size_bytes) FILTER (WHERE table_id IS NOT NULL AND table_short_id IS NOT NULL AND table_name IS NOT NULL
        AND minimum_days IS NOT NULL AND NOT attached AND NOT protected AND NOT held AND not_before <= now()), 0)::bigint AS eligible_bytes,
      max(minimum_days)::int AS minimum_days, now() AS observed_at
    FROM candidate_state
  `;
  const rows = await sql<CandidateRow[]>`
    ${classify(sql, baseId)}
    SELECT file_short_id AS file_id, table_id::text, table_short_id, table_name, filename, size_bytes,
      unreferenced_at, not_before
    FROM candidate_state
    WHERE table_id IS NOT NULL AND table_short_id IS NOT NULL AND table_name IS NOT NULL
      AND minimum_days IS NOT NULL AND NOT attached AND NOT protected AND NOT held AND not_before <= now()
    ORDER BY not_before, file_id
    LIMIT ${CONTROLLED_DESTRUCTION_BATCH_MAX}
  `;
  const values = count ?? {
    total: 0,
    eligible: 0,
    retained: 0,
    held: 0,
    unknown: 0,
    eligible_bytes: 0,
    minimum_days: null,
    observed_at: new Date(),
  };
  return {
    observedAt: values.observed_at.toISOString(),
    minimumDays: values.minimum_days,
    counts: {
      total: Number(values.total),
      eligible: Number(values.eligible),
      retained: Number(values.retained),
      held: Number(values.held),
      unknown: Number(values.unknown),
      eligibleBytes: Number(values.eligible_bytes),
    },
    items: rows.map((row) => ({
      fileId: row.file_id,
      tableId: row.table_short_id,
      tableName: row.table_name,
      filename: row.filename,
      sizeBytes: Number(row.size_bytes),
      unreferencedAt: row.unreferenced_at.toISOString(),
      notBefore: row.not_before.toISOString(),
    })),
    truncated: Number(values.eligible) > rows.length,
  };
};

const loadRun = async (baseId: string, runPublicId: string, client: SQL = sql): Promise<ControlledDestructionRun | null> => {
  const [run] = await client<RunRow[]>`
    SELECT run.id::text, run.short_id, base.short_id AS base_short_id, run.status,
      run.requested_by_display_name, run.requested_at, run.started_at, run.completed_at, run.last_error
    FROM grids.controlled_destruction_runs run
    JOIN grids.bases base ON base.id = run.base_id
    WHERE run.base_id = ${baseId}::uuid AND run.short_id = ${runPublicId}
  `;
  if (!run) return null;
  if (typeof run.short_id !== "string") throw new Error("Controlled destruction run has an invalid public ID");
  const items = await client<ItemRow[]>`
    SELECT file_short_id, table_short_id, table_name, filename, size_bytes, status, message
    FROM grids.controlled_destruction_items
    WHERE run_id = ${run.id}::uuid
    ORDER BY position
  `;
  const destroyed = items.filter((item) => item.status === "destroyed").length;
  const skipped = items.filter((item) => item.status === "skipped").length;
  const failed = items.filter((item) => item.status === "failed").length;
  return {
    id: run.short_id,
    baseId: run.base_short_id,
    status: run.status,
    requestedByDisplayName: run.requested_by_display_name,
    requestedAt: run.requested_at.toISOString(),
    startedAt: run.started_at?.toISOString() ?? null,
    completedAt: run.completed_at?.toISOString() ?? null,
    counts: { total: items.length, processed: destroyed + skipped + failed, destroyed, skipped, failed },
    items: items.map((item) => ({
      fileId: item.file_short_id,
      tableId: item.table_short_id,
      tableName: item.table_name,
      filename: item.filename,
      sizeBytes: Number(item.size_bytes),
      status: item.status,
      message: item.message,
    })),
    error: run.last_error,
  };
};

export const get = (baseId: string, runPublicId: string): Promise<ControlledDestructionRun | null> => loadRun(baseId, runPublicId);

export const list = async (baseId: string, limit = 10): Promise<ControlledDestructionRun[]> => {
  const rows = await sql<Array<{ short_id: string }>>`
    SELECT short_id FROM grids.controlled_destruction_runs
    WHERE base_id = ${baseId}::uuid
    ORDER BY requested_at DESC, id DESC
    LIMIT ${Math.min(Math.max(limit, 1), 20)}
  `;
  return (await Promise.all(rows.map((row) => get(baseId, row.short_id)))).filter((run): run is ControlledDestructionRun => run !== null);
};

export const overview = async (baseId: string): Promise<ControlledDestructionOverview> => ({
  preview: await preview(baseId),
  runs: await list(baseId),
});

type ProcessResult = "destroyed" | "skipped" | "canceled";

const processOne = async (runId: string): Promise<ProcessResult | null> =>
  sql.begin(async (tx) => {
    const [run] = await tx<Array<{ base_id: string; status: string; requested_by: string | null; short_id: string }>>`
      SELECT base_id::text, status, requested_by::text, short_id
      FROM grids.controlled_destruction_runs WHERE id = ${runId}::uuid FOR UPDATE
    `;
    if (!run || !["running", "cancel_requested"].includes(run.status)) return null;
    const [item] = await tx<
      Array<{
        position: number;
        file_id: string;
        file_short_id: string;
        table_id: string;
        table_short_id: string;
        filename: string;
        size_bytes: number | string;
      }>
    >`
      SELECT position, file_id::text, file_short_id, table_id::text, table_short_id, filename, size_bytes
      FROM grids.controlled_destruction_items
      WHERE run_id = ${runId}::uuid AND status = 'pending'
      ORDER BY position LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (!item) return null;
    if (run.status === "cancel_requested") {
      await tx`
        UPDATE grids.controlled_destruction_items SET status = 'skipped', message = 'Canceled before destruction.', processed_at = now()
        WHERE run_id = ${runId}::uuid AND position = ${item.position}
      `;
      return "canceled";
    }
    const [candidate] = await tx<Array<{ base_id: string; table_id: string | null; unreferenced_at: Date }>>`
      SELECT candidate.base_id::text, candidate.table_id::text, candidate.unreferenced_at
      FROM grids.file_retention_candidates candidate
      WHERE candidate.file_id = ${item.file_id}::uuid
      FOR UPDATE OF candidate
    `;
    const [policy] = await tx<Array<{ minimum_days: number; reached: boolean }>>`
      SELECT minimum_days,
        ${candidate?.unreferenced_at ?? null}::timestamptz + (minimum_days * interval '1 day') <= now() AS reached
      FROM grids.retention_policies WHERE base_id = ${run.base_id}::uuid FOR SHARE
    `;
    const skip = async (message: string): Promise<ProcessResult> => {
      await tx`
        UPDATE grids.controlled_destruction_items SET status = 'skipped', message = ${message}, processed_at = now()
        WHERE run_id = ${runId}::uuid AND position = ${item.position}
      `;
      return "skipped";
    };
    if (!candidate || candidate.base_id !== run.base_id || candidate.table_id !== item.table_id || !policy)
      return skip("Eligibility changed or the candidate origin is unknown.");
    if (!policy.reached) return skip("The current retention floor has not been reached.");
    const [references] = await tx<Array<{ attached: boolean; protected: boolean }>>`
      SELECT
        EXISTS (SELECT 1 FROM grids.file_attachments WHERE file_id = ${item.file_id}::uuid) AS attached,
        EXISTS (SELECT 1 FROM grids.file_protected_references WHERE file_id = ${item.file_id}::uuid) AS protected
    `;
    if (references?.attached || references?.protected) return skip("The File gained a current or protected reference.");
    const admitted = await admitDestruction({ type: "table", baseId: run.base_id, tableId: item.table_id }, tx);
    if (!admitted.ok) return skip(admitted.error.message);
    const deleted = await tx`
      DELETE FROM grids.files file
      WHERE file.id = ${item.file_id}::uuid
        AND NOT EXISTS (SELECT 1 FROM grids.file_attachments attachment WHERE attachment.file_id = file.id)
        AND NOT EXISTS (SELECT 1 FROM grids.file_protected_references protected WHERE protected.file_id = file.id)
      RETURNING id
    `;
    if (deleted.length === 0) return skip("The File is no longer eligible for destruction.");
    await tx`
      UPDATE grids.controlled_destruction_items SET status = 'destroyed', message = NULL, processed_at = now()
      WHERE run_id = ${runId}::uuid AND position = ${item.position}
    `;
    await logAudit(
      {
        baseId: run.base_id,
        tableId: item.table_id,
        userId: run.requested_by,
        action: "controlled_destruction.file_destroyed",
        diff: {
          fileId: { old: item.file_short_id, new: null },
          tableId: { old: item.table_short_id, new: item.table_short_id },
          filename: { old: item.filename, new: null },
          sizeBytes: { old: Number(item.size_bytes), new: null },
          runId: { old: run.short_id, new: run.short_id },
        },
      },
      tx,
    );
    return "destroyed";
  });

export const processRun = async (runId: string, heartbeat: () => Promise<void> = async () => undefined): Promise<void> => {
  const [claimed] = await sql<Array<{ id: string }>>`
    UPDATE grids.controlled_destruction_runs
    SET status = 'running', started_at = COALESCE(started_at, now()), last_error = NULL
    WHERE id = ${runId}::uuid AND status IN ('queued', 'running')
    RETURNING id::text
  `;
  if (!claimed) return;
  while (true) {
    const result = await processOne(runId);
    if (!result) break;
    await heartbeat();
  }
  await sql.begin(async (tx) => {
    const [run] = await tx<Array<{ status: string }>>`
      SELECT status FROM grids.controlled_destruction_runs WHERE id = ${runId}::uuid FOR UPDATE
    `;
    const [counts] = await tx<Array<{ pending: number; destroyed: number; skipped: number; failed: number }>>`
      SELECT count(*) FILTER (WHERE item.status = 'pending')::int AS pending,
        count(*) FILTER (WHERE item.status = 'destroyed')::int AS destroyed,
        count(*) FILTER (WHERE item.status = 'skipped')::int AS skipped,
        count(*) FILTER (WHERE item.status = 'failed')::int AS failed
      FROM grids.controlled_destruction_items item
      WHERE item.run_id = ${runId}::uuid
    `;
    if (!run || !counts) return;
    if (run.status === "cancel_requested" && counts.pending > 0) {
      await tx`
        UPDATE grids.controlled_destruction_items
        SET status = 'skipped', message = 'Canceled before destruction.', processed_at = now()
        WHERE run_id = ${runId}::uuid AND status = 'pending'
      `;
    }
    const status = run.status === "cancel_requested" ? "canceled" : counts.failed > 0 || counts.skipped > 0 ? "partial" : "completed";
    await tx`
      UPDATE grids.controlled_destruction_runs SET status = ${status}, completed_at = now()
      WHERE id = ${runId}::uuid AND status IN ('running', 'cancel_requested')
    `;
  });
};

/**
 * A process killed on its last attempt dead-letters without `onError`, leaving
 * the run `running` forever. A run that made no progress for the whole
 * transport budget has no live worker; oldest first, one bounded batch.
 */
export const reconcileStuckControlledDestructionRuns = async (context?: Pick<ScheduleContext, "signal" | "heartbeat">): Promise<number> => {
  const staleBefore = sql`now() - (${STUCK_RUN_MS} * interval '1 millisecond')`;
  const rows = await sql<Array<{ id: string }>>`
    SELECT run.id::text
    FROM grids.controlled_destruction_runs run
    WHERE run.status IN ('running', 'cancel_requested')
      AND COALESCE(run.started_at, run.requested_at) < ${staleBefore}
      AND NOT EXISTS (
        SELECT 1 FROM grids.controlled_destruction_items item
        WHERE item.run_id = run.id AND item.processed_at >= ${staleBefore}
      )
    ORDER BY run.started_at, run.id
    LIMIT ${RECONCILE_BATCH_SIZE}
  `;
  let reconciled = 0;
  for (const row of rows) {
    context?.signal.throwIfAborted();
    const updated = await sql`
      UPDATE grids.controlled_destruction_runs run
      SET status = CASE WHEN run.status = 'cancel_requested' THEN 'canceled' ELSE 'failed' END,
          completed_at = now(),
          last_error = CASE WHEN run.status = 'cancel_requested' THEN NULL ELSE ${STUCK_RUN_MESSAGE} END
      WHERE run.id = ${row.id}::uuid AND run.status IN ('running', 'cancel_requested')
        AND COALESCE(run.started_at, run.requested_at) < ${staleBefore}
        AND NOT EXISTS (
          SELECT 1 FROM grids.controlled_destruction_items item
          WHERE item.run_id = run.id AND item.processed_at >= ${staleBefore}
        )
      RETURNING run.id
    `;
    reconciled += updated.length;
    await context?.heartbeat();
  }
  if (reconciled > 0) log.warn("Marked abandoned controlled destruction runs as failed", { count: reconciled });
  return reconciled;
};

const destructionJob = lazySync((sync) =>
  sync.job<{ runId: string }>({ id: "grids:controlled-destruction", delivery: DESTRUCTION_DELIVERY }),
);
let destructionWorker: Worker | undefined;
export const startControlledDestructionJobs = async (): Promise<void> => {
  if (destructionWorker) return;
  await reconcileStuckControlledDestructionRuns().catch((error) => {
    log.warn("Controlled destruction boot reconcile failed", { error: error instanceof Error ? error.message : String(error) });
  });
  destructionWorker = await destructionJob().process(
    {
      onError: async ({ context: ctx, error }) => {
        if (ctx.attempt < DESTRUCTION_DELIVERY.maxAttempts) return { action: "retry" };
        await sql.begin(async (tx) => {
          await tx`
        UPDATE grids.controlled_destruction_items
        SET status = 'failed', message = 'Destruction failed. Ask an operator to inspect the Grids logs.', processed_at = now()
        WHERE run_id = ${ctx.input.runId}::uuid AND status = 'pending'
          AND position = (
            SELECT position FROM grids.controlled_destruction_items
            WHERE run_id = ${ctx.input.runId}::uuid AND status = 'pending'
            ORDER BY position LIMIT 1
          )
      `;
          await tx`
        UPDATE grids.controlled_destruction_runs
        SET status = 'failed', completed_at = now(), last_error = 'The destruction job failed. Ask an operator to inspect the Grids logs.'
        WHERE id = ${ctx.input.runId}::uuid AND status IN ('queued', 'running', 'cancel_requested')
      `;
        });
        return { action: "dead_letter", reason: error.message };
      },
    },
    async (ctx) => processRun(ctx.input.runId, () => ctx.heartbeat()),
  );
};

const queueRun = async (runId: string): Promise<void> => {
  try {
    await destructionJob().submit({ key: `run:${runId}`, input: { runId } });
  } catch (error) {
    await sql`
      UPDATE grids.controlled_destruction_runs
      SET status = 'failed', completed_at = now(), last_error = 'The destruction job could not be queued.'
      WHERE id = ${runId}::uuid AND status = 'queued'
    `;
    throw error;
  }
};

export const start = async (
  baseId: string,
  input: StartControlledDestructionInput,
  actor: Actor,
  enqueue: (runId: string) => Promise<void> = queueRun,
  locale?: string,
): Promise<Result<ControlledDestructionRun>> => {
  const t = serviceMessagesFor(locale);
  const [base] = await sql<Array<{ name: string }>>`SELECT name FROM grids.bases WHERE id = ${baseId}::uuid AND deleted_at IS NULL`;
  if (!base) return fail(err.notFound(t.base));
  if (input.confirmation !== base.name) return fail(err.badInput(t.confirmationMismatch));
  const current = await preview(baseId);
  const byId = new Map(current.items.map((item) => [item.fileId, item]));
  const selected = input.fileIds.map((fileId) => byId.get(fileId));
  if (selected.some((item) => !item)) return fail(err.conflict(t.destructionPreviewChanged));
  const row = await sql.begin((tx) =>
    insertWithShortIdForDb(tx, "idx_grids_controlled_destruction_runs_short_id", async (attempt, shortId) => {
      const [created] = await attempt<Array<{ id: string; short_id: string }>>`
        INSERT INTO grids.controlled_destruction_runs (short_id, base_id, status, requested_by, requested_by_display_name)
        VALUES (${shortId}, ${baseId}::uuid, 'queued', ${actor.id}::uuid, ${actor.displayName})
        RETURNING id::text, short_id
      `;
      if (!created) throw new Error("Controlled destruction run insert returned no row");
      for (const [position, item] of selected.entries()) {
        if (!item) continue;
        await attempt`
          INSERT INTO grids.controlled_destruction_items (
            run_id, position, file_id, file_short_id, table_id, table_short_id, table_name, filename, size_bytes
          )
          SELECT ${created.id}::uuid, ${position}, candidate.file_id, file.short_id, candidate.table_id,
            candidate.table_short_id, candidate.table_name, file.filename, file.size_bytes
          FROM grids.file_retention_candidates candidate
          JOIN grids.files file ON file.id = candidate.file_id
          WHERE candidate.base_id = ${baseId}::uuid AND file.short_id = ${item.fileId}
            AND candidate.table_id IS NOT NULL AND candidate.table_short_id IS NOT NULL AND candidate.table_name IS NOT NULL
        `;
      }
      const [inserted] = await attempt<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.controlled_destruction_items WHERE run_id = ${created.id}::uuid
      `;
      if (inserted?.count !== selected.length) throw new Error("Controlled destruction selection changed during creation");
      await logAudit(
        {
          baseId,
          userId: actor.id,
          action: "controlled_destruction.started",
          diff: { runId: { old: null, new: created.short_id }, files: { old: null, new: selected.length } },
        },
        attempt,
      );
      return created;
    }),
  );
  await enqueue(row.id);
  const run = await get(baseId, row.short_id);
  if (!run) throw new Error("Controlled destruction run disappeared");
  return ok(run);
};

export const cancel = async (baseId: string, runPublicId: string, locale?: string): Promise<Result<ControlledDestructionRun>> => {
  const [updated] = await sql<Array<{ id: string }>>`
    UPDATE grids.controlled_destruction_runs
    SET status = CASE WHEN status = 'queued' THEN 'canceled' ELSE 'cancel_requested' END,
      completed_at = CASE WHEN status = 'queued' THEN now() ELSE completed_at END
    WHERE base_id = ${baseId}::uuid AND short_id = ${runPublicId} AND status IN ('queued', 'running')
    RETURNING id::text
  `;
  if (!updated) return fail(err.conflict(serviceMessagesFor(locale).destructionCancelState));
  await sql`
    UPDATE grids.controlled_destruction_items
    SET status = 'skipped', message = 'Canceled before destruction.', processed_at = now()
    WHERE run_id = ${updated.id}::uuid AND status = 'pending'
      AND EXISTS (SELECT 1 FROM grids.controlled_destruction_runs WHERE id = ${updated.id}::uuid AND status = 'canceled')
  `;
  const run = await get(baseId, runPublicId);
  if (!run) throw new Error("Canceled controlled destruction run disappeared");
  return ok(run);
};

export const stopControlledDestructionJobs = async (): Promise<void> => {
  await destructionWorker?.drain({ timeoutMs: 30_000 });
  destructionWorker = undefined;
};
