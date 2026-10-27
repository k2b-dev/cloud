import { type SQL, sql } from "bun";
import { type AiResolvedModelRef, AiResolvedModelRefSchema } from "../../ai/model-contracts";
import { AI_TASK_REQUEST_MAX_BYTES, AiTaskInputTooLargeError, assertAiTaskRequestSize } from "../../ai/task-contracts";
import type { WorkflowJsonValue } from "../contracts";
import { wakeWorkflowRunsWaitingOn } from "../store/runs";
import { withTransaction } from "../store/transaction";
import { notifyWorkflowWorker } from "../store/worker-runtime";
import { WorkflowAiAdmissionError, type WorkflowAiScope, workflowAiHash } from "./policy";
import {
  type WorkflowAiRequest,
  type WorkflowAiRequestInput,
  type WorkflowAiTask,
  type WorkflowAiTaskStatus,
  workflowAiRequestSchema,
} from "./types";

export const WORKFLOW_AI_DEPENDENCY_KIND = "ai.workflow-task";

type WorkflowAiTaskRow = {
  usage_user_id: string | null;
  id: string;
  app_id: string;
  run_id: string;
  step_key: string;
  effect_key: string;
  kind: WorkflowAiRequest["kind"];
  request: unknown;
  input_hash: string;
  model_profile_id: string;
  model_ref: unknown;
  model_config_hash: string | null;
  status: WorkflowAiTaskStatus;
  output: unknown;
  usage: unknown;
  attempts: number | string;
  error_code: string | null;
  error_message: string | null;
  cancel_requested_at: Date | string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  updated_at: Date | string;
};

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const optionalIso = (value: Date | string | null): string | null => (value === null ? null : iso(value));
const json = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const taskFromRow = (row: WorkflowAiTaskRow): WorkflowAiTask => ({
  id: row.id,
  appId: row.app_id,
  runId: row.run_id,
  usageUserId: row.usage_user_id ?? undefined,
  stepKey: row.step_key,
  effectKey: row.effect_key,
  kind: row.kind,
  request: workflowAiRequestSchema.parse(json(row.request)) as WorkflowAiRequest,
  inputHash: row.input_hash,
  modelId: row.model_profile_id,
  modelRef: row.model_ref ? AiResolvedModelRefSchema.parse(row.model_ref) : undefined,
  modelConfigHash: row.model_config_hash ?? undefined,
  status: row.status,
  output: json(row.output) as WorkflowJsonValue | null,
  usage: json(row.usage) as WorkflowJsonValue | null,
  attempts: Number(row.attempts),
  errorCode: row.error_code,
  errorMessage: row.error_message,
  cancelRequestedAt: optionalIso(row.cancel_requested_at),
  createdAt: iso(row.created_at),
  startedAt: optionalIso(row.started_at),
  completedAt: optionalIso(row.completed_at),
  updatedAt: iso(row.updated_at),
});

const TASK_COLUMNS = `
  (SELECT u.id::text FROM workflows.run r JOIN auth.users u ON u.id::text = r.authorization_snapshot #>> '{actor,userId}' WHERE r.id = task.run_id) AS usage_user_id,
  task.id::text,
  task.app_id,
  task.run_id::text,
  task.step_key,
  task.effect_key,
  task.kind,
  task.request,
  task.input_hash,
  task.model_profile_id,
  task.model_ref,
  task.model_config_hash,
  task.status,
  task.output,
  task.usage,
  task.attempts,
  task.error_code,
  task.error_message,
  task.cancel_requested_at,
  task.created_at,
  task.started_at,
  task.completed_at,
  task.updated_at
`;

