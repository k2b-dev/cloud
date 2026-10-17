/**
 * Reading runs, for operators.
 *
 * Once the kernel owns runs, "is any workflow broken right now" is one query
 * across every app rather than an aggregation protocol between them. The
 * previous arrangement needed a per-app health port purely because storage was
 * split; there is nothing left for that port to do.
 *
 * The four findings below are the ones that stayed invisible: an effect that
 * escaped and was never settled, a run waiting on a human, an event that
 * matched nothing and said nothing, and a run that started long after the
 * occurrence that caused it.
 */
import { type SQL, sql } from "bun";
import type { WorkflowInvocationMode, WorkflowJsonValue, WorkflowRunState } from "../contracts";
import type { WorkflowEffectBudget } from "./budget";

export type WorkflowRunSummary = {
  id: string;
  appId: string;
  scopeId: string;
  workflowId: string;
  workflowName: string;
  revision: number;
  mode: WorkflowInvocationMode;
  state: WorkflowRunState;
  attempt: number;
  eventType: string | null;
  parentRunId: string | null;
  occurredAt: Date;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Milliseconds between the occurrence and the run starting. The drift an operator hunts. */
  startLagMs: number | null;
  durationMs: number | null;
  error: WorkflowJsonValue | null;
  /** What the run said about itself, distinct from what it produced. */
  resultMessage: string | null;
};

export type WorkflowRunFilter = {
  appId?: string;
  scopeId?: string;
  workflowId?: string;
  /** Restrict the list to the direct children of one fan-out parent. */
  parentRunId?: string;
  state?: WorkflowRunState;
  mode?: WorkflowInvocationMode;
  /** Children are noise in a list view until you are looking at their parent. */
  includeChildren?: boolean;
  since?: Date;
  limit?: number;
  offset?: number;
};

type RunRow = {
  id: string;
  app_id: string;
  scope_id: string;
  workflow_id: string;
  workflow_name: string;
  revision: number;
  mode: WorkflowInvocationMode;
  state: WorkflowRunState;
  attempt: number;
  event_type: string | null;
  parent_run_id: string | null;
  occurred_at: Date;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: WorkflowJsonValue | null;
  result_message: string | null;
};

const millisBetween = (from: Date | null, to: Date | null): number | null =>
  from && to ? Math.max(0, to.getTime() - from.getTime()) : null;

const toSummary = (row: RunRow): WorkflowRunSummary => ({
  id: row.id,
  appId: row.app_id,
  scopeId: row.scope_id,
  workflowId: row.workflow_id,
  workflowName: row.workflow_name,
  revision: row.revision,
  mode: row.mode,
  state: row.state,
  attempt: row.attempt,
  eventType: row.event_type,
  parentRunId: row.parent_run_id,
  occurredAt: row.occurred_at,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  startLagMs: millisBetween(row.occurred_at, row.started_at),
  durationMs: millisBetween(row.started_at, row.finished_at),
  error: row.error,
  resultMessage: row.result_message,
});

const RUN_SELECT = `
  r.id, r.app_id, r.scope_id, r.workflow_id, w.name AS workflow_name, v.revision,
  r.mode, r.state, r.attempt, e.type AS event_type, r.parent_run_id,
  r.occurred_at, r.created_at, r.started_at, r.finished_at, r.error, r.result_message
`;

const RUN_FROM = `
  FROM workflows.run AS r
  JOIN workflows.workflow AS w ON w.id = r.workflow_id
  JOIN workflows.version AS v ON v.id = r.workflow_version_id
  LEFT JOIN workflows.event AS e ON e.id = r.event_id
`;

