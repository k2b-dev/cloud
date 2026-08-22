/**
 * The kernel's run store.
 *
 * Grids and Mail each wrote their own version of this — 904 and 717 lines that
 * agreed on almost everything and differed in the places that matter: Mail
 * leased a target while Grids leased a run, Mail fenced with a generation *and*
 * a token while Grids used the generation alone, and Mail's `heartbeat`
 * silently ignored the run it was passed.
 *
 * Execution is "find the first step with no recorded outcome, run it, record
 * it". Crash recovery is that same loop, which is why there is no separate
 * recovery path below: a claim on a run whose lease expired resumes it, and
 * the journal makes the steps that already happened free to skip.
 *
 * The fence is `execution_generation`. Every claim increments it, so a worker
 * that lost its lease writes with a stale generation and every one of its
 * updates matches zero rows. Nothing here trusts wall-clock ordering.
 */
import { type SQL, sql } from "bun";
import type { WorkflowBoundPlan, WorkflowDependency, WorkflowInvocationMode, WorkflowJsonValue, WorkflowRunState } from "../contracts";
import type {
  WorkflowCoordinatorFinishState,
  WorkflowCoordinatorLeaseState,
  WorkflowCoordinatorPort,
  WorkflowCoordinatorReleaseState,
} from "../runtime/coordinator";
import { WorkflowLeaseLostError } from "../runtime/executor";
import type {
  WorkflowHeartbeatOutcome,
  WorkflowRestoredStep,
  WorkflowRuntimeRepositoryPort,
  WorkflowRuntimeRunIdentity,
  WorkflowRuntimeStepIdentity,
  WorkflowRuntimeStepResult,
} from "../runtime/ports";
import { withTransaction } from "./transaction";

/** How long a claim survives without a heartbeat. */
export const WORKFLOW_RUN_LEASE_MS = 120_000;

/** How long a released run waits before it can be picked up again. */
const RELEASE_BACKOFF_MS = 5_000;
const RELEASE_MAX_BACKOFF_MS = 5 * 60_000;

/** A repeatedly crashing/retryable run eventually becomes an operator-visible failure. */
export const WORKFLOW_RUN_MAX_CONSECUTIVE_FAILURES = 8;

/** A run state that no longer moves on its own. */
const TERMINAL_RUN_STATES: readonly WorkflowRunState[] = ["succeeded", "failed", "canceled", "needs_attention"];

export type WorkflowRunClaim = {
  runId: string;
  executionGeneration: number;
  mode: WorkflowInvocationMode;
  workflowId: string;
  workflowVersionId: string;
  sourceHash: string;
  idempotencyKey: string;
  appId: string;
  scopeId: string;
  /** The pinned plan. Read from the version the run points at, never the workflow's current one. */
  plan: WorkflowBoundPlan;
  inputs: Record<string, WorkflowJsonValue>;
  context: Record<string, WorkflowJsonValue>;
  authorization: WorkflowJsonValue;
  /**
   * The event's logical time, not the worker's clock. A replay after a crash
   * must see the same "now" the first attempt did, or a step reading the date
   * stops being a function of its inputs.
   */
  occurredAt: Date;
  parentRunId: string | null;
  parentStepKey: string | null;
  attempt: number;
  consecutiveFailures: number;
};

/** The outcome a run settles into. `waiting` means it parked and will be woken. */
export type WorkflowRunResult =
  | { state: "succeeded"; result?: WorkflowJsonValue; message?: string }
  | { state: "failed"; error: WorkflowJsonValue }
  | { state: "needs_attention"; error: WorkflowJsonValue }
  | { state: "canceled"; message?: string }
  | { state: "waiting" };

type ClaimRow = {
  id: string;
  execution_generation: string;
  mode: WorkflowInvocationMode;
  workflow_id: string;
  workflow_version_id: string;
  source_hash: string;
  idempotency_key: string;
  app_id: string;
  scope_id: string;
  plan: WorkflowBoundPlan;
  inputs: Record<string, WorkflowJsonValue>;
  context: Record<string, WorkflowJsonValue>;
  authorization_snapshot: WorkflowJsonValue;
  occurred_at: Date;
  parent_run_id: string | null;
  parent_step_key: string | null;
  attempt: number;
  consecutive_failures: number;
};

const toClaim = (row: ClaimRow): WorkflowRunClaim => ({
  runId: row.id,
  executionGeneration: Number(row.execution_generation),
  mode: row.mode,
  workflowId: row.workflow_id,
  workflowVersionId: row.workflow_version_id,
  sourceHash: row.source_hash,
  idempotencyKey: row.idempotency_key,
  appId: row.app_id,
  scopeId: row.scope_id,
  plan: row.plan,
  inputs: row.inputs,
  context: row.context,
  authorization: row.authorization_snapshot,
  occurredAt: row.occurred_at,
  parentRunId: row.parent_run_id,
  parentStepKey: row.parent_step_key,
  attempt: row.attempt,
  consecutiveFailures: row.consecutive_failures,
});

