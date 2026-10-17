/**
 * Every run starts from an event.
 *
 * There used to be three ways in, with three durability stories: a direct
 * invocation, a schedule tick, and a trigger delivery. Grids recorded only a
 * `channel` enum, so once a run existed nobody could say what caused it. Here
 * the cause is a row, so "why did this run" is a join rather than a guess, and
 * idempotency, retry and recovery are written once instead of three times.
 *
 * A schedule tick is an event. A button press is an event. An inbound message
 * is an event. Nothing needs its own registration path.
 */
import { Buffer } from "node:buffer";
import { type SQL, sql } from "bun";
import type { WorkflowJsonValue } from "../contracts";
import { createWorkflowRun } from "./runs";
import { withTransaction } from "./transaction";

/** UTF-8 bytes of serialized JSON, independently for data and context. */
export const WORKFLOW_EVENT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export class WorkflowEventTooLargeError extends Error {
  readonly code = "WORKFLOW_EVENT_TOO_LARGE";
  readonly limitBytes = WORKFLOW_EVENT_MAX_PAYLOAD_BYTES;

  constructor(
    readonly field: "data" | "context",
    readonly bytes: number,
  ) {
    super(`Workflow event ${field} is ${bytes} bytes; the limit is ${WORKFLOW_EVENT_MAX_PAYLOAD_BYTES} bytes (16 MiB).`);
    this.name = "WorkflowEventTooLargeError";
  }
}

export type WorkflowEventInput = {
  appId: string;
  scopeId: string;
  /** Namespaced `${appId}.${key}`, matching a declaration in the app's `workflows.ts`. */
  type: string;
  data?: Record<string, WorkflowJsonValue>;
  /**
   * Makes a repeatable source at-most-once: a schedule slot, a provider
   * redelivery, a double-clicked button. Emitting the same key twice records
   * one event and therefore starts one run.
   */
  dedupeKey?: string;
  /** The occurrence's own time, not the emitter's. Runs replay against this. */
  occurredAt?: Date;
  /**
   * Everything the plan reads under context.*, distinct from the payload.
   *
   * An app that already holds the facts a run needs — a captured row, the
   * launcher that was pressed — hands them over rather than making every step
   * read them again.
   */
  context?: Record<string, WorkflowJsonValue>;
  /**
   * Who the resulting runs act as.
   *
   * Without this every run would execute as the system: the activation's own
   * snapshot is the fallback, and it is only meaningful for occurrences that
   * have no human behind them, like a schedule tick.
   */
  authorization?: WorkflowJsonValue;
  /**
   * Restricts matching to one workflow's activations.
   *
   * For occurrences that concern exactly one workflow because the app already
   * decided — it evaluated its own trigger filter — and a broadcast would start
   * every workflow in the scope.
   */
  targetWorkflowId?: string;
};

export type WorkflowEmission = {
  eventId: string;
  /** Empty when nothing was listening, or when dispatch was deferred. */
  runIds: string[];
  /** True when this exact event had already been recorded. */
  duplicate: boolean;
};

type ActivationMatch = {
  activation_id: string;
  workflow_id: string;
  workflow_version_id: string;
  authorization_snapshot: WorkflowJsonValue;
};

type StoredEvent = {
  id: string;
  appId: string;
  scopeId: string;
  type: string;
  occurredAt: Date;
  data: Record<string, WorkflowJsonValue>;
  context: Record<string, WorkflowJsonValue>;
  authorization: WorkflowJsonValue;
  targetWorkflowId: string | null;
};

const EVENT_DISPATCH_MAX_ATTEMPTS = 8;
const EVENT_DISPATCH_BACKOFF_MS = 1_000;
const EVENT_DISPATCH_MAX_BACKOFF_MS = 5 * 60_000;

/** An empty object means the emitter named nobody; fall back to the activation. */
const isEmpty = (value: WorkflowJsonValue): boolean =>
  !value || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);

/** Freezes the exact live activations that matched when the event arrived. */
const pinDeliveries = async (tx: SQL, event: StoredEvent): Promise<number> => {
  const rows = await tx<{ activation_id: string }[]>`
    INSERT INTO workflows.event_delivery (
      event_id, activation_id, workflow_id, workflow_version_id, authorization_snapshot
    )
    SELECT ${event.id}::uuid, a.id, a.workflow_id, a.workflow_version_id, a.authorization_snapshot
    FROM workflows.activation AS a
    JOIN workflows.workflow AS w
      ON w.id = a.workflow_id
      AND w.active_version_id = a.workflow_version_id
    WHERE a.enabled
      AND a.event_type = ${event.type}
      AND w.app_id = ${event.appId}
      AND w.scope_id = ${event.scopeId}
      AND (${event.targetWorkflowId}::uuid IS NULL OR a.workflow_id = ${event.targetWorkflowId}::uuid)
    ORDER BY a.id
    ON CONFLICT DO NOTHING
    RETURNING activation_id
  `;
  return rows.length;
};