export const listWorkflowRuns = async (filter: WorkflowRunFilter = {}, options: { db?: SQL } = {}): Promise<WorkflowRunSummary[]> => {
  const db = options.db ?? sql;
  const rows = await db<RunRow[]>`
    SELECT ${db.unsafe(RUN_SELECT)} ${db.unsafe(RUN_FROM)}
    WHERE (${filter.appId ?? null}::text IS NULL OR r.app_id = ${filter.appId ?? null})
      AND (${filter.scopeId ?? null}::text IS NULL OR r.scope_id = ${filter.scopeId ?? null})
      AND (${filter.workflowId ?? null}::uuid IS NULL OR r.workflow_id = ${filter.workflowId ?? null}::uuid)
      AND (${filter.parentRunId ?? null}::uuid IS NULL OR r.parent_run_id = ${filter.parentRunId ?? null}::uuid)
      AND (${filter.state ?? null}::text IS NULL OR r.state = ${filter.state ?? null})
      AND (${filter.mode ?? null}::text IS NULL OR r.mode = ${filter.mode ?? null})
      AND (${filter.parentRunId !== undefined || filter.includeChildren === true} OR r.parent_run_id IS NULL)
      AND (${filter.since ?? null}::timestamptz IS NULL OR r.created_at >= ${filter.since ?? null}::timestamptz)
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${filter.limit ?? 50} OFFSET ${filter.offset ?? 0}
  `;
  return rows.map(toSummary);
};

export type WorkflowFamilySummary = {
  workflowId: string;
  appId: string;
  scopeId: string;
  workflowName: string;
  eventTypes: string[];
  latestRunId: string;
  latestRevision: number;
  latestState: WorkflowRunState;
  latestRunAt: Date;
  runs: number;
  failed: number;
  active: number;
  needsAttention: number;
  avgDurationMs: number | null;
  p99DurationMs: number | null;
  oldestQueuedAt: Date | null;
};

export type WorkflowFamilyFilter = Pick<WorkflowRunFilter, "appId" | "workflowId" | "state" | "mode" | "since" | "limit" | "offset">;

type WorkflowFamilyRow = {
  workflow_id: string;
  app_id: string;
  scope_id: string;
  workflow_name: string;
  event_types: string[];
  latest_run_id: string;
  latest_revision: number;
  latest_state: WorkflowRunState;
  latest_run_at: Date;
  runs: number | string;
  failed: number | string;
  active: number | string;
  needs_attention: number | string;
  avg_duration_ms: number | string | null;
  p99_duration_ms: number | string | null;
  oldest_queued_at: Date | null;
};

const numberOrNull = (value: number | string | null): number | null => (value === null ? null : Number(value));

/**
 * One row per workflow definition, analogous to the job-family overview.
 *
 * The filter is applied before aggregation, so every number describes the
 * selected URL scope. Individual runs remain a separate drill-down.
 */