/**
 * Why an update matched no rows.
 *
 * The distinction is not cosmetic: a cancelled run must stop, a stale one must
 * abandon its work silently because someone else already owns it, and treating
 * either as the other either duplicates effects or strands runs.
 */
const diagnoseLostLease = async (
  db: SQL,
  runId: string,
  executionGeneration: number,
): Promise<{ state: "stale" } | { state: "canceled"; message?: string }> => {
  const [row] = await db<{ state: WorkflowRunState; execution_generation: string; cancel_requested_at: Date | null }[]>`
    SELECT state, execution_generation, cancel_requested_at FROM workflows.run WHERE id = ${runId}
  `;
  if (!row) return { state: "stale" };
  const ours = Number(row.execution_generation) === executionGeneration;
  if (ours && (row.cancel_requested_at !== null || row.state === "canceled")) return { state: "canceled" };
  return { state: "stale" };
};

// ─── Creation ────────────────────────────────────────────────────────────────

export type NewWorkflowRun = {
  appId: string;
  scopeId: string;
  workflowId: string;
  workflowVersionId: string;
  mode: WorkflowInvocationMode;
  authorization: WorkflowJsonValue;
  idempotencyKey: string;
  occurredAt: Date;
  inputs?: Record<string, WorkflowJsonValue>;
  /** Read by the plan as context.*, alongside the inputs. */
  context?: Record<string, WorkflowJsonValue>;
  eventId?: string;
  /** Set together, or the run is not a child of anything. */
  parentRunId?: string;
  parentStepKey?: string;
};

/**
 * Queues a run, or returns the existing one for the same idempotency key.
 *
 * Returning the existing id rather than raising is what lets a retried request
 * — a webhook redelivery, a double-clicked button — be answered with the run it
 * already started instead of starting a second one.
 */
export const createWorkflowRun = async (run: NewWorkflowRun, options: { db?: SQL } = {}): Promise<string> => {
  const db = options.db ?? sql;
  const [row] = await db<{ id: string }[]>`
    INSERT INTO workflows.run (
      app_id, scope_id, workflow_id, workflow_version_id, event_id, parent_run_id, parent_step_key,
      mode, inputs, context, authorization_snapshot, idempotency_key, occurred_at
    )
    SELECT
      w.app_id, w.scope_id, w.id, v.id,
      ${run.eventId ?? null}::uuid, ${run.parentRunId ?? null}::uuid, ${run.parentStepKey ?? null},
      ${run.mode}, ${run.inputs ?? {}}, ${run.context ?? {}}, ${run.authorization},
      ${run.idempotencyKey}, ${run.occurredAt}
    FROM workflows.workflow AS w
    JOIN workflows.version AS v ON v.workflow_id = w.id
    WHERE w.id = ${run.workflowId}::uuid
      AND v.id = ${run.workflowVersionId}::uuid
      AND w.app_id = ${run.appId}
      AND w.scope_id = ${run.scopeId}
      AND (
        ${run.parentRunId ?? null}::uuid IS NULL
        OR EXISTS (
          SELECT 1 FROM workflows.run AS parent
          WHERE parent.id = ${run.parentRunId ?? null}::uuid
            AND parent.app_id = w.app_id
            AND parent.scope_id = w.scope_id
        )
      )
    ON CONFLICT (workflow_id, mode, idempotency_key) DO UPDATE SET updated_at = workflows.run.updated_at
    RETURNING id
  `;
  if (!row) throw new Error("workflow run does not match its workflow version, app, scope, or parent");
  return row.id;
};

/**
 * Fans out into child runs in one statement.
 *
 * A bulk operation over 10,000 records is 10,000 of these rather than rows in a
 * targets table, so the parent's progress is a plain aggregate over its
 * children and there is only one lease protocol to reason about.
 */
export const createChildWorkflowRuns = async (
  parent: { runId: string; stepKey: string },
  children: readonly NewWorkflowRun[],
  options: { db?: SQL } = {},
): Promise<number> => {
  if (children.length === 0) return 0;
  const db = options.db ?? sql;
  const values = children.map((child) => ({
    app_id: child.appId,
    scope_id: child.scopeId,
    workflow_id: child.workflowId,
    workflow_version_id: child.workflowVersionId,
    event_id: child.eventId ?? null,
    parent_run_id: parent.runId,
    parent_step_key: parent.stepKey,
    mode: child.mode,
    inputs: child.inputs ?? {},
    context: child.context ?? {},
    authorization_snapshot: child.authorization,
    idempotency_key: child.idempotencyKey,
    occurred_at: child.occurredAt,
  }));
  const rows = await db<{ id: string }[]>`
    INSERT INTO workflows.run ${db(values)}
    ON CONFLICT (workflow_id, mode, idempotency_key) DO NOTHING
    RETURNING id
  `;
  return rows.length;
};