export const migrateWorkflowAi = async (db: SQL = sql): Promise<void> => {
  await db`CREATE SCHEMA IF NOT EXISTS ai`.simple();
  await db`
    CREATE TABLE IF NOT EXISTS ai.workflow_task (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id TEXT NOT NULL,
      run_id UUID NOT NULL REFERENCES workflows.run(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL CHECK (char_length(step_key) BETWEEN 1 AND 1000),
      effect_key TEXT NOT NULL UNIQUE CHECK (char_length(effect_key) BETWEEN 1 AND 500),
      kind TEXT NOT NULL CHECK (kind IN ('generate_text', 'classify', 'classify_many', 'extract_data')),
      request JSONB NOT NULL CHECK (jsonb_typeof(request) = 'object' AND octet_length(request::text) <= 100000),
      input_hash TEXT NOT NULL CHECK (char_length(input_hash) = 64),
      model_profile_id TEXT NOT NULL CHECK (char_length(model_profile_id) BETWEEN 1 AND 120),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
      output JSONB,
      usage JSONB,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      error_code TEXT,
      error_message TEXT CHECK (error_message IS NULL OR char_length(error_message) <= 2000),
      cancel_requested_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT ai_workflow_task_terminal_check CHECK (
        (status IN ('succeeded', 'failed', 'canceled')) = (completed_at IS NOT NULL)
      )
    )
  `.simple();
  await db`
    ALTER TABLE ai.workflow_task DROP CONSTRAINT IF EXISTS workflow_task_kind_check;
    ALTER TABLE ai.workflow_task ADD CONSTRAINT workflow_task_kind_check
      CHECK (kind IN ('generate_text', 'classify', 'classify_many', 'extract_data'))
  `.simple();
  await db`
    ALTER TABLE ai.workflow_task ADD COLUMN IF NOT EXISTS scope_id TEXT;
    ALTER TABLE ai.workflow_task ADD COLUMN IF NOT EXISTS source_id TEXT;
    ALTER TABLE ai.workflow_task ADD COLUMN IF NOT EXISTS cache_key TEXT;
    ALTER TABLE ai.workflow_task ADD COLUMN IF NOT EXISTS model_config_hash TEXT;
    ALTER TABLE ai.workflow_task ADD COLUMN IF NOT EXISTS model_ref JSONB;
    CREATE INDEX IF NOT EXISTS idx_ai_workflow_task_cache ON ai.workflow_task(app_id, scope_id, cache_key, completed_at DESC) WHERE status = 'succeeded';
    CREATE INDEX IF NOT EXISTS idx_ai_workflow_task_active_scope ON ai.workflow_task(app_id, scope_id) WHERE status IN ('queued', 'running');
    CREATE TABLE IF NOT EXISTS ai.workflow_scope_budget (
      app_id TEXT NOT NULL, scope_id TEXT NOT NULL, tokens DOUBLE PRECISION NOT NULL,
      refilled_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(app_id, scope_id)
    );
    CREATE TABLE IF NOT EXISTS ai.workflow_scope_admission (
      app_id TEXT NOT NULL, scope_id TEXT NOT NULL, source_id TEXT NOT NULL,
      task_id UUID NOT NULL PRIMARY KEY, logical_key TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_workflow_scope_admission ON ai.workflow_scope_admission(app_id, scope_id, created_at, source_id)
  `.simple();
  await db`
    CREATE INDEX IF NOT EXISTS idx_ai_workflow_task_recovery
    ON ai.workflow_task(status, updated_at, id)
    WHERE status IN ('queued', 'running')
  `.simple();
};

const requestHash = (request: WorkflowAiRequest): string => workflowAiHash(request);

export const getWorkflowAiTask = async (id: string, db: SQL = sql): Promise<WorkflowAiTask | null> => {
  const rows = await db<WorkflowAiTaskRow[]>`
    SELECT ${db.unsafe(TASK_COLUMNS)}
    FROM ai.workflow_task AS task
    WHERE task.id = ${id}::uuid
  `;
  return rows[0] ? taskFromRow(rows[0]) : null;
};

export const getWorkflowAiTaskByEffectKey = async (effectKey: string, db: SQL = sql): Promise<WorkflowAiTask | null> => {
  const rows = await db<WorkflowAiTaskRow[]>`
    SELECT ${db.unsafe(TASK_COLUMNS)}
    FROM ai.workflow_task AS task
    WHERE task.effect_key = ${effectKey}
  `;
  return rows[0] ? taskFromRow(rows[0]) : null;
};