export const listWorkflowFamilies = async (
  filter: WorkflowFamilyFilter = {},
  options: { db?: SQL } = {},
): Promise<WorkflowFamilySummary[]> => {
  const db = options.db ?? sql;
  const rows = await db<WorkflowFamilyRow[]>`
    WITH filtered AS (
      SELECT
        r.id, r.app_id, r.scope_id, r.workflow_id, w.name AS workflow_name,
        v.revision, r.state, r.created_at, r.started_at, r.finished_at,
        e.type AS event_type,
        EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000 AS duration_ms
      ${db.unsafe(RUN_FROM)}
      WHERE (${filter.appId ?? null}::text IS NULL OR r.app_id = ${filter.appId ?? null})
        AND (${filter.workflowId ?? null}::uuid IS NULL OR r.workflow_id = ${filter.workflowId ?? null}::uuid)
        AND (${filter.state ?? null}::text IS NULL OR r.state = ${filter.state ?? null})
        AND (${filter.mode ?? null}::text IS NULL OR r.mode = ${filter.mode ?? null})
        AND r.parent_run_id IS NULL
        AND (${filter.since ?? null}::timestamptz IS NULL OR r.created_at >= ${filter.since ?? null}::timestamptz)
    ),
    latest AS (
      SELECT DISTINCT ON (workflow_id)
        workflow_id, id AS latest_run_id, revision AS latest_revision,
        state AS latest_state, created_at AS latest_run_at
      FROM filtered
      ORDER BY workflow_id, created_at DESC, id DESC
    ),
    families AS (
      SELECT
        workflow_id, app_id, scope_id, workflow_name,
        COALESCE(array_agg(DISTINCT event_type) FILTER (WHERE event_type IS NOT NULL), ARRAY[]::text[]) AS event_types,
        COUNT(*)::int AS runs,
        COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE state IN ('queued', 'running', 'waiting'))::int AS active,
        COUNT(*) FILTER (WHERE state = 'needs_attention')::int AS needs_attention,
        AVG(duration_ms)::float AS avg_duration_ms,
        (percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)
          FILTER (WHERE duration_ms IS NOT NULL))::float AS p99_duration_ms,
        MIN(created_at) FILTER (WHERE state = 'queued') AS oldest_queued_at
      FROM filtered
      GROUP BY workflow_id, app_id, scope_id, workflow_name
    )
    SELECT families.*, latest.latest_run_id, latest.latest_revision, latest.latest_state, latest.latest_run_at
    FROM families
    JOIN latest USING (workflow_id)
    ORDER BY
      CASE latest.latest_state
        WHEN 'needs_attention' THEN 0
        WHEN 'failed' THEN 1
        WHEN 'running' THEN 2
        WHEN 'waiting' THEN 2
        WHEN 'queued' THEN 2
        ELSE 3
      END,
      latest.latest_run_at DESC,
      families.workflow_name,
      families.workflow_id
    LIMIT ${filter.limit ?? 50} OFFSET ${filter.offset ?? 0}
  `;

  return rows.map((row) => ({
    workflowId: row.workflow_id,
    appId: row.app_id,
    scopeId: row.scope_id,
    workflowName: row.workflow_name,
    eventTypes: [...row.event_types].sort(),
    latestRunId: row.latest_run_id,
    latestRevision: row.latest_revision,
    latestState: row.latest_state,
    latestRunAt: row.latest_run_at,
    runs: Number(row.runs),
    failed: Number(row.failed),
    active: Number(row.active),
    needsAttention: Number(row.needs_attention),
    avgDurationMs: numberOrNull(row.avg_duration_ms),
    p99DurationMs: numberOrNull(row.p99_duration_ms),
    oldestQueuedAt: row.oldest_queued_at,
  }));
};

export type WorkflowRunTimeline = {
  runs: WorkflowRunSummary[];
  total: number;
};

/**
 * A bounded set of individual runs for charts, plus the uncapped total so the
 * UI can say when the chart is a sample rather than the complete window.
 */
export const listWorkflowRunTimeline = async (
  filter: Omit<WorkflowRunFilter, "limit" | "offset"> = {},
  options: { db?: SQL; limit?: number } = {},
): Promise<WorkflowRunTimeline> => {
  const db = options.db ?? sql;
  const limit = Math.min(5_000, Math.max(1, Math.trunc(options.limit ?? 2_000)));
  const [runs, countRows] = await Promise.all([
    listWorkflowRuns({ ...filter, limit, offset: 0 }, { db }),
    db<{ count: number | string }[]>`
      SELECT COUNT(*)::int AS count FROM workflows.run AS r
      WHERE (${filter.appId ?? null}::text IS NULL OR r.app_id = ${filter.appId ?? null})
        AND (${filter.scopeId ?? null}::text IS NULL OR r.scope_id = ${filter.scopeId ?? null})
        AND (${filter.workflowId ?? null}::uuid IS NULL OR r.workflow_id = ${filter.workflowId ?? null}::uuid)
        AND (${filter.parentRunId ?? null}::uuid IS NULL OR r.parent_run_id = ${filter.parentRunId ?? null}::uuid)
        AND (${filter.state ?? null}::text IS NULL OR r.state = ${filter.state ?? null})
        AND (${filter.mode ?? null}::text IS NULL OR r.mode = ${filter.mode ?? null})
        AND (${filter.parentRunId !== undefined || filter.includeChildren === true} OR r.parent_run_id IS NULL)
        AND (${filter.since ?? null}::timestamptz IS NULL OR r.created_at >= ${filter.since ?? null}::timestamptz)
    `,
  ]);
  return { runs, total: Number(countRows[0]?.count ?? 0) };
};