/** How a parent's fan-out is doing, as one aggregate over the child index. */
export const countChildWorkflowRuns = async (
  parentRunId: string,
  options: { db?: SQL } = {},
): Promise<Record<WorkflowRunState, number>> => {
  const db = options.db ?? sql;
  const rows = await db<{ state: WorkflowRunState; count: string }[]>`
    SELECT state, count(*) AS count FROM workflows.run WHERE parent_run_id = ${parentRunId}::uuid GROUP BY state
  `;
  const counts = { queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, canceled: 0, needs_attention: 0 };
  for (const row of rows) counts[row.state] = Number(row.count);
  return counts;
};

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Takes the next claimable run, or a named one.
 *
 * `SKIP LOCKED` is what makes several workers safe to run against the same
 * queue: they step over each other's candidates instead of serialising on the
 * first row.
 */
export const claimWorkflowRun = async (options: {
  worker: string;
  runId?: string;
  /** Restricts a worker to one app's runs, so a per-app process cannot drain another's. */
  appId?: string;
  /**
   * Which mode to claim. Defaults to `execute`.
   *
   * A dry run asks what *would* happen; claiming one and running it through the
   * execute path performs the effects it was meant to only describe.
   */
  mode?: WorkflowInvocationMode;
  leaseMs?: number;
  db?: SQL;
}): Promise<WorkflowRunClaim | null> => {
  const db = options.db ?? sql;
  const leaseMs = options.leaseMs ?? WORKFLOW_RUN_LEASE_MS;
  const rows = await db<ClaimRow[]>`
    WITH candidate AS (
      SELECT id FROM workflows.run
      WHERE state IN ('queued', 'running')
        AND claimable_at < now()
        AND cancel_requested_at IS NULL
        AND (${options.runId ?? null}::uuid IS NULL OR id = ${options.runId ?? null}::uuid)
        AND (${options.appId ?? null}::text IS NULL OR app_id = ${options.appId ?? null})
        AND mode = ${options.mode ?? "execute"}
      ORDER BY claimable_at, created_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE workflows.run AS r
    SET state = 'running',
        execution_generation = r.execution_generation + 1,
        attempt = r.attempt + 1,
        lease_owner = ${options.worker},
        lease_expires_at = now() + ${`${leaseMs} milliseconds`}::interval,
        retry_after = NULL,
        started_at = COALESCE(r.started_at, now()),
        updated_at = now()
    FROM candidate AS c
    JOIN workflows.version AS v ON v.id = (SELECT workflow_version_id FROM workflows.run WHERE id = c.id)
    WHERE r.id = c.id
    RETURNING r.id, r.execution_generation, r.mode, r.workflow_id, r.workflow_version_id,
              v.source_hash, r.idempotency_key, r.app_id, r.scope_id, v.plan,
              r.inputs, r.context, r.authorization_snapshot, r.occurred_at, r.parent_run_id, r.parent_step_key,
              r.attempt, r.consecutive_failures
  `;
  const row = rows[0];
  return row ? toClaim(row) : null;
};

/** Extends a lease. Returns why it could not be extended, rather than throwing. */
export const renewWorkflowRunLease = async (
  claim: { runId: string; executionGeneration: number },
  options: { leaseMs?: number; db?: SQL } = {},
): Promise<WorkflowCoordinatorLeaseState> => {
  const db = options.db ?? sql;
  const leaseMs = options.leaseMs ?? WORKFLOW_RUN_LEASE_MS;
  const rows = await db<{ id: string }[]>`
    UPDATE workflows.run
    SET lease_expires_at = now() + ${`${leaseMs} milliseconds`}::interval, updated_at = now()
    WHERE id = ${claim.runId}
      AND execution_generation = ${claim.executionGeneration}
      AND state = 'running'
      AND cancel_requested_at IS NULL
    RETURNING id
  `;
  if (rows.length > 0) return { state: "active" };
  return diagnoseLostLease(db, claim.runId, claim.executionGeneration);
};

/**
 * Records a run's outcome and drops the lease.
 *
 * A `waiting` result is the exception: the run parked itself in `parkStep`, so
 * this only confirms it is where the executor believes it is. Writing the state
 * a second time would clear the wake deadline the park just set.
 */