/**
 * Turns one event into runs.
 *
 * Runs are keyed by the event and the activation that matched it, so a
 * redelivered event or a retried dispatch converges on the same runs rather
 * than adding more.
 */
const materializeRuns = async (tx: SQL, event: StoredEvent): Promise<string[]> => {
  const matches = await tx<ActivationMatch[]>`
    SELECT activation_id, workflow_id, workflow_version_id, authorization_snapshot
    FROM workflows.event_delivery
    WHERE event_id = ${event.id}::uuid
    ORDER BY activation_id
  `;

  const runIds: string[] = [];
  for (const match of matches) {
    runIds.push(
      await createWorkflowRun(
        {
          appId: event.appId,
          scopeId: event.scopeId,
          workflowId: match.workflow_id,
          workflowVersionId: match.workflow_version_id,
          mode: "execute",
          inputs: event.data,
          context: event.context,
          // The emitter's actor wins; the activation's snapshot is what a
          // schedule tick or a captured row falls back to.
          authorization: isEmpty(event.authorization) ? match.authorization_snapshot : event.authorization,
          idempotencyKey: `event:${event.id}:${match.activation_id}`,
          occurredAt: event.occurredAt,
          eventId: event.id,
        },
        { db: tx },
      ),
    );
  }
  return runIds;
};

/**
 * Records an event and, unless deferred, starts the runs listening for it.
 *
 * `dispatch: "now"` is what a direct invocation uses: the caller gets run ids
 * back without a round trip through a queue, which is what the launcher and
 * "run this workflow" buttons depend on. Everything an app merely *observes* —
 * a row changing, a message arriving — defers, because losing the caller's
 * request is better than losing the occurrence: a failing dispatch would
 * otherwise roll back the event itself and the occurrence would vanish.
 */
export const emitWorkflowEvent = async (
  event: WorkflowEventInput,
  options: { dispatch?: "now" | "deferred"; db?: SQL } = {},
): Promise<WorkflowEmission> => {
  const occurredAt = event.occurredAt ?? new Date();
  const data = event.data ?? {};
  const context = event.context ?? {};
  const authorization = event.authorization ?? {};

  // Validate before even opening a savepoint: callers may catch this inside
  // their own transaction and continue writing domain state.
  for (const field of ["data", "context"] as const) {
    const bytes = Buffer.byteLength(JSON.stringify(field === "data" ? data : context), "utf8");
    if (bytes > WORKFLOW_EVENT_MAX_PAYLOAD_BYTES) throw new WorkflowEventTooLargeError(field, bytes);
  }

  return withTransaction(options.db, async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO workflows.event (
        app_id, scope_id, type, data, context, authorization_snapshot, target_workflow_id, dedupe_key, occurred_at
      )
      VALUES (
        ${event.appId}, ${event.scopeId}, ${event.type}, ${data}, ${context}, ${authorization},
        ${event.targetWorkflowId ?? null}::uuid, ${event.dedupeKey ?? null}, ${occurredAt}
      )
      ON CONFLICT (app_id, scope_id, type, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING id
    `;

    if (!inserted[0]) {
      // Already recorded. Answer with the runs it produced the first time
      // rather than starting more — that is the whole point of the key.
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM workflows.event
        WHERE app_id = ${event.appId}
          AND scope_id = ${event.scopeId}
          AND type = ${event.type}
          AND dedupe_key = ${event.dedupeKey ?? null}
      `;
      if (!existing) throw new Error("workflow event conflicted but could not be found");
      const runs = await tx<{ id: string }[]>`SELECT id FROM workflows.run WHERE event_id = ${existing.id}::uuid ORDER BY created_at, id`;
      return { eventId: existing.id, runIds: runs.map((row) => row.id), duplicate: true };
    }

    const eventId = inserted[0].id;
    const stored = {
      id: eventId,
      appId: event.appId,
      scopeId: event.scopeId,
      type: event.type,
      occurredAt,
      data,
      context,
      authorization,
      targetWorkflowId: event.targetWorkflowId ?? null,
    };
    const matchedCount = await pinDeliveries(tx, stored);
    await tx`
      UPDATE workflows.event
      SET matched_count = ${matchedCount},
          dispatched_at = CASE WHEN ${matchedCount} = 0 THEN now() ELSE dispatched_at END
      WHERE id = ${eventId}::uuid
    `;
    if (options.dispatch !== "now" || matchedCount === 0) return { eventId, runIds: [], duplicate: false };

    const runIds = await materializeRuns(tx, stored);
    await tx`
      UPDATE workflows.event
      SET dispatched_at = now(), attempts = attempts + 1, last_error = NULL
      WHERE id = ${eventId}::uuid
    `;
    return { eventId, runIds, duplicate: false };
  });
};

/**
 * Starts the runs for events that were recorded but not yet dispatched.
 *
 * One event at a time, each in its own transaction: an event whose activations
 * cannot be materialised must not take the rest of the batch down with it. Its
 * failure is recorded on the row instead, because an event that matched nothing
 * and said nothing is exactly how Grids' schedules stopped firing.
 */