export const workflowAiTaskExists = async (effectKey: string, db: SQL = sql): Promise<boolean> => {
  const [row] = await db<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM ai.workflow_task WHERE effect_key = ${effectKey}) AS exists
  `;
  return Boolean(row?.exists);
};

export const createWorkflowAiTask = async (
  input: {
    runId: string;
    stepKey: string;
    effectKey: string;
    request: WorkflowAiRequestInput;
    modelId: string;
    modelRef?: AiResolvedModelRef;
    modelConfigHash?: string;
    scope?: WorkflowAiScope;
  },
  db: SQL = sql,
): Promise<{ task: WorkflowAiTask; created: boolean }> => {
  assertAiTaskRequestSize(input.request);
  const request = workflowAiRequestSchema.parse(input.request) as WorkflowAiRequest;
  assertAiTaskRequestSize(request);
  // JSONB adds separator spaces and expands numeric exponents. Measure its exact
  // representation before INSERT, keeping the DB constraint as a final guard.
  const [size] = await db<{ bytes: number }[]>`SELECT octet_length(${request}::jsonb::text) AS bytes`;
  if (!size || size.bytes > AI_TASK_REQUEST_MAX_BYTES) throw new AiTaskInputTooLargeError();
  if (input.scope && !input.modelConfigHash) throw new Error("Scoped inference requires a resolved model configuration hash.");
  return withTransaction(db, async (db) => {
    // This short admission transaction serializes reservations across replicas.
    // It is never held during inference.
    if (input.scope) await db`SELECT pg_advisory_xact_lock(hashtextextended('workflow-ai-admission', 0))`;
    const existingTask = await getWorkflowAiTaskByEffectKey(input.effectKey, db);
    if (existingTask) return { task: existingTask, created: false };
    const [run] = await db<
      { app_id: string; scope_id: string }[]
    >`SELECT app_id, scope_id FROM workflows.run WHERE id = ${input.runId}::uuid AND cancel_requested_at IS NULL AND state <> 'canceled'`;
    if (!run) throw new Error("Workflow AI run is unavailable.");
    const cacheKey = input.scope
      ? workflowAiHash({ source: input.scope.sourceId, revision: input.scope.sourceRevision, request, model: input.modelConfigHash })
      : null;
    let cached: WorkflowAiTask | null = null;
    if (input.scope && !input.scope.recompute) {
      const [hit] = await db<{ id: string }[]>`
      SELECT id::text FROM ai.workflow_task
      WHERE app_id = ${run.app_id} AND scope_id = ${run.scope_id} AND cache_key = ${cacheKey} AND status = 'succeeded'
      ORDER BY completed_at DESC, id LIMIT 1
    `;
      if (hit) cached = await getWorkflowAiTask(hit.id, db);
    }
    if (input.scope && !cached) await reserveWorkflowAiBudget(db, run, input.scope);
    const rows = await db<WorkflowAiTaskRow[]>`
    INSERT INTO ai.workflow_task (app_id, run_id, step_key, effect_key, kind, request, input_hash, model_profile_id, model_ref, scope_id, source_id, cache_key, model_config_hash, status, output, completed_at)
    SELECT run.app_id, run.id, ${input.stepKey}, ${input.effectKey}, ${request.kind}, ${request}, ${requestHash(request)}, ${input.modelId}, ${input.modelRef ? JSON.stringify(AiResolvedModelRefSchema.parse(input.modelRef)) : null}::jsonb,
      ${run.scope_id}, ${input.scope?.sourceId ?? null}, ${cacheKey}, ${input.modelConfigHash ?? null},
      ${cached ? "succeeded" : "queued"}, ${cached?.output ?? null}, ${cached ? new Date() : null}
    FROM workflows.run AS run
    WHERE run.id = ${input.runId}::uuid
    ON CONFLICT (effect_key) DO NOTHING
    RETURNING ${db.unsafe(TASK_COLUMNS.replaceAll("task.", ""))}
  `;
    if (rows[0]) {
      if (input.scope && !cached)
        await db`INSERT INTO ai.workflow_scope_admission(app_id, scope_id, source_id, task_id, logical_key) VALUES (${run.app_id}, ${run.scope_id}, ${input.scope.sourceId}, ${rows[0].id}::uuid, ${input.scope.recompute ? rows[0].id : cacheKey})`;
      return { task: taskFromRow(rows[0]), created: true };
    }
    const existing = await getWorkflowAiTaskByEffectKey(input.effectKey, db);
    if (!existing) throw new Error("Workflow AI task could not be created because its run is unavailable.");
    return { task: existing, created: false };
  });
};

export const listRecoverableWorkflowAiTaskIds = async (db: SQL = sql): Promise<string[]> => {
  const rows = await db<{ id: string }[]>`
    SELECT id::text
    FROM ai.workflow_task
    WHERE status IN ('queued', 'running')
    ORDER BY updated_at, id
    LIMIT 100
  `;
  return rows.map((row) => row.id);
};

export const claimWorkflowAiTask = async (id: string, db: SQL = sql): Promise<WorkflowAiTask | null> => {
  const canceled = await markWorkflowAiTaskCanceledIfRequested(id, db);
  if (canceled) return canceled;
  const rows = await db<WorkflowAiTaskRow[]>`
    UPDATE ai.workflow_task AS task
    SET status = 'running',
        attempts = task.attempts + 1,
        started_at = COALESCE(task.started_at, now()),
        error_code = NULL,
        error_message = NULL,
        updated_at = now()
    FROM workflows.run AS run
    WHERE task.id = ${id}::uuid
      AND run.id = task.run_id
      AND run.cancel_requested_at IS NULL
      AND run.state <> 'canceled'
      AND task.status = 'queued'
    RETURNING ${db.unsafe(TASK_COLUMNS)}
  `;
  return rows[0] ? taskFromRow(rows[0]) : markWorkflowAiTaskCanceledIfRequested(id, db);
};

export const workflowAiTaskCancellationRequested = async (id: string, db: SQL = sql): Promise<boolean> => {
  const [row] = await db<{ canceled: boolean }[]>`
    SELECT run.cancel_requested_at IS NOT NULL OR run.state = 'canceled' AS canceled
    FROM ai.workflow_task AS task
    JOIN workflows.run AS run ON run.id = task.run_id
    WHERE task.id = ${id}::uuid
  `;
  return Boolean(row?.canceled);
};

export const wakeWorkflowAiTask = async (task: Pick<WorkflowAiTask, "appId" | "id">): Promise<void> => {
  await wakeWorkflowRunsWaitingOn({ appId: task.appId, kind: WORKFLOW_AI_DEPENDENCY_KIND, key: task.id });
  notifyWorkflowWorker(task.appId);
};

export const markWorkflowAiTaskCanceledIfRequested = async (id: string, db: SQL = sql): Promise<WorkflowAiTask | null> => {
  const rows = await withTransaction(db, async (db) => {
    const rows = await db<WorkflowAiTaskRow[]>`
    UPDATE ai.workflow_task AS task
    SET status = 'canceled',
        output = NULL,
        usage = NULL,
        error_code = 'WORKFLOW_AI_CANCELED',
        error_message = 'Workflow AI task was canceled.',
        cancel_requested_at = COALESCE(task.cancel_requested_at, now()),
        completed_at = now(),
        updated_at = now()
    FROM workflows.run AS run
    WHERE task.id = ${id}::uuid
      AND run.id = task.run_id
      AND (run.cancel_requested_at IS NOT NULL OR run.state = 'canceled')
      AND task.status IN ('queued', 'running')
    RETURNING ${db.unsafe(TASK_COLUMNS)}
  `;
    if (rows[0]) await db`UPDATE ai.workflow_scope_admission SET logical_key = NULL WHERE task_id = ${id}::uuid`;
    return rows;
  });
  const task = rows[0] ? taskFromRow(rows[0]) : null;
  if (task) await wakeWorkflowAiTask(task);
  return task;
};

export const requeueWorkflowAiTask = async (id: string, db: SQL = sql): Promise<void> => {
  await db`
    UPDATE ai.workflow_task
    SET status = 'queued', updated_at = now()
    WHERE id = ${id}::uuid AND status = 'running'
  `;
};

export const completeWorkflowAiTask = async (
  id: string,
  output: WorkflowJsonValue,
  usage: WorkflowJsonValue | null,
  db: SQL = sql,
): Promise<WorkflowAiTask | null> => {
  const rows = await db<WorkflowAiTaskRow[]>`
    UPDATE ai.workflow_task AS task
    SET status = 'succeeded', output = ${output}, usage = ${usage}, completed_at = now(), updated_at = now()
    FROM workflows.run AS run
    WHERE task.id = ${id}::uuid
      AND run.id = task.run_id
      AND run.cancel_requested_at IS NULL
      AND run.state <> 'canceled'
      AND task.status = 'running'
    RETURNING ${db.unsafe(TASK_COLUMNS)}
  `;
  const task = rows[0] ? taskFromRow(rows[0]) : null;
  if (task) {
    await wakeWorkflowAiTask(task);
    return task;
  }
  return markWorkflowAiTaskCanceledIfRequested(id, db);
};

export const failWorkflowAiTask = async (
  id: string,
  error: { code: string; message: string },
  db: SQL = sql,
): Promise<WorkflowAiTask | null> => {
  const rows = await withTransaction(db, async (db) => {
    const rows = await db<WorkflowAiTaskRow[]>`
    UPDATE ai.workflow_task AS task
    SET status = 'failed',
        output = NULL,
        usage = NULL,
        error_code = ${error.code},
        error_message = ${error.message.slice(0, 2_000)},
        completed_at = now(),
        updated_at = now()
    FROM workflows.run AS run
    WHERE task.id = ${id}::uuid
      AND run.id = task.run_id
      AND run.cancel_requested_at IS NULL
      AND run.state <> 'canceled'
      AND task.status IN ('queued', 'running')
    RETURNING ${db.unsafe(TASK_COLUMNS)}
  `;
    if (rows[0]) await db`UPDATE ai.workflow_scope_admission SET logical_key = NULL WHERE task_id = ${id}::uuid`;
    return rows;
  });
  const task = rows[0] ? taskFromRow(rows[0]) : null;
  if (task) {
    await wakeWorkflowAiTask(task);
    return task;
  }
  return markWorkflowAiTaskCanceledIfRequested(id, db);
};

/** DB liveness is separate from NATS heartbeat: lost/expired deliveries must settle. */
export const heartbeatWorkflowAiTask = async (id: string, db: SQL = sql): Promise<void> => {
  await db`UPDATE ai.workflow_task SET updated_at = now() WHERE id = ${id}::uuid AND status = 'running'`;
};

export const expireWorkflowAiTasks = async (queueTimeoutMs: number, db: SQL = sql): Promise<void> => {
  const rows = await withTransaction(db, async (db) => {
    const rows = await db<{ id: string; app_id: string }[]>`
    UPDATE ai.workflow_task AS task
    SET status = CASE WHEN run.cancel_requested_at IS NOT NULL OR run.state = 'canceled' THEN 'canceled' ELSE 'failed' END,
        completed_at = now(), updated_at = now(),
        error_code = CASE
          WHEN run.cancel_requested_at IS NOT NULL OR run.state = 'canceled' THEN 'WORKFLOW_AI_CANCELED'
          WHEN task.status = 'queued' THEN 'WORKFLOW_AI_QUEUE_TIMEOUT' ELSE 'WORKFLOW_AI_INTERRUPTED' END,
        error_message = CASE WHEN run.cancel_requested_at IS NOT NULL OR run.state = 'canceled' THEN 'Workflow AI task was canceled.'
          ELSE 'Workflow AI delivery expired or its worker stopped. Retry the workflow after checking capacity and provider health.' END
    FROM workflows.run AS run
    WHERE run.id = task.run_id AND task.id IN (
      SELECT id FROM ai.workflow_task
      WHERE (status = 'queued' AND updated_at < now() - ${queueTimeoutMs} * interval '1 millisecond')
         OR (status = 'running' AND updated_at < now() - interval '30 seconds')
      ORDER BY updated_at, id LIMIT 100 FOR UPDATE SKIP LOCKED
    )
    RETURNING task.id::text, task.app_id
  `;
    for (const row of rows) await db`UPDATE ai.workflow_scope_admission SET logical_key = NULL WHERE task_id = ${row.id}::uuid`;
    return rows;
  });
  for (const row of rows) await wakeWorkflowAiTask({ id: row.id, appId: row.app_id });
  // A crash between terminal persistence and the wake must also be repaired.
  const waiting = await db<{ id: string; app_id: string }[]>`
    SELECT task.id::text, task.app_id
    FROM workflows.step_outcome step
    JOIN workflows.run run ON run.id = step.run_id
    JOIN ai.workflow_task task ON task.id = CASE
      WHEN step.dependency ->> 'kind' = 'ai.workflow-task' THEN (step.dependency ->> 'key')::uuid END
      AND task.run_id = run.id
    WHERE step.state = 'waiting' AND run.state = 'waiting'
      AND step.dependency ->> 'kind' = 'ai.workflow-task'
      AND task.status IN ('succeeded', 'failed', 'canceled')
    ORDER BY step.run_id, step.step_key LIMIT 100
  `;
  for (const row of waiting) await wakeWorkflowAiTask({ id: row.id, appId: row.app_id });
  await db`DELETE FROM ai.workflow_scope_admission WHERE task_id IN (
    SELECT task_id FROM ai.workflow_scope_admission WHERE created_at <= now() - interval '24 hours' ORDER BY created_at LIMIT 100
  )`;
};

const reserveWorkflowAiBudget = async (db: SQL, run: { app_id: string; scope_id: string }, scope: WorkflowAiScope): Promise<void> => {
  const budget = scope.budget;
  for (const value of Object.values(budget)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid workflow AI budget.");
  await db`DELETE FROM ai.workflow_scope_admission WHERE app_id = ${run.app_id} AND scope_id = ${run.scope_id} AND created_at <= now() - interval '24 hours'`;
  const [counts] = await db<{ source_steps: number; sources: number; seen_source: boolean }[]>`
    SELECT count(DISTINCT logical_key) FILTER (WHERE source_id = ${scope.sourceId})::int AS source_steps,
      count(DISTINCT source_id)::int AS sources, bool_or(source_id = ${scope.sourceId}) AS seen_source
    FROM ai.workflow_scope_admission WHERE app_id = ${run.app_id} AND scope_id = ${run.scope_id}
  `;
  if (counts && counts.source_steps >= budget.maxStepsPerSource) throw new WorkflowAiAdmissionError("WORKFLOW_AI_SOURCE_BUDGET");
  if (counts && !counts.seen_source && counts.sources >= budget.sourcesPer24Hours)
    throw new WorkflowAiAdmissionError("WORKFLOW_AI_DAILY_BUDGET");
  const [active] = await db<{ scope: number; global: number }[]>`
    SELECT count(*) FILTER (WHERE app_id = ${run.app_id} AND scope_id = ${run.scope_id})::int AS scope, count(*)::int AS global
    FROM ai.workflow_task WHERE status IN ('queued', 'running') AND cache_key IS NOT NULL
  `;
  if (active && (active.scope >= budget.scopeConcurrent || active.global >= budget.globalConcurrent))
    throw new WorkflowAiAdmissionError("WORKFLOW_AI_CAPACITY");
  await db`INSERT INTO ai.workflow_scope_budget(app_id, scope_id, tokens) VALUES (${run.app_id}, ${run.scope_id}, ${budget.burst}) ON CONFLICT DO NOTHING`;
  const [bucket] = await db<{ available: number }[]>`
    SELECT least(${budget.burst}::double precision, tokens + extract(epoch FROM now() - refilled_at) * ${budget.tasksPerMinute} / 60) AS available
    FROM ai.workflow_scope_budget WHERE app_id = ${run.app_id} AND scope_id = ${run.scope_id} FOR UPDATE
  `;
  if (!bucket || bucket.available < 1) throw new WorkflowAiAdmissionError("WORKFLOW_AI_RATE_LIMIT");
  await db`UPDATE ai.workflow_scope_budget SET tokens = ${bucket.available - 1}, refilled_at = now() WHERE app_id = ${run.app_id} AND scope_id = ${run.scope_id}`;
};