export const finishWorkflowRun = async (
  claim: { runId: string; executionGeneration: number },
  result: WorkflowRunResult,
  options: { db?: SQL } = {},
): Promise<WorkflowCoordinatorFinishState> => {
  const db = options.db ?? sql;

  if (result.state === "waiting") {
    // A dependency signal may have arrived between parkStep and this
    // coordinator acknowledgement. In that case parkStep already re-queued
    // the run; the waiting attempt still finished successfully.
    const rows = await db<{ id: string }[]>`
      UPDATE workflows.run
      SET consecutive_failures = 0, updated_at = now()
      WHERE id = ${claim.runId}
        AND execution_generation = ${claim.executionGeneration}
        AND state IN ('waiting', 'queued')
      RETURNING id
    `;
    if (rows.length > 0) return { state: "finished" };
    return diagnoseLostLease(db, claim.runId, claim.executionGeneration);
  }

  const serializedResult = result.state === "succeeded" ? JSON.stringify(result.result ?? null) : null;

  const rows = await db<{ id: string }[]>`
    UPDATE workflows.run
    SET state = ${result.state},
        result = (${serializedResult}::text)::jsonb,
        result_message = ${(result.state === "succeeded" || result.state === "canceled" ? result.message : null) ?? null},
        error = ${result.state === "failed" || result.state === "needs_attention" ? result.error : null},
        lease_owner = NULL,
        lease_expires_at = NULL,
        retry_after = NULL,
        consecutive_failures = 0,
        wake_at = NULL,
        finished_at = now(),
        updated_at = now()
    WHERE id = ${claim.runId}
      AND execution_generation = ${claim.executionGeneration}
      AND state IN ('running', 'waiting')
    RETURNING id
  `;
  if (rows.length > 0) return { state: "finished" };
  return diagnoseLostLease(db, claim.runId, claim.executionGeneration);
};

/**
 * Gives up a lease without recording an outcome — the crash path.
 *
 * The run goes back to `queued` and the journal makes the resumed attempt skip
 * whatever already completed. The backoff exists because a run that dies on
 * every attempt would otherwise be re-claimed as fast as the dispatcher loops.
 */
export const releaseWorkflowRun = async (
  claim: { runId: string; executionGeneration: number; consecutiveFailures?: number },
  options: { backoffMs?: number; db?: SQL } = {},
): Promise<WorkflowCoordinatorReleaseState> => {
  const db = options.db ?? sql;
  const backoffMs =
    options.backoffMs ?? Math.min(RELEASE_BACKOFF_MS * 2 ** Math.max(0, claim.consecutiveFailures ?? 0), RELEASE_MAX_BACKOFF_MS);
  const rows = await db<{ retry_after: Date }[]>`
    UPDATE workflows.run
    SET state = 'queued',
        lease_owner = NULL,
        lease_expires_at = NULL,
        retry_after = now() + ${`${backoffMs} milliseconds`}::interval,
        consecutive_failures = consecutive_failures + 1,
        updated_at = now()
    WHERE id = ${claim.runId}
      AND execution_generation = ${claim.executionGeneration}
      AND state = 'running'
    RETURNING retry_after
  `;
  const row = rows[0];
  if (row) return { state: "retry", retryAt: row.retry_after.toISOString() };
  return diagnoseLostLease(db, claim.runId, claim.executionGeneration);
};

/** Asks a run to stop. The worker notices on its next heartbeat. */
export const requestWorkflowRunCancel = async (runId: string, options: { db?: SQL } = {}): Promise<boolean> => {
  const db = options.db ?? sql;
  const rows = await db<{ id: string }[]>`
    WITH RECURSIVE descendants AS (
      SELECT id FROM workflows.run WHERE id = ${runId}::uuid
      UNION ALL
      SELECT child.id
      FROM workflows.run AS child
      JOIN descendants AS parent ON child.parent_run_id = parent.id
    )
    UPDATE workflows.run AS r
    SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
        state = CASE WHEN state IN ('queued', 'waiting') THEN 'canceled' ELSE state END,
        finished_at = CASE WHEN state IN ('queued', 'waiting') THEN now() ELSE finished_at END,
        lease_owner = CASE WHEN state IN ('queued', 'waiting') THEN NULL ELSE lease_owner END,
        lease_expires_at = CASE WHEN state IN ('queued', 'waiting') THEN NULL ELSE lease_expires_at END,
        wake_at = CASE WHEN state IN ('queued', 'waiting') THEN NULL ELSE wake_at END,
        updated_at = now()
    WHERE r.id IN (SELECT id FROM descendants)
      AND r.state NOT IN ${db(TERMINAL_RUN_STATES)}
    RETURNING r.id
  `;
  return rows.some((row) => row.id === runId);
};

const canceledWithUncertainEffect = {
  code: "WORKFLOW_EFFECT_OUTCOME_UNKNOWN",
  message: "The workflow was canceled while an external effect was still unresolved.",
  retryable: false,
} as const;

/**
 * Settles a cancellation owned by one worker generation.
 *
 * A canceled run with no uncertain effect is terminal. An effect that may have
 * escaped remains an operator decision instead: calling that run canceled would
 * hide the exact duplicate-effect risk the journal exists to expose.
 */