export const dispatchPendingWorkflowEvents = async (
  limit = 100,
  options: { appId?: string; scopeId?: string; db?: SQL } = {},
): Promise<{ dispatched: number; failed: number; deadLettered: number }> => {
  const db = options.db ?? sql;
  const pending = await db<{ id: string }[]>`
    SELECT id FROM workflows.event
    WHERE dispatched_at IS NULL
      AND dispatch_failed_at IS NULL
      AND matched_count > 0
      AND dispatch_after <= now()
      AND (${options.appId ?? null}::text IS NULL OR app_id = ${options.appId ?? null})
      AND (${options.scopeId ?? null}::text IS NULL OR scope_id = ${options.scopeId ?? null})
    ORDER BY dispatch_after, occurred_at, id
    LIMIT ${limit}
  `;

  let dispatched = 0;
  let failed = 0;
  let deadLettered = 0;
  for (const { id } of pending) {
    try {
      await withTransaction(options.db, async (tx) => {
        const [row] = await tx<
          {
            id: string;
            app_id: string;
            scope_id: string;
            type: string;
            data: Record<string, WorkflowJsonValue>;
            context: Record<string, WorkflowJsonValue>;
            authorization_snapshot: WorkflowJsonValue;
            target_workflow_id: string | null;
            occurred_at: Date;
          }[]
        >`
          SELECT id, app_id, scope_id, type, data, context, authorization_snapshot, target_workflow_id, occurred_at
          FROM workflows.event
          WHERE id = ${id}::uuid
            AND dispatched_at IS NULL
            AND dispatch_failed_at IS NULL
            AND matched_count > 0
            AND dispatch_after <= now()
          FOR UPDATE SKIP LOCKED
        `;
        // Another worker took it, or it was dispatched between the scan and here.
        if (!row) return;

        await materializeRuns(tx, {
          id: row.id,
          appId: row.app_id,
          scopeId: row.scope_id,
          type: row.type,
          occurredAt: row.occurred_at,
          data: row.data,
          context: row.context,
          authorization: row.authorization_snapshot,
          targetWorkflowId: row.target_workflow_id,
        });
        await tx`
          UPDATE workflows.event
          SET dispatched_at = now(), attempts = attempts + 1, last_error = NULL
          WHERE id = ${row.id}::uuid
        `;
        dispatched += 1;
      });
    } catch (error) {
      failed += 1;
      const [recorded] = await db<{ dispatch_failed_at: Date | null }[]>`
        UPDATE workflows.event
        SET attempts = attempts + 1,
            last_error = ${error instanceof Error ? error.message : String(error)},
            dispatch_after = now() + (
              LEAST(
                ${EVENT_DISPATCH_MAX_BACKOFF_MS}::double precision,
                ${EVENT_DISPATCH_BACKOFF_MS}::double precision * power(2::double precision, attempts::double precision)
              ) * interval '1 millisecond'
            ),
            dispatch_failed_at = CASE
              WHEN attempts + 1 >= ${EVENT_DISPATCH_MAX_ATTEMPTS} THEN now()
              ELSE dispatch_failed_at
            END
        WHERE id = ${id}::uuid AND dispatched_at IS NULL
        RETURNING dispatch_failed_at
      `;
      if (recorded?.dispatch_failed_at) deadLettered += 1;
    }
  }
  return { dispatched, failed, deadLettered };
};

export type UndispatchedWorkflowEvent = {
  id: string;
  appId: string;
  scopeId: string;
  type: string;
  occurredAt: Date;
  attempts: number;
  matchedCount: number;
  lastError: string | null;
  dispatchFailedAt: Date | null;
};

/** Events that matched nothing, are retrying, or exhausted dispatch retries. */
export const listUndispatchedWorkflowEvents = async (
  options: { limit?: number; offset?: number; appId?: string; scopeId?: string; db?: SQL } = {},
): Promise<UndispatchedWorkflowEvent[]> => {
  const db = options.db ?? sql;
  const rows = await db<
    {
      id: string;
      app_id: string;
      scope_id: string;
      type: string;
      occurred_at: Date;
      attempts: number;
      matched_count: number;
      last_error: string | null;
      dispatch_failed_at: Date | null;
    }[]
  >`
    SELECT id, app_id, scope_id, type, occurred_at, attempts, matched_count, last_error, dispatch_failed_at
    FROM workflows.event
    WHERE (matched_count = 0 OR dispatched_at IS NULL)
      AND (${options.appId ?? null}::text IS NULL OR app_id = ${options.appId ?? null})
      AND (${options.scopeId ?? null}::text IS NULL OR scope_id = ${options.scopeId ?? null})
    ORDER BY occurred_at, id
    LIMIT ${options.limit ?? 100} OFFSET ${options.offset ?? 0}
  `;
  return rows.map((row) => ({
    id: row.id,
    appId: row.app_id,
    scopeId: row.scope_id,
    type: row.type,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    matchedCount: row.matched_count,
    lastError: row.last_error,
    dispatchFailedAt: row.dispatch_failed_at,
  }));
};