export type WorkflowStepSummary = {
  stepKey: string;
  /** Where the step sits in the written source, so a view can point at it. */
  sourcePath: WorkflowJsonValue;
  /** Which iteration of an enclosing loop this was. Empty outside one. */
  iterationPath: WorkflowJsonValue;
  kind: string;
  action: string | null;
  state: string;
  attempt: number;
  /** What the step reported — the output a later step referenced, or why it stopped. */
  outcome: WorkflowJsonValue | null;
  effectKey: string | null;
  effectState: string | null;
  effectStartedAt: Date | null;
  dependency: WorkflowJsonValue | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
};

/** One step's row, shaped for a run view. Shared by the detail read and the live one. */
type StepRow = {
  step_key: string;
  source_path: WorkflowJsonValue;
  iteration_path: WorkflowJsonValue;
  kind: string;
  action: string | null;
  state: string;
  attempt: number;
  outcome: WorkflowJsonValue | null;
  effect_key: string | null;
  effect_state: string | null;
  effect_started_at: Date | null;
  dependency: WorkflowJsonValue | null;
  started_at: Date;
  finished_at: Date | null;
};

const STEP_SELECT = `
  step_key, source_path, iteration_path, kind, action, state, attempt, outcome,
  effect_key, effect_state, effect_started_at, dependency, started_at, finished_at
`;

const toStepSummary = (step: StepRow): WorkflowStepSummary => ({
  stepKey: step.step_key,
  sourcePath: step.source_path,
  iterationPath: step.iteration_path,
  kind: step.kind,
  action: step.action,
  state: step.state,
  attempt: step.attempt,
  outcome: step.outcome,
  effectKey: step.effect_key,
  effectState: step.effect_state,
  effectStartedAt: step.effect_started_at,
  dependency: step.dependency,
  startedAt: step.started_at,
  finishedAt: step.finished_at,
  durationMs: millisBetween(step.started_at, step.finished_at),
});

/**
 * The steps of one run, or just the ones named.
 *
 * Naming them is what a live update needs: a step finished, and the stream
 * carries that step rather than re-reading a plan that may have thousands.
 */
export const listWorkflowRunSteps = async (
  runId: string,
  options: { stepKeys?: readonly string[]; db?: SQL } = {},
): Promise<WorkflowStepSummary[]> => {
  const db = options.db ?? sql;
  const keys = options.stepKeys;
  if (keys && keys.length === 0) return [];
  const rows = keys
    ? await db<StepRow[]>`
        SELECT ${db.unsafe(STEP_SELECT)} FROM workflows.step_outcome
        WHERE run_id = ${runId}::uuid AND step_key IN ${db(keys)}
        ORDER BY started_at, step_key
      `
    : await db<StepRow[]>`
        SELECT ${db.unsafe(STEP_SELECT)} FROM workflows.step_outcome
        WHERE run_id = ${runId}::uuid
        ORDER BY started_at, step_key
      `;
  return rows.map(toStepSummary);
};

export type WorkflowRunDetail = WorkflowRunSummary & {
  inputs: Record<string, WorkflowJsonValue>;
  result: WorkflowJsonValue | null;
  effectsUsed: WorkflowEffectBudget;
  effectBudget: WorkflowEffectBudget;
  source: string;
  eventId: string | null;
  eventData: Record<string, WorkflowJsonValue> | null;
  eventPayloadExpired: boolean;
  steps: WorkflowStepSummary[];
  children: Record<WorkflowRunState, number>;
};

