/**
 * Grids' view of a run the kernel owns.
 *
 * The run itself lives in `workflows.run` and its journal in
 * `workflows.step_outcome`: leases, generations, recovery and the effect
 * journal are the kernel's, and Grids had all of it a second time. What stays
 * here is what the kernel has no opinion about — which base a run belongs to,
 * which button started it, and who it acted as — in `grids.workflow_run_profile`.
 *
 * Everything above this file still speaks `GridsWorkflowRun`. That is
 * deliberate: the shape is Grids' surface, the two tables underneath are
 * storage, and moving the storage should not have reached the run list, the
 * CLI, or a browser.
 */

import { err, fail, ok, type Result } from "@k2b/stdlib";
import { toPgUuidArray } from "@valentinkolb/cloud/services";
import type { WorkflowInvocationMode, WorkflowInvocationReceipt, WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import {
  createWorkflowRun,
  emitWorkflowEvent,
  getWorkflowRun as getKernelRun,
  listWorkflowRunSteps,
  requestWorkflowRunCancel,
  type WorkflowStepSummary,
} from "@valentinkolb/cloud/workflows/store";
import { sql } from "bun";
import type {
  GridsWorkflowChannel,
  GridsWorkflowLauncherKind,
  GridsWorkflowPrincipal,
  GridsWorkflowRun,
  GridsWorkflowRunStats,
  GridsWorkflowRunStatsWindow,
  GridsWorkflowStepRun,
} from "../workflows/contracts";
import { toWorkflowRevision } from "../workflows/contracts";
import type { SqlClient } from "./audit";
import { logAudit } from "./audit";
import { parseJsonbRow } from "./jsonb";
import { insertWithShortIdForDb } from "./short-id";
import { workflowConflict } from "./workflow-errors";
import { workflowServiceText } from "./workflow-service-messages";

/** The kernel partitions by app and scope; for Grids a scope is a base. */
export const GRIDS_APP_ID = "grids";

type DbRow = Record<string, unknown>;
type RunCursor = { createdAt: string; id: string };

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_DETAIL_STEPS = 500;
const DEFAULT_STATS_WINDOW: GridsWorkflowRunStatsWindow = "24h";
const STATS_WINDOW_SECONDS: Record<GridsWorkflowRunStatsWindow, number> = {
  "10m": 10 * 60,
  "1h": 60 * 60,
  "12h": 12 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

const toIsoString = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

const parseCursor = (cursor: string | null | undefined): RunCursor | null => {
  if (!cursor) return null;
  const [createdAt, id, ...rest] = cursor.split("|");
  if (!createdAt || !id || rest.length > 0 || !Number.isFinite(Date.parse(createdAt))) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  return { createdAt, id };
};

const pageSize = (limit: number | null | undefined): number => Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

// ─── Authorization snapshot ──────────────────────────────────────────────────

/** How a run was accepted: directly or by a published Grids App action. */
export type GridsWorkflowAuthorization =
  | { kind: "workflow" }
  | {
      kind: "custom-app-action";
      customAppId: string;
      publishedAt: string;
      pageId: string;
      pageParams: Record<string, string>;
      timeZone: string;
      blockId: string;
      actionId: string;
      recordId?: string;
      search?: string;
      cursor?: string;
      revision: number;
    }
  | {
      kind: "custom-app-bulk-action";
      customAppId: string;
      publishedAt: string;
      pageId: string;
      pageParams: Record<string, string>;
      timeZone: string;
      blockId: string;
      actionId: string;
      recordIds: string[];
      search?: string;
      cursor?: string;
      revision: number;
    }
  | {
      kind: "custom-app-sidebar-action";
      customAppId: string;
      publishedAt: string;
      timeZone: string;
      actionId: string;
      revision: number;
    }
  | {
      kind: "custom-app-scanner";
      customAppId: string;
      publishedAt: string;
      pageId: string;
      pageParams: Record<string, string>;
      timeZone: string;
      blockId: string;
      revision: number;
      configHash: string;
    };

/**
 * Everything about *who* a run acts as, frozen when it was accepted.
 *
 * On the kernel run rather than the profile because the kernel already has a
 * column for exactly this, and because an authorization that could be edited
 * after the fact would let a queued run widen its own reach.
 *
 * `actor` is separated out because the kernel reads that key to build the
 * invocation; the rest is Grids' business.
 */
export type GridsWorkflowAuthorizationSnapshot = {
  actor: { userId: string | null; groupIds: string[]; serviceAccountId: string | null };
  principal: GridsWorkflowPrincipal;
  authorization: GridsWorkflowAuthorization;
  launcherId: string | null;
};

export const gridsAuthorizationSnapshot = (
  principal: GridsWorkflowPrincipal,
  authorization: GridsWorkflowAuthorization,
  launcherId: string | null,
): GridsWorkflowAuthorizationSnapshot => ({
  actor: { userId: principal.userId, groupIds: principal.groupIds, serviceAccountId: principal.serviceAccountId },
  principal,
  authorization,
  launcherId,
});

const parseSnapshot = (value: unknown): GridsWorkflowAuthorizationSnapshot | null => {
  const snapshot = parseJsonbRow<Partial<GridsWorkflowAuthorizationSnapshot> | null>(value, null);
  return snapshot?.principal && snapshot.authorization
    ? {
        actor: snapshot.actor ?? { userId: null, groupIds: [], serviceAccountId: null },
        principal: snapshot.principal,
        authorization: snapshot.authorization,
        launcherId: snapshot.launcherId ?? null,
      }
    : null;
};

// ─── Reading a run ───────────────────────────────────────────────────────────

const RUN_SELECT = sql.unsafe(`
  r.id::text AS id, r.workflow_id::text AS workflow_id, r.mode, r.state, r.inputs,
  r.result, r.result_message, r.error, r.created_at, r.started_at, r.finished_at,
  v.revision AS workflow_revision,
  p.base_id::text AS base_id, p.launcher_id::text AS launcher_id, p.channel,
  p.actor_user_id::text AS actor_user_id, p.service_account_id::text AS service_account_id
`);

const RUN_FROM = sql.unsafe(`
  FROM workflows.run AS r
  JOIN workflows.version AS v ON v.id = r.workflow_version_id
  JOIN grids.workflow_run_profile AS p ON p.run_id = r.id
`);

const mapRun = (row: DbRow): GridsWorkflowRun => ({
  id: row.id as string,
  workflowId: (row.workflow_id as string | null) ?? null,
  launcherId: (row.launcher_id as string | null) ?? null,
  baseId: row.base_id as string,
  workflowRevision: Number(row.workflow_revision),
  mode: row.mode as GridsWorkflowRun["mode"],
  channel: row.channel as GridsWorkflowChannel,
  actorUserId: (row.actor_user_id as string | null) ?? null,
  serviceAccountId: (row.service_account_id as string | null) ?? null,
  inputs: parseJsonbRow<GridsWorkflowRun["inputs"]>(row.inputs, {}),
  status: row.state as GridsWorkflowRun["status"],
  result: parseJsonbRow<GridsWorkflowRun["result"]>(row.result, null),
  error: parseJsonbRow<GridsWorkflowRun["error"]>(row.error, null),
  resultMessage: (row.result_message as string | null) ?? null,
  createdAt: toIsoString(row.created_at as Date | string),
  startedAt: row.started_at ? toIsoString(row.started_at as Date | string) : null,
  finishedAt: row.finished_at ? toIsoString(row.finished_at as Date | string) : null,
});

export const getWorkflowRun = async (runId: string, client?: SqlClient): Promise<GridsWorkflowRun | null> => {
  const db = client ?? sql;
  const [row] = await db<DbRow[]>`SELECT ${RUN_SELECT} ${RUN_FROM} WHERE r.id = ${runId}::uuid`;
  return row ? mapRun(row) : null;
};

export const getWorkflowRunByShortId = async (shortId: string, client?: SqlClient): Promise<GridsWorkflowRun | null> => {
  const db = client ?? sql;
  const [row] = await db<DbRow[]>`SELECT ${RUN_SELECT} ${RUN_FROM} WHERE p.short_id = ${shortId}`;
  return row ? mapRun(row) : null;
};

export const listWorkflowRunsPage = async (params: {
  baseId: string;
  workflowIds: string[];
  workflowId?: string | null;
  status?: GridsWorkflowRun["status"] | null;
  mode?: GridsWorkflowRun["mode"] | null;
  channel?: GridsWorkflowChannel | null;
  cursor?: string | null;
  limit?: number | null;
}): Promise<{ items: GridsWorkflowRun[]; nextCursor: string | null }> => {
  if (params.workflowIds.length === 0) return { items: [], nextCursor: null };
  const cap = pageSize(params.limit);
  const workflowIds = toPgUuidArray(params.workflowIds);
  const cursor = parseCursor(params.cursor);
  const workflowClause = params.workflowId ? sql`AND r.workflow_id = ${params.workflowId}::uuid` : sql``;
  const statusClause = params.status ? sql`AND r.state = ${params.status}` : sql``;
  const modeClause = params.mode ? sql`AND r.mode = ${params.mode}` : sql``;
  const channelClause = params.channel ? sql`AND p.channel = ${params.channel}` : sql``;
  const cursorClause = cursor ? sql`AND (r.created_at, r.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : sql``;
  const rows = await sql<DbRow[]>`
    SELECT ${RUN_SELECT}, (r.created_at::text || '|' || r.id::text) AS cursor_token
    ${RUN_FROM}
    WHERE p.base_id = ${params.baseId}::uuid
      AND r.workflow_id = ANY(${workflowIds}::uuid[])
      ${workflowClause}
      ${statusClause}
      ${modeClause}
      ${channelClause}
      ${cursorClause}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${cap + 1}
  `;
  return {
    items: rows.slice(0, cap).map(mapRun),
    nextCursor: rows.length > cap ? String(rows[cap - 1]?.cursor_token ?? "") || null : null,
  };
};

// ─── Reading a run's steps ───────────────────────────────────────────────────

// Documents used to be persisted into the step outcome in full, including
// `templateSnapshot` and `renderData` — the rendered record content. Step
// outcomes are readable with workflow "read" alone, so those keys are stripped
// on the way out. New runs already persist only the document summary; this
// covers rows written before that changed.
const DOCUMENT_PAYLOAD_KEYS = ["templateSnapshot", "renderData"] as const;

const redactStepOutcome = (outcome: GridsWorkflowStepRun["outcome"]): GridsWorkflowStepRun["outcome"] => {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return outcome;
  const output = (outcome as { output?: unknown }).output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return outcome;
  if (!DOCUMENT_PAYLOAD_KEYS.some((key) => key in output)) return outcome;
  const redacted = { ...(output as Record<string, unknown>) };
  for (const key of DOCUMENT_PAYLOAD_KEYS) delete redacted[key];
  return { ...(outcome as Record<string, unknown>), output: redacted } as GridsWorkflowStepRun["outcome"];
};

/**
 * The outcome, without the mode the kernel journals beside it.
 *
 * `workflows.step_outcome.outcome` holds the pair the executor hands its
 * repository — a restored step has to know which of the two outcome shapes it
 * is looking at. Nothing above this does: a run view handed the pair would find
 * no `state` and no `error` where it looks for them, and the redaction below
 * would stop finding the document payload it exists to strip.
 */
const unwrapStepOutcome = (stored: WorkflowJsonValue | null): GridsWorkflowStepRun["outcome"] => {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return stored;
  const mode = (stored as { mode?: unknown }).mode;
  return mode === "execute" || mode === "dryRun" ? ((stored as { outcome?: WorkflowJsonValue }).outcome ?? null) : stored;
};

const asNumbers = (value: WorkflowJsonValue): number[] =>
  Array.isArray(value) ? value.flatMap((item) => (typeof item === "number" ? [item] : [])) : [];

const asPath = (value: WorkflowJsonValue): Array<string | number> =>
  Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" || typeof item === "number" ? [item] : [])) : [];

const mapStepRun = (runId: string, step: WorkflowStepSummary): GridsWorkflowStepRun => ({
  runId,
  key: step.stepKey,
  sourcePath: asPath(step.sourcePath),
  iterationPath: asNumbers(step.iterationPath),
  kind: step.kind,
  action: step.action,
  status: step.state as GridsWorkflowStepRun["status"],
  outcome: redactStepOutcome(unwrapStepOutcome(step.outcome)),
  executionGeneration: step.attempt,
  startedAt: toIsoString(step.startedAt),
  finishedAt: step.finishedAt ? toIsoString(step.finishedAt) : null,
});

export const listWorkflowStepRunsPage = async (runId: string): Promise<{ items: GridsWorkflowStepRun[]; truncated: boolean }> => {
  const steps = await listWorkflowRunSteps(runId);
  return {
    items: steps.slice(0, MAX_DETAIL_STEPS).map((step) => mapStepRun(runId, step)),
    truncated: steps.length > MAX_DETAIL_STEPS,
  };
};

export const listWorkflowStepRuns = async (runId: string): Promise<GridsWorkflowStepRun[]> => (await listWorkflowStepRunsPage(runId)).items;

export const getWorkflowStepRun = async (runId: string, stepKey: string): Promise<GridsWorkflowStepRun | null> => {
  const [step] = await listWorkflowRunSteps(runId, { stepKeys: [stepKey] });
  return step ? mapStepRun(runId, step) : null;
};

// ─── The scope an action or a value resolver works in ────────────────────────

/**
 * Everything a declared action needs to know about the run it is executing in.
 *
 * One read, because a declared action is a static function: it cannot be handed
 * the wiring that started the run, so it asks the run itself. The credential and
 * the authorization snapshot are the point — they decide whether an effect is
 * allowed, and rebuilding a principal from the invocation's actor alone would
 * silently promote a read-scoped token to a session's authority.
 */
export type GridsWorkflowRunScope = {
  runId: string;
  baseId: string;
  workflow: { id: string; shortId: string; name: string };
  principal: GridsWorkflowPrincipal;
  authorization: GridsWorkflowAuthorization;
  launcherId: string | null;
};

export const getWorkflowRunScope = async (runId: string, client?: SqlClient): Promise<GridsWorkflowRunScope | null> => {
  const db = client ?? sql;
  const [row] = await db<DbRow[]>`
    SELECT r.id::text AS id, r.authorization_snapshot,
           p.base_id::text AS base_id, p.launcher_id::text AS launcher_id,
           profile.id::text AS workflow_id, profile.short_id, workflow.name
    FROM workflows.run AS r
    JOIN grids.workflow_run_profile AS p ON p.run_id = r.id
    JOIN grids.workflow_profile AS profile ON profile.id = r.workflow_id
    JOIN workflows.workflow AS workflow ON workflow.id = profile.id
    WHERE r.id = ${runId}::uuid
  `;
  if (!row) return null;
  const snapshot = parseSnapshot(row.authorization_snapshot);
  if (!snapshot) return null;
  return {
    runId: row.id as string,
    baseId: row.base_id as string,
    workflow: { id: row.workflow_id as string, shortId: row.short_id as string, name: row.name as string },
    principal: snapshot.principal,
    authorization: snapshot.authorization,
    launcherId: (row.launcher_id as string | null) ?? snapshot.launcherId,
  };
};

// ─── Cancelling ──────────────────────────────────────────────────────────────

/**
 * Asks a run to stop, and says so in the audit log.
 *
 * A request rather than a write: the worker holding the lease notices on its
 * next heartbeat and unwinds where it is. Killing the row underneath a running
 * worker is how an effect ends up performed by a run that claims it was
 * cancelled before it happened.
 */
/**
 * `notFound` and `notCancelable` are separate answers on purpose: the kernel
 * refuses a terminal run by changing no rows, and reporting that as success
 * tells somebody their finished run was just cancelled.
 */
export type CancelWorkflowRunOutcome =
  | { state: "canceled"; run: GridsWorkflowRun }
  | { state: "notFound" }
  | { state: "notCancelable"; run: GridsWorkflowRun };

export const cancelWorkflowRun = async (runId: string, actorUserId: string | null): Promise<CancelWorkflowRunOutcome> => {
  const run = await getWorkflowRun(runId);
  if (!run) return { state: "notFound" };
  if (!(await requestWorkflowRunCancel(runId))) return { state: "notCancelable", run };
  await logAudit({
    baseId: run.baseId,
    userId: actorUserId,
    action: "workflow.run.canceled",
    diff: {
      workflowRun: {
        old: null,
        new: {
          id: run.id,
          workflowId: run.workflowId,
          mode: run.mode,
          channel: run.channel,
          status: "canceled",
          requestedByUserId: actorUserId,
        },
      },
    },
  });
  return { state: "canceled", run: (await getWorkflowRun(runId)) ?? run };
};

// ─── Provenance and statistics ───────────────────────────────────────────────

export type WorkflowRunProvenance = {
  workflowName: string | null;
  actorLabel: string | null;
  serviceAccountLabel: string | null;
  launcherName: string | null;
};

export const getWorkflowRunProvenance = async (runId: string): Promise<WorkflowRunProvenance> => {
  const [row] = await sql<
    Array<{
      workflow_name: string | null;
      actor_label: string | null;
      service_account_label: string | null;
      launcher_name: string | null;
    }>
  >`
    SELECT
      workflow.name AS workflow_name,
      COALESCE(NULLIF(actor.display_name, ''), NULLIF(actor.uid, ''), actor.mail) AS actor_label,
      service_account.name AS service_account_label,
      launcher.name AS launcher_name
    FROM workflows.run AS run
    JOIN grids.workflow_run_profile AS profile ON profile.run_id = run.id
    LEFT JOIN workflows.workflow AS workflow ON workflow.id = run.workflow_id
    LEFT JOIN auth.users actor ON actor.id = profile.actor_user_id
    LEFT JOIN auth.service_accounts service_account ON service_account.id = profile.service_account_id
    LEFT JOIN grids.workflow_launchers launcher ON launcher.id = profile.launcher_id
    WHERE run.id = ${runId}::uuid
  `;
  return {
    workflowName: row?.workflow_name ?? null,
    actorLabel: row?.actor_label ?? null,
    serviceAccountLabel: row?.service_account_label ?? null,
    launcherName: row?.launcher_name ?? null,
  };
};

type StatsSqlRow = {
  total: number | string;
  active: number | string;
  queued: number | string;
  running: number | string;
  waiting: number | string;
  succeeded: number | string;
  failed: number | string;
  canceled: number | string;
  needs_attention: number | string;
  failed_last_24h?: number | string;
  avg_duration_ms: number | string | null;
  p99_duration_ms: number | string | null;
  last_run_at: Date | string | null;
};

type WorkflowStatsSqlRow = StatsSqlRow & {
  workflow_id: string;
  latest_status: GridsWorkflowRun["status"] | null;
};

const count = (value: number | string | null | undefined): number => Math.max(0, Math.trunc(Number(value) || 0));
const numberOrNull = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const statsCounts = (row: StatsSqlRow | undefined) => {
  const total = count(row?.total);
  const failed = count(row?.failed);
  const needsAttention = count(row?.needs_attention);
  return {
    total,
    active: count(row?.active),
    queued: count(row?.queued),
    running: count(row?.running),
    waiting: count(row?.waiting),
    succeeded: count(row?.succeeded),
    failed,
    canceled: count(row?.canceled),
    needsAttention,
    errorRate: total > 0 ? ((failed + needsAttention) / total) * 100 : 0,
    avgDurationMs: numberOrNull(row?.avg_duration_ms),
    p99DurationMs: numberOrNull(row?.p99_duration_ms),
    lastRunAt: row?.last_run_at ? toIsoString(row.last_run_at) : null,
  };
};

export const getWorkflowRunStats = async (
  baseId: string,
  workflowIds: string[],
  options: { window?: GridsWorkflowRunStatsWindow | null } = {},
): Promise<GridsWorkflowRunStats> => {
  const window = options.window ?? DEFAULT_STATS_WINDOW;
  if (workflowIds.length === 0) return { window, ...statsCounts(undefined), failedLast24h: 0, byWorkflow: [] };
  const ids = toPgUuidArray(workflowIds);
  const windowSeconds = STATS_WINDOW_SECONDS[window];
  const [row] = await sql<Array<StatsSqlRow & { by_workflow: unknown }>>`
    WITH scoped AS (
      SELECT id, workflow_id::text AS workflow_id, state, created_at, started_at, finished_at
      FROM workflows.run
      WHERE app_id = ${GRIDS_APP_ID}
        AND scope_id = ${baseId}
        AND workflow_id = ANY(${ids}::uuid[])
        AND mode = 'execute'
    ),
    filtered AS (
      SELECT id, workflow_id, state, created_at,
             CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
               THEN GREATEST(0, EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)
               ELSE NULL
             END AS duration_ms
      FROM scoped
      WHERE created_at >= now() - (${windowSeconds} * interval '1 second')
    ),
    active AS (
      SELECT workflow_id, count(*)::int AS active
      FROM scoped
      WHERE state IN ('queued', 'running', 'waiting')
      GROUP BY workflow_id
    ),
    failed_24h AS (
      SELECT count(*)::int AS failed_last_24h
      FROM scoped
      WHERE state IN ('failed', 'needs_attention') AND created_at >= now() - interval '24 hours'
    ),
    overall AS (
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE state = 'queued')::int AS queued,
             count(*) FILTER (WHERE state = 'running')::int AS running,
             count(*) FILTER (WHERE state = 'waiting')::int AS waiting,
             count(*) FILTER (WHERE state = 'succeeded')::int AS succeeded,
             count(*) FILTER (WHERE state = 'failed')::int AS failed,
             count(*) FILTER (WHERE state = 'canceled')::int AS canceled,
             count(*) FILTER (WHERE state = 'needs_attention')::int AS needs_attention,
             round((avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::numeric)::int AS avg_duration_ms,
             round((percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)
               FILTER (WHERE duration_ms IS NOT NULL))::numeric)::int AS p99_duration_ms,
             max(created_at) AS last_run_at
      FROM filtered
    ),
    latest AS (
      SELECT DISTINCT ON (workflow_id) workflow_id, state AS latest_status
      FROM filtered
      ORDER BY workflow_id, created_at DESC, id DESC
    ),
    window_per_workflow AS (
      SELECT f.workflow_id,
             count(*)::int AS total,
             0::int AS active,
             count(*) FILTER (WHERE f.state = 'queued')::int AS queued,
             count(*) FILTER (WHERE f.state = 'running')::int AS running,
             count(*) FILTER (WHERE f.state = 'waiting')::int AS waiting,
             count(*) FILTER (WHERE f.state = 'succeeded')::int AS succeeded,
             count(*) FILTER (WHERE f.state = 'failed')::int AS failed,
             count(*) FILTER (WHERE f.state = 'canceled')::int AS canceled,
             count(*) FILTER (WHERE f.state = 'needs_attention')::int AS needs_attention,
             round((avg(f.duration_ms) FILTER (WHERE f.duration_ms IS NOT NULL))::numeric)::int AS avg_duration_ms,
             round((percentile_cont(0.99) WITHIN GROUP (ORDER BY f.duration_ms)
               FILTER (WHERE f.duration_ms IS NOT NULL))::numeric)::int AS p99_duration_ms,
             max(f.created_at) AS last_run_at,
             latest.latest_status
      FROM filtered f
      JOIN latest ON latest.workflow_id = f.workflow_id
      GROUP BY f.workflow_id, latest.latest_status
    ),
    per_workflow AS (
      SELECT COALESCE(windowed.workflow_id, active.workflow_id) AS workflow_id,
             COALESCE(windowed.total, 0)::int AS total,
             COALESCE(active.active, 0)::int AS active,
             COALESCE(windowed.queued, 0)::int AS queued,
             COALESCE(windowed.running, 0)::int AS running,
             COALESCE(windowed.waiting, 0)::int AS waiting,
             COALESCE(windowed.succeeded, 0)::int AS succeeded,
             COALESCE(windowed.failed, 0)::int AS failed,
             COALESCE(windowed.canceled, 0)::int AS canceled,
             COALESCE(windowed.needs_attention, 0)::int AS needs_attention,
             windowed.avg_duration_ms,
             windowed.p99_duration_ms,
             windowed.last_run_at,
             windowed.latest_status
      FROM window_per_workflow windowed
      FULL JOIN active ON active.workflow_id = windowed.workflow_id
    )
    SELECT overall.*,
           COALESCE((SELECT sum(active.active)::int FROM active), 0)::int AS active,
           failed_24h.failed_last_24h,
           COALESCE((SELECT jsonb_agg(to_jsonb(per_workflow) ORDER BY per_workflow.last_run_at DESC, per_workflow.workflow_id)
                     FROM per_workflow), '[]'::jsonb) AS by_workflow
    FROM overall
    CROSS JOIN failed_24h
  `;
  const byWorkflow = parseJsonbRow<WorkflowStatsSqlRow[]>(row?.by_workflow, []).map((item) => ({
    workflowId: item.workflow_id,
    ...statsCounts(item),
    latestStatus: item.latest_status,
  }));
  return {
    window,
    ...statsCounts(row),
    failedLast24h: count(row?.failed_last_24h),
    byWorkflow,
  };
};

/** A run detail read straight from the kernel, for the parts Grids does not mirror. */
export const getKernelWorkflowRun = getKernelRun;

// ─── Starting a run ──────────────────────────────────────────────────────────

/**
 * What Grids records about a run beyond what the kernel keeps.
 *
 * Written in the same transaction that creates the run, and that is not
 * bookkeeping neatness. A committed run is immediately claimable, so a profile
 * written afterwards leaves a window in which a worker picks the run up and
 * every declared action fails to find the scope it acts in.
 */
const writeRunProfile = async (input: {
  tx: SqlClient;
  runId: string;
  baseId: string;
  workflowId: string;
  launcherId: string | null;
  launcherKind: GridsWorkflowLauncherKind | null;
  channel: GridsWorkflowChannel;
  principal: GridsWorkflowPrincipal;
  requestFingerprint: string;
}): Promise<{ requestFingerprint: string }> => {
  const row = await insertWithShortIdForDb(input.tx, "idx_grids_workflow_run_profile_short_id", async (db, shortId) => {
    const [inserted] = await db<Array<{ request_fingerprint: string }>>`
    INSERT INTO grids.workflow_run_profile (
      run_id, short_id, base_id, workflow_id, launcher_id, launcher_kind, channel, actor_user_id, service_account_id, request_fingerprint
    ) VALUES (
      ${input.runId}::uuid, ${shortId}, ${input.baseId}::uuid, ${input.workflowId}::uuid,
      ${input.launcherId}::uuid, ${input.launcherKind}, ${input.channel},
      ${input.principal.userId}::uuid, ${input.principal.serviceAccountId}::uuid, ${input.requestFingerprint}
    )
    ON CONFLICT (run_id) DO UPDATE SET run_id = grids.workflow_run_profile.run_id
    RETURNING request_fingerprint
  `;
    return inserted;
  });
  return { requestFingerprint: row?.request_fingerprint ?? input.requestFingerprint };
};

export type StartWorkflowRunInput = {
  workflow: { id: string; baseId: string; revision: number };
  mode: WorkflowInvocationMode;
  channel: GridsWorkflowChannel;
  /** The event type this occurrence is, one of GRIDS_EVENT. */
  eventType: string;
  inputs: Record<string, WorkflowJsonValue>;
  context: Record<string, WorkflowJsonValue>;
  idempotencyKey: string;
  requestFingerprint: string;
  occurredAt: string;
  principal: GridsWorkflowPrincipal;
  authorization: GridsWorkflowAuthorization;
  launcherId?: string | null;
  launcherKind?: GridsWorkflowLauncherKind | null;
};

/**
 * Turns a request to run a workflow into a run.
 *
 * An execution is an event: the kernel records what happened, matches it
 * against the workflow's activations, and materialises the run. That is the
 * same path a schedule tick and a record change take, so there is one
 * durability story rather than three.
 *
 * A dry run is not. Nothing happened — somebody is asking what would — so it is
 * created directly against the version being asked about, and never reaches an
 * activation.
 */
export const startWorkflowRun = async (input: StartWorkflowRunInput): Promise<Result<WorkflowInvocationReceipt>> => {
  const locale = typeof input.context.locale === "string" ? input.context.locale : undefined;
  const t = workflowServiceText(locale);
  const scopeId = input.workflow.baseId;
  const snapshot = gridsAuthorizationSnapshot(input.principal, input.authorization, input.launcherId ?? null);
  const occurredAt = new Date(input.occurredAt);

  const started = await sql.begin(async (tx) => {
    const created =
      input.mode === "execute"
        ? await startFromEvent(input, scopeId, snapshot, occurredAt, tx)
        : await startDryRun(input, scopeId, snapshot, occurredAt, tx);
    if (!created.ok) return created;
    const profile = await writeRunProfile({
      tx,
      runId: created.data.runId,
      baseId: input.workflow.baseId,
      workflowId: input.workflow.id,
      launcherId: input.launcherId ?? null,
      launcherKind: input.launcherKind ?? null,
      channel: input.channel,
      principal: input.principal,
      requestFingerprint: input.requestFingerprint,
    });
    /*
     * The kernel answers a repeated idempotency key with the run it already
     * started. That is right for a redelivery and wrong for a different request
     * wearing the same key — which would otherwise be silently ignored.
     */
    if (profile.requestFingerprint !== input.requestFingerprint) {
      return fail(workflowConflict(t.idempotencyConflict));
    }
    return created;
  });
  if (!started.ok) return started;

  const run = await getWorkflowRun(started.data.runId);
  return ok({
    runId: started.data.runId,
    workflowId: input.workflow.id,
    revision: toWorkflowRevision(input.workflow.revision),
    mode: input.mode,
    channel: input.channel,
    created: started.data.created,
    status: run?.status ?? "queued",
  });
};

const startFromEvent = async (
  input: StartWorkflowRunInput,
  scopeId: string,
  snapshot: GridsWorkflowAuthorizationSnapshot,
  occurredAt: Date,
  tx: SqlClient,
): Promise<Result<{ runId: string; created: boolean }>> => {
  const locale = typeof input.context.locale === "string" ? input.context.locale : undefined;
  const emission = await emitWorkflowEvent(
    {
      appId: GRIDS_APP_ID,
      scopeId,
      type: input.eventType,
      data: input.inputs,
      context: input.context,
      authorization: snapshot as unknown as WorkflowJsonValue,
      // Scoped to the workflow and the key the caller chose: two workflows in a
      // base may legitimately be asked to run under the same caller-side key.
      dedupeKey: `${input.workflow.id}:${input.idempotencyKey}`,
      targetWorkflowId: input.workflow.id,
      occurredAt,
    },
    { dispatch: "now", db: tx },
  );
  const runId = emission.runIds[0];
  if (!runId) {
    // No activation matched. A workflow is always listening for a direct
    // invocation, so this means it was disabled between the check and here.
    return fail(err.badInput(workflowServiceText(locale).workflowNotAcceptingRuns));
  }
  return ok({ runId, created: !emission.duplicate });
};

const startDryRun = async (
  input: StartWorkflowRunInput,
  scopeId: string,
  snapshot: GridsWorkflowAuthorizationSnapshot,
  occurredAt: Date,
  tx: SqlClient,
): Promise<Result<{ runId: string; created: boolean }>> => {
  const locale = typeof input.context.locale === "string" ? input.context.locale : undefined;
  const [version] = await tx<Array<{ id: string }>>`
    SELECT id::text AS id FROM workflows.version
    WHERE workflow_id = ${input.workflow.id}::uuid
    ORDER BY revision DESC
    LIMIT 1
  `;
  if (!version) return fail({ ...err.notFound("workflow version"), message: workflowServiceText(locale).workflowVersionNotFound });
  const existing = await tx<Array<{ id: string }>>`
    SELECT id::text AS id FROM workflows.run
    WHERE workflow_id = ${input.workflow.id}::uuid AND mode = 'dryRun' AND idempotency_key = ${input.idempotencyKey}
  `;
  const runId = await createWorkflowRun(
    {
      appId: GRIDS_APP_ID,
      scopeId,
      workflowId: input.workflow.id,
      workflowVersionId: version.id,
      mode: "dryRun",
      inputs: input.inputs,
      context: input.context,
      authorization: snapshot as unknown as WorkflowJsonValue,
      idempotencyKey: input.idempotencyKey,
      occurredAt,
    },
    { db: tx },
  );
  return ok({ runId, created: existing.length === 0 });
};