export const finishWorkflowRunCancel = async (
  claim: { runId: string; executionGeneration: number },
  options: { db?: SQL } = {},
): Promise<{ state: "finished"; result: Extract<WorkflowRunResult, { state: "canceled" | "needs_attention" }> } | { state: "stale" }> => {
  const db = options.db ?? sql;
  return withTransaction(db, async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      SELECT id FROM workflows.run
      WHERE id = ${claim.runId}::uuid
        AND execution_generation = ${claim.executionGeneration}
        AND state = 'running'
        AND cancel_requested_at IS NOT NULL
      FOR UPDATE
    `;
    if (!run) return { state: "stale" } as const;

    const unsettled = await tx<{ step_key: string }[]>`
      UPDATE workflows.step_outcome
      SET state = 'needs_attention',
          outcome = ${{ mode: "execute", outcome: { state: "needs_attention", error: canceledWithUncertainEffect } }},
          dependency = NULL,
          finished_at = now(),
          updated_at = now()
      WHERE run_id = ${claim.runId}::uuid
        AND effect_state IN ('executing', 'ambiguous')
      RETURNING step_key
    `;
    const result =
      unsettled.length > 0 ? ({ state: "needs_attention", error: canceledWithUncertainEffect } as const) : ({ state: "canceled" } as const);
    await tx`
      UPDATE workflows.run
      SET state = ${result.state},
          result = NULL,
          result_message = NULL,
          error = ${result.state === "needs_attention" ? result.error : null},
          lease_owner = NULL,
          lease_expires_at = NULL,
          retry_after = NULL,
          wake_at = NULL,
          finished_at = now(),
          updated_at = now()
      WHERE id = ${claim.runId}::uuid
        AND execution_generation = ${claim.executionGeneration}
        AND state = 'running'
    `;
    return { state: "finished", result } as const;
  });
};

/** Finalizes canceled runs whose worker disappeared before observing the request. */
export const finishExpiredWorkflowRunCancels = async (limit: number, options: { appId: string; db?: SQL }): Promise<number> => {
  const db = options.db ?? sql;
  return withTransaction(db, async (tx) => {
    const rows = await tx<{ id: string; execution_generation: string }[]>`
      SELECT id, execution_generation
      FROM workflows.run
      WHERE app_id = ${options.appId}
        AND state = 'running'
        AND cancel_requested_at IS NOT NULL
        AND lease_expires_at < now()
      ORDER BY lease_expires_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    for (const row of rows) {
      await finishWorkflowRunCancel({ runId: row.id, executionGeneration: Number(row.execution_generation) }, { db: tx });
    }
    return rows.length;
  });
};

/** The coordinator's view of the store, so `coordinateWorkflowExecution` drives it directly. */
export const createWorkflowCoordinatorPort = (options: {
  worker: string;
  runId?: string;
  appId: string;
  mode?: WorkflowInvocationMode;
  leaseMs?: number;
}): WorkflowCoordinatorPort<void, WorkflowRunClaim, WorkflowRunResult> => ({
  claim: () => claimWorkflowRun(options),
  renew: (claim) => renewWorkflowRunLease(claim, { leaseMs: options.leaseMs }),
  finish: (claim, result) => finishWorkflowRun(claim, result),
  release: (claim) => releaseWorkflowRun(claim),
});

// ─── Scans ───────────────────────────────────────────────────────────────────