const EMPTY_CHILD_COUNTS: Record<WorkflowRunState, number> = {
  queued: 0,
  running: 0,
  waiting: 0,
  succeeded: 0,
  failed: 0,
  canceled: 0,
  needs_attention: 0,
};

export const getWorkflowRun = async (runId: string, options: { db?: SQL } = {}): Promise<WorkflowRunDetail | null> => {
  const db = options.db ?? sql;
  const [row] = await db<
    (RunRow & {
      inputs: Record<string, WorkflowJsonValue>;
      result: WorkflowJsonValue | null;
      effects_used: WorkflowEffectBudget;
      effect_budget: WorkflowEffectBudget;
      source: string;
      event_id: string | null;
      event_data: Record<string, WorkflowJsonValue> | null;
      event_payload_expired: boolean;
    })[]
  >`
    SELECT ${db.unsafe(RUN_SELECT)},
           r.inputs, r.result, r.effects_used, v.effect_budget, v.source, r.event_id,
           CASE WHEN e.payload_expired_at IS NULL THEN e.data END AS event_data,
           (e.payload_expired_at IS NOT NULL) AS event_payload_expired
    ${db.unsafe(RUN_FROM)}
    WHERE r.id = ${runId}::uuid
  `;
  if (!row) return null;

  const steps = await listWorkflowRunSteps(runId, { db });

  const childCounts = await db<{ state: WorkflowRunState; count: string }[]>`
    SELECT state, count(*) AS count FROM workflows.run WHERE parent_run_id = ${runId}::uuid GROUP BY state
  `;
  const children = { ...EMPTY_CHILD_COUNTS };
  for (const child of childCounts) children[child.state] = Number(child.count);

  return {
    ...toSummary(row),
    inputs: row.inputs,
    result: row.result,
    effectsUsed: row.effects_used,
    effectBudget: row.effect_budget,
    source: row.source,
    eventId: row.event_id,
    eventData: row.event_data,
    eventPayloadExpired: row.event_payload_expired,
    children,
    steps,
  };
};

export type StrandedWorkflowEffect = {
  runId: string;
  appId: string;
  workflowName: string;
  stepKey: string;
  action: string | null;
  effectKey: string;
  effectState: string;
  effectStartedAt: Date;
  ageMs: number;
};

/**
 * Effects that left the process and never reported back.
 *
 * These are the ones a replay refuses to repeat, so each is a message that may
 * or may not have gone out and a run that cannot proceed on its own. Nothing
 * surfaced them before.
 */
export const listStrandedWorkflowEffects = async (
  options: { appId?: string; olderThanMs?: number; limit?: number; offset?: number; db?: SQL } = {},
): Promise<StrandedWorkflowEffect[]> => {
  const db = options.db ?? sql;
  const rows = await db<
    {
      run_id: string;
      app_id: string;
      workflow_name: string;
      step_key: string;
      action: string | null;
      effect_key: string;
      effect_state: string;
      effect_started_at: Date;
    }[]
  >`
    SELECT s.run_id, r.app_id, w.name AS workflow_name, s.step_key, s.action, s.effect_key, s.effect_state, s.effect_started_at
    FROM workflows.step_outcome AS s
    JOIN workflows.run AS r ON r.id = s.run_id
    JOIN workflows.workflow AS w ON w.id = r.workflow_id
    WHERE s.effect_state IN ('executing', 'ambiguous')
      AND s.effect_started_at < now() - ${`${options.olderThanMs ?? 0} milliseconds`}::interval
      AND (${options.appId ?? null}::text IS NULL OR r.app_id = ${options.appId ?? null})
    ORDER BY s.effect_started_at, s.run_id
    LIMIT ${options.limit ?? 100} OFFSET ${options.offset ?? 0}
  `;
  const now = Date.now();
  return rows.map((row) => ({
    runId: row.run_id,
    appId: row.app_id,
    workflowName: row.workflow_name,
    stepKey: row.step_key,
    action: row.action,
    effectKey: row.effect_key,
    effectState: row.effect_state,
    effectStartedAt: row.effect_started_at,
    ageMs: Math.max(0, now - row.effect_started_at.getTime()),
  }));
};

