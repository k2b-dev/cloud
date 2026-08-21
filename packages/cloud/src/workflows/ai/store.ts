import { type SQL, sql } from "bun";
import type { WorkflowJsonValue } from "../contracts";
import { wakeWorkflowRunsWaitingOn } from "../store/runs";
import {
  type WorkflowAiRequest,
  type WorkflowAiRequestInput,
  type WorkflowAiTask,
  type WorkflowAiTaskStatus,
  workflowAiRequestSchema,
} from "./types";

export const WORKFLOW_AI_DEPENDENCY_KIND = "ai.workflow-task";

type WorkflowAiTaskRow = {
  id: string;
  app_id: string;
  run_id: string;
  step_key: string;
  effect_key: string;
  kind: WorkflowAiRequest["kind"];
  request: unknown;
  input_hash: string;
  model_profile_id: string;
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
  stepKey: row.step_key,
  effectKey: row.effect_key,
  kind: row.kind,
  request: workflowAiRequestSchema.parse(json(row.request)) as WorkflowAiRequest,
  inputHash: row.input_hash,
  modelProfileId: row.model_profile_id,
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
  task.id::text,
  task.app_id,
  task.run_id::text,
  task.step_key,
  task.effect_key,
  task.kind,
  task.request,
  task.input_hash,
  task.model_profile_id,
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
    CREATE INDEX IF NOT EXISTS idx_ai_workflow_task_recovery
    ON ai.workflow_task(status, updated_at, id)
    WHERE status IN ('queued', 'running')
  `.simple();
};

const requestHash = (request: WorkflowAiRequest): string => new Bun.CryptoHasher("sha256").update(JSON.stringify(request)).digest("hex");

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
  input: { runId: string; stepKey: string; effectKey: string; request: WorkflowAiRequestInput; modelProfileId: string },
  db: SQL = sql,
): Promise<{ task: WorkflowAiTask; created: boolean }> => {
  const request = workflowAiRequestSchema.parse(input.request) as WorkflowAiRequest;
  const rows = await db<WorkflowAiTaskRow[]>`
    INSERT INTO ai.workflow_task (app_id, run_id, step_key, effect_key, kind, request, input_hash, model_profile_id)
    SELECT run.app_id, run.id, ${input.stepKey}, ${input.effectKey}, ${request.kind}, ${request}, ${requestHash(request)}, ${input.modelProfileId}
    FROM workflows.run AS run
    WHERE run.id = ${input.runId}::uuid
    ON CONFLICT (effect_key) DO NOTHING
    RETURNING ${db.unsafe(TASK_COLUMNS.replaceAll("task.", ""))}
  `;
  if (rows[0]) return { task: taskFromRow(rows[0]), created: true };
  const existing = await getWorkflowAiTaskByEffectKey(input.effectKey, db);
  if (!existing) throw new Error("Workflow AI task could not be created because its run is unavailable.");
  return { task: existing, created: false };
};

export const listRecoverableWorkflowAiTaskIds = async (db: SQL = sql): Promise<string[]> => {
  const rows = await db<{ id: string }[]>`
    SELECT id::text
    FROM ai.workflow_task
    WHERE status IN ('queued', 'running')
    ORDER BY updated_at, id
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
      AND task.status IN ('queued', 'running')
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
};

export const markWorkflowAiTaskCanceledIfRequested = async (id: string, db: SQL = sql): Promise<WorkflowAiTask | null> => {
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
  const task = rows[0] ? taskFromRow(rows[0]) : null;
  if (task) {
    await wakeWorkflowAiTask(task);
    return task;
  }
  return markWorkflowAiTaskCanceledIfRequested(id, db);
};