/** Runs a worker may pick up now, oldest first. */
export const listClaimableWorkflowRunIds = async (limit: number, options: { db?: SQL } = {}): Promise<string[]> => {
  const db = options.db ?? sql;
  const rows = await db<{ id: string }[]>`
    SELECT id FROM workflows.run
    WHERE state IN ('queued', 'running')
      AND claimable_at < now()
      AND cancel_requested_at IS NULL
    ORDER BY claimable_at, created_at, id
    LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
};

/** Parked runs whose deadline has passed, so a dependency that never fires cannot strand them. */
export const wakeExpiredWorkflowRuns = async (limit: number, options: { appId?: string; db?: SQL } = {}): Promise<string[]> => {
  const db = options.db ?? sql;
  const rows = await db<{ id: string }[]>`
    UPDATE workflows.run
    SET state = 'queued', wake_at = NULL, updated_at = now()
    WHERE id IN (
      SELECT id FROM workflows.run
      WHERE state = 'waiting' AND wake_at IS NOT NULL AND wake_at <= now()
        AND (${options.appId ?? null}::text IS NULL OR app_id = ${options.appId ?? null})
      ORDER BY wake_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
  return rows.map((row) => row.id);
};

/** Re-queues every run parked on a dependency that has now been satisfied. */
export const wakeWorkflowRunsWaitingOn = async (
  dependency: { appId: string; kind: string; key: string },
  options: { db?: SQL } = {},
): Promise<string[]> => {
  return withTransaction(options.db, async (tx) => {
    await tx`
      INSERT INTO workflows.dependency_signal (app_id, kind, key)
      VALUES (${dependency.appId}, ${dependency.kind}, ${dependency.key})
      ON CONFLICT (app_id, kind, key) DO UPDATE
      SET updated_at = now()
    `;
    const rows = await tx<{ id: string }[]>`
      UPDATE workflows.run AS r
      SET state = 'queued', wake_at = NULL, updated_at = now()
      FROM workflows.step_outcome AS s
      WHERE s.run_id = r.id
        AND s.state = 'waiting'
        AND s.dependency ->> 'kind' = ${dependency.kind}
        AND s.dependency ->> 'key' = ${dependency.key}
        AND r.app_id = ${dependency.appId}
        AND r.state = 'waiting'
      RETURNING r.id
    `;
    return rows.map((row) => row.id).sort();
  });
};

// ─── Journal ─────────────────────────────────────────────────────────────────

/**
 * Thrown when a step writes under a generation the run has moved past.
 *
 * Deliberately the executor's own class rather than a second one with the same
 * name: the executor rethrows this and turns every *other* error into an action
 * failure, so a private copy would have a lost lease recorded as a step that
 * failed — on a run some other worker now owns.
 */
export { WorkflowLeaseLostError } from "../runtime/executor";

/** The `state` column mirrors the outcome's own discriminant — no second vocabulary. */
const stepState = (result: WorkflowRuntimeStepResult): string => result.outcome.state;

const stepJournal = (options: { db?: SQL } = {}): WorkflowRuntimeRepositoryPort => {
  const db = options.db ?? sql;

  /**
   * Every journal write is fenced against the *run's* current generation, not
   * the generation recorded on the step row. Matching the step's own value let
   * a worker whose lease had lapsed still record an outcome, on a run someone
   * else already owned — the step it had half-finished then looked complete to
   * the worker that took over.
   */
  const startStep = async (step: WorkflowRuntimeStepIdentity): Promise<void> => {
    const rows = await db<{ run_id: string }[]>`
      INSERT INTO workflows.step_outcome (
        run_id, step_key, source_path, iteration_path, kind, action, mode, state, execution_generation, attempt
      )
      SELECT ${step.runId}::uuid, ${step.key}, ${step.sourcePath}, ${step.iterationPath},
             ${step.kind}, ${step.action ?? null}, ${step.mode}, 'running', ${step.executionGeneration}, 0
      WHERE EXISTS (
        SELECT 1 FROM workflows.run
        WHERE id = ${step.runId}::uuid
          AND state = 'running'
          AND execution_generation = ${step.executionGeneration}
          AND cancel_requested_at IS NULL
      )
      ON CONFLICT (run_id, step_key) DO UPDATE
      SET state = 'running',
          outcome = NULL,
          dependency = NULL,
          execution_generation = EXCLUDED.execution_generation,
          attempt = workflows.step_outcome.attempt + 1,
          started_at = now(),
          finished_at = NULL,
          updated_at = now()
      RETURNING run_id
    `;
    if (rows.length === 0) throw new WorkflowLeaseLostError();
  };

  /**
   * Parks a step on something outside the run, and the run with it.
   *
   * Both happen in one transaction: a step marked waiting while its run stays
   * `running` is a run nothing will ever wake, and a run marked waiting with no
   * recorded dependency is one nothing knows how to wake.
   */
  const parkStep = async (step: WorkflowRuntimeStepIdentity, dependency: WorkflowDependency): Promise<void> => {
    await withTransaction(options.db, async (tx) => {
      const rows = await tx<{ run_id: string }[]>`
        UPDATE workflows.step_outcome AS s
        SET state = 'waiting', outcome = NULL, dependency = ${dependency}, finished_at = NULL, updated_at = now()
        FROM workflows.run AS r
        WHERE s.run_id = ${step.runId}::uuid
          AND s.step_key = ${step.key}
          AND r.id = s.run_id
          AND r.state = 'running'
          AND r.execution_generation = ${step.executionGeneration}
        RETURNING s.run_id
      `;
      if (rows.length === 0) throw new WorkflowLeaseLostError();

      const parked = await tx<{ id: string; app_id: string }[]>`
        UPDATE workflows.run
        SET state = 'waiting',
            wake_at = ${dependency.deadline ?? null}::timestamptz,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${step.runId}::uuid AND execution_generation = ${step.executionGeneration} AND state = 'running'
        RETURNING id, app_id
      `;
      const run = parked[0];
      if (!run) throw new WorkflowLeaseLostError();

      // Close wake-before-park: a signal recorded just before this transaction
      // is as satisfying as one recorded just after it.
      const [signal] = await tx<{ app_id: string }[]>`
        SELECT app_id FROM workflows.dependency_signal
        WHERE app_id = ${run.app_id}
          AND kind = ${dependency.kind}
          AND key = ${dependency.key}
      `;
      if (signal) {
        await tx`
          UPDATE workflows.run
          SET state = 'queued', wake_at = NULL, updated_at = now()
          WHERE id = ${step.runId}::uuid
            AND execution_generation = ${step.executionGeneration}
            AND state = 'waiting'
        `;
      }
    });
  };

  const finishStep = async (step: WorkflowRuntimeStepIdentity, result: WorkflowRuntimeStepResult): Promise<void> => {
    // The port's type admits a waiting outcome here; parking is the path that
    // also stops the run, so route it there rather than writing half of it.
    if (result.mode === "execute" && result.outcome.state === "waiting") {
      await parkStep(step, result.outcome.dependency);
      return;
    }
    const rows = await db<{ run_id: string }[]>`
      UPDATE workflows.step_outcome AS s
      SET state = ${stepState(result)},
          outcome = ${result},
          dependency = NULL,
          finished_at = now(),
          updated_at = now()
      FROM workflows.run AS r
      WHERE s.run_id = ${step.runId}::uuid
        AND s.step_key = ${step.key}
        AND r.id = s.run_id
        AND r.state = 'running'
        AND r.execution_generation = ${step.executionGeneration}
      RETURNING s.run_id
    `;
    if (rows.length === 0) throw new WorkflowLeaseLostError();
  };

  const restoreStepOutcome = async (step: WorkflowRuntimeStepIdentity): Promise<WorkflowRestoredStep | null> => {
    const [row] = await db<{ outcome: WorkflowRestoredStep | null }[]>`
      SELECT outcome FROM workflows.step_outcome
      WHERE run_id = ${step.runId}::uuid AND step_key = ${step.key} AND state NOT IN ('running', 'waiting')
    `;
    return row?.outcome ?? null;
  };

  const heartbeat = async (run: WorkflowRuntimeRunIdentity): Promise<WorkflowHeartbeatOutcome> =>
    renewWorkflowRunLease({ runId: run.runId, executionGeneration: run.executionGeneration }, { db });

  return { heartbeat, restoreStepOutcome, startStep, finishStep, parkStep };
};

/**
 * The kernel's `WorkflowRuntimeRepositoryPort`.
 *
 * There is one of these now. Each app used to bring its own, which is how the
 * two ended up storing different things under the same column name — Grids
 * wrote the bare outcome and reconstructed the mode from a second column, Mail
 * wrote the pair.
 */
export const createWorkflowRuntimeRepository = (options: { db?: SQL } = {}): WorkflowRuntimeRepositoryPort => stepJournal(options);

// ─── Effects ─────────────────────────────────────────────────────────────────

/**
 * Marks an impure step as having started its effect.
 *
 * Written before the effect is attempted, so a crash in between leaves the
 * evidence that something may have escaped. A step whose effect is left
 * `executing` is exactly the queue a replay has to be careful with.
 */
export const beginWorkflowEffect = async (
  step: { runId: string; key: string; executionGeneration: number },
  effectKey: string,
  options: { db?: SQL } = {},
): Promise<void> => {
  const db = options.db ?? sql;
  const rows = await db<{ run_id: string }[]>`
    UPDATE workflows.step_outcome AS s
    SET effect_key = ${effectKey},
        effect_state = 'executing',
        effect_started_at = COALESCE(s.effect_started_at, now()),
        updated_at = now()
    FROM workflows.run AS r
    WHERE s.run_id = ${step.runId}::uuid
      AND s.step_key = ${step.key}
      AND r.id = s.run_id
      AND r.state = 'running'
      AND r.execution_generation = ${step.executionGeneration}
    RETURNING s.run_id
  `;
  if (rows.length === 0) throw new WorkflowLeaseLostError();
};

/**
 * Records a completed effect and what it produced, on a caller-supplied handle.
 *
 * Called with the transaction that performed the work, so the evidence commits
 * with it: that is what lets a transactional action promise that a crash means
 * it did not happen.
 */
export const recordWorkflowEffect = async (
  db: SQL,
  step: { runId: string; key: string; executionGeneration: number },
  effectKey: string,
  output: WorkflowJsonValue,
): Promise<void> => {
  const rows = await db<{ run_id: string }[]>`
    UPDATE workflows.step_outcome AS s
    SET effect_key = ${effectKey},
        effect_state = 'succeeded',
        effect_output = ${output},
        effect_started_at = COALESCE(s.effect_started_at, now()),
        updated_at = now()
    FROM workflows.run AS r
    WHERE s.run_id = ${step.runId}::uuid
      AND s.step_key = ${step.key}
      AND r.id = s.run_id
      AND r.state = 'running'
      AND r.execution_generation = ${step.executionGeneration}
    RETURNING s.run_id
  `;
  if (rows.length === 0) throw new WorkflowLeaseLostError();
};

/** Settles an effect once its fate is known. `ambiguous` is a real answer, not a failure. */
export const settleWorkflowEffect = async (
  step: { runId: string; key: string; executionGeneration: number },
  state: "succeeded" | "ambiguous" | "failed",
  options: { db?: SQL } = {},
): Promise<void> => {
  const db = options.db ?? sql;
  const rows = await db<{ run_id: string }[]>`
    UPDATE workflows.step_outcome AS s
    SET effect_state = ${state}, updated_at = now()
    FROM workflows.run AS r
    WHERE s.run_id = ${step.runId}::uuid
      AND s.step_key = ${step.key}
      AND s.effect_key IS NOT NULL
      AND r.id = s.run_id
      AND r.state = 'running'
      AND r.execution_generation = ${step.executionGeneration}
    RETURNING s.run_id
  `;
  if (rows.length === 0) throw new WorkflowLeaseLostError();
};

export type WorkflowAttentionResolution =
  | { state: "succeeded"; output?: WorkflowJsonValue }
  | { state: "failed"; message: string; code?: string };

/**
 * Resolves the one effect a run stopped for.
 *
 * The run must already be terminal needs_attention, so this cannot race a
 * worker. Confirming success records the step outcome and re-queues the rest
 * of the immutable plan; confirming failure settles both step and run.
 */
export const resolveWorkflowRunAttention = async (
  input: { runId: string; stepKey: string; resolution: WorkflowAttentionResolution },
  options: { db?: SQL } = {},
): Promise<void> => {
  await withTransaction(options.db, async (tx) => {
    const [row] = await tx<{ effect_state: string | null }[]>`
      SELECT s.effect_state
      FROM workflows.run AS r
      JOIN workflows.step_outcome AS s ON s.run_id = r.id
      WHERE r.id = ${input.runId}::uuid
        AND r.state = 'needs_attention'
        AND s.step_key = ${input.stepKey}
        AND s.state = 'needs_attention'
        AND s.effect_state IN ('executing', 'ambiguous')
      FOR UPDATE OF r, s
    `;
    if (!row) throw new Error("workflow run is not awaiting resolution for that step");

    if (input.resolution.state === "succeeded") {
      const output = input.resolution.output ?? null;
      await tx`
        UPDATE workflows.step_outcome
        SET state = 'completed',
            outcome = ${{
              mode: "execute",
              outcome: { state: "completed", output },
            }},
            dependency = NULL,
            effect_state = 'succeeded',
            effect_output = ${output},
            finished_at = now(),
            updated_at = now()
        WHERE run_id = ${input.runId}::uuid AND step_key = ${input.stepKey}
      `;
      // Older alpha workers journaled propagated control wrappers as attention
      // outcomes. They are incomplete traversal state, not effects, so let the
      // resumed run recompute only those wrappers.
      await tx`
        DELETE FROM workflows.step_outcome
        WHERE run_id = ${input.runId}::uuid
          AND step_key <> ${input.stepKey}
          AND state = 'needs_attention'
          AND effect_key IS NULL
      `;
      await tx`
        UPDATE workflows.run
        SET state = 'queued',
            error = NULL,
            result = NULL,
            result_message = NULL,
            retry_after = NULL,
            consecutive_failures = 0,
            finished_at = NULL,
            updated_at = now()
        WHERE id = ${input.runId}::uuid
      `;
      return;
    }

    const error = {
      code: input.resolution.code ?? "WORKFLOW_EFFECT_CONFIRMED_FAILED",
      message: input.resolution.message,
      retryable: false,
    };
    await tx`
      UPDATE workflows.step_outcome
      SET state = 'failed',
          outcome = ${{ mode: "execute", outcome: { state: "failed", error } }},
          dependency = NULL,
          effect_state = 'failed',
          finished_at = now(),
          updated_at = now()
      WHERE run_id = ${input.runId}::uuid AND step_key = ${input.stepKey}
    `;
    await tx`
      UPDATE workflows.run
      SET state = 'failed', error = ${error}, finished_at = now(), updated_at = now()
      WHERE id = ${input.runId}::uuid
    `;
  });
};

/** What an earlier attempt recorded about this step's effect, if anything. */
export const readWorkflowEffect = async (
  step: { runId: string; key: string },
  options: { db?: SQL } = {},
): Promise<{ key: string; state: string; output: WorkflowJsonValue } | null> => {
  const db = options.db ?? sql;
  const [row] = await db<{ effect_key: string | null; effect_state: string | null; effect_output: WorkflowJsonValue }[]>`
    SELECT effect_key, effect_state, effect_output FROM workflows.step_outcome
    WHERE run_id = ${step.runId}::uuid AND step_key = ${step.key}
  `;
  return row?.effect_key && row.effect_state ? { key: row.effect_key, state: row.effect_state, output: row.effect_output } : null;
};

/**
 * Whether a replay may re-run this step's effect.
 *
 * An effect left `executing` or `ambiguous` by an earlier attempt escaped
 * without telling us whether it landed. Repeating it is how a workflow sends
 * the same message twice, so the answer is no and a human decides.
 */
export const isWorkflowEffectReplayable = async (step: { runId: string; key: string }, options: { db?: SQL } = {}): Promise<boolean> => {
  const db = options.db ?? sql;
  const [row] = await db<{ effect_state: string | null }[]>`
    SELECT effect_state FROM workflows.step_outcome WHERE run_id = ${step.runId}::uuid AND step_key = ${step.key}
  `;
  return row?.effect_state !== "executing" && row?.effect_state !== "ambiguous";
};