export type WorkflowAppHealth = {
  appId: string;
  runs: Record<WorkflowRunState, number>;
  /** Effects that escaped and never settled — each one a possible duplicate. */
  strandedEffects: number;
  /** Events that matched nothing or could not be dispatched. */
  undispatchedEvents: number;
  /** How far behind the oldest undispatched event is, in milliseconds. */
  oldestUndispatchedMs: number | null;
  /** Worst gap between an occurrence and the run for it actually starting. */
  worstStartLagMs: number | null;
  /** How long the oldest run that never started has been queued. */
  oldestQueuedMs: number | null;
};

/**
 * One row per app, answering "is anything broken right now".
 *
 * Deliberately a single query per concern rather than a per-app port: the
 * point of moving storage into the kernel is that this stops being a protocol.
 */
export const workflowHealth = async (options: { since?: Date; db?: SQL } = {}): Promise<WorkflowAppHealth[]> => {
  const db = options.db ?? sql;
  const since = options.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [runs, stranded, events] = await Promise.all([
    db<
      {
        app_id: string;
        state: WorkflowRunState;
        count: string;
        worst_lag_ms: number | null;
        oldest_queued_ms: number | null;
      }[]
    >`
      SELECT app_id, state, count(*) AS count,
             max(EXTRACT(EPOCH FROM (started_at - occurred_at)) * 1000)::bigint AS worst_lag_ms,
             (max(EXTRACT(EPOCH FROM (now() - created_at)) * 1000)
               FILTER (WHERE state = 'queued'))::bigint AS oldest_queued_ms
      FROM workflows.run WHERE created_at >= ${since} GROUP BY app_id, state
    `,
    db<{ app_id: string; count: string }[]>`
      SELECT r.app_id, count(*) AS count FROM workflows.step_outcome AS s
      JOIN workflows.run AS r ON r.id = s.run_id
      WHERE s.effect_state IN ('executing', 'ambiguous') GROUP BY r.app_id
    `,
    db<{ app_id: string; count: string; oldest: Date }[]>`
      SELECT app_id, count(*) AS count, min(occurred_at) AS oldest
      FROM workflows.event
      WHERE matched_count = 0 OR dispatched_at IS NULL
      GROUP BY app_id
    `,
  ]);

  const byApp = new Map<string, WorkflowAppHealth>();
  const health = (appId: string): WorkflowAppHealth => {
    let entry = byApp.get(appId);
    if (!entry) {
      entry = {
        appId,
        runs: { ...EMPTY_CHILD_COUNTS },
        strandedEffects: 0,
        undispatchedEvents: 0,
        oldestUndispatchedMs: null,
        worstStartLagMs: null,
        oldestQueuedMs: null,
      };
      byApp.set(appId, entry);
    }
    return entry;
  };

  const now = Date.now();
  for (const row of runs) {
    const entry = health(row.app_id);
    entry.runs[row.state] = Number(row.count);
    const lag = row.worst_lag_ms === null ? null : Number(row.worst_lag_ms);
    if (lag !== null) entry.worstStartLagMs = Math.max(entry.worstStartLagMs ?? 0, lag);
    const queued = row.oldest_queued_ms === null ? null : Number(row.oldest_queued_ms);
    if (queued !== null) entry.oldestQueuedMs = Math.max(entry.oldestQueuedMs ?? 0, queued);
  }
  for (const row of stranded) health(row.app_id).strandedEffects = Number(row.count);
  for (const row of events) {
    const entry = health(row.app_id);
    entry.undispatchedEvents = Number(row.count);
    entry.oldestUndispatchedMs = Math.max(0, now - row.oldest.getTime());
  }

  return [...byApp.values()].sort((left, right) => left.appId.localeCompare(right.appId));
};
