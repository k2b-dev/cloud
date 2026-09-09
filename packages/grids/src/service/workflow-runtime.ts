/**
 * What Grids still owns now that the kernel owns runs.
 *
 * Three things: turning a request to run a workflow into an event, keeping the
 * cron registrations and the record-event readers in step with the workflows
 * that want them, and a worker that drains whatever the kernel has made
 * claimable for this app. The lease protocol, the journal, recovery and the
 * generation fence are all the kernel's — there is no second copy here.
 */

import { err, fail, type Result } from "@k2b/stdlib";
import { CursorMismatchError, RetentionGapError, type Worker } from "@k2b/sync";
import { lazySync } from "@k2b/cloud";
import { createRuntimeLifecycle, createRuntimeTaskTracker, logger, stopRuntimeResources, trace } from "@k2b/cloud/services";
import { get as settingsGet } from "@k2b/cloud/services/settings";
import { normalizeLocale } from "@k2b/cloud/shared";
import {
  createWorkflowBuiltinActionPorts,
  type WorkflowExecutionError,
  type WorkflowInvocationMode,
  type WorkflowInvocationReceipt,
  type WorkflowJsonValue,
} from "@k2b/cloud/workflows";
import { hashWorkflowJson } from "@k2b/cloud/workflows/language";
import {
  evaluateWorkflowTriggerInputs,
  type WorkflowDryRunActionPort,
  type WorkflowExecuteActionPort,
  type WorkflowTraceEvent,
  type WorkflowTracePort,
} from "@k2b/cloud/workflows/runtime";
import {
  createWorkflowActionPort,
  createWorkflowDryRunPort,
  dryRunOneWorkflow,
  runOneWorkflow,
  tickWorkflows,
  type WorkflowRunClaim,
  wakeExpiredWorkflowRuns,
} from "@k2b/cloud/workflows/store";
import type { WorkflowRunEventScope } from "../lib/workflow-run-events";
import type {
  GridsWorkflow,
  GridsWorkflowChannel,
  GridsWorkflowLauncherKind,
  GridsWorkflowPrincipal,
  WorkflowTriggerRuntimeState,
} from "../workflows/contracts";
import { GRIDS_EVENT } from "../workflows/events";
import { gridsWorkflows } from "../workflows/module";
import { reconcileStuckControlledDestructionRuns } from "./controlled-destruction";
import { cleanupExpiredEvidenceExports } from "./evidence-exports";
import { canAccessWorkflowExecutionTable, canAccessWorkflowRunTable, canExecuteWorkflow } from "./workflow-action-scope";
import { getWorkflow, listScheduledWorkflows } from "./workflow-definitions";
import { workflowConflict } from "./workflow-errors";
import { createWorkflowRecordEventRuntime } from "./workflow-record-events";
import { notifyWorkflowRunEvent } from "./workflow-run-events";
import {
  GRIDS_APP_ID,
  type GridsWorkflowAuthorization,
  getWorkflowRun,
  getWorkflowRunScope,
  getWorkflowStepRun,
  replayWorkflowRun,
  startWorkflowRun,
} from "./workflow-runs";
import { latestWorkflowRuntimeEventCursor, liveWorkflowRuntimeEvents } from "./workflow-runtime-events";
import { workflowServiceText } from "./workflow-service-messages";
import {
  createGridsWorkflowValueResolver,
  createGridsWorkflowValueResolverPort,
  createWorkflowInputPreparationDeps,
  loadWorkflowUserGroupIds,
  prepareWorkflowInputs,
  WorkflowInputPreparationError,
} from "./workflow-values";

const log = logger("grids:workflows");
const workflowScheduler = lazySync((sync) =>
  sync.scheduler({ id: "grids:workflows", delivery: { maxAttempts: 4, backoffMs: [5_000, 20_000, 60_000] } }),
);
let scheduleWorker: Worker | undefined;
const RECONCILE_INTERVAL_MS = 60_000;
/** Short, because a button press waits for it. Dispatch is cheap when there is nothing to do. */
const WORKER_INTERVAL_MS = 1_000;
/** Bounds one tick: a worker that never returns cannot be stopped. */
const MAX_DRY_RUNS_PER_TICK = 25;
const SCHEDULE_PREFIX = "grids:workflow:";

const workflowScheduleId = (workflow: Pick<GridsWorkflow, "id" | "revision">): string => `${SCHEDULE_PREFIX}${workflow.id}`;

const workflowScheduleIdPrefix = (workflowId: string): string => `${SCHEDULE_PREFIX}${workflowId}:revision:`;

const deleteWorkflowSchedules = async (workflowId: string): Promise<void> => {
  const prefix = workflowScheduleIdPrefix(workflowId);
  await Promise.all(
    (await workflowScheduler().list())
      .filter((schedule) => schedule.id === `${SCHEDULE_PREFIX}${workflowId}` || schedule.id.startsWith(prefix))
      .map((schedule) => workflowScheduler().delete({ id: schedule.id })),
  );
};

const workflowScheduleMetadata = (workflow: Pick<GridsWorkflow, "id" | "name" | "revision">) => ({
  appId: "grids",
  family: "grids:workflows",
  label: `Workflow: ${workflow.name}`,
  source: "grids:workflow-schedules",
  resourceLabel: workflow.name,
  workflowId: workflow.id,
  revision: workflow.revision,
});

type InvokeGridsWorkflowInput = {
  workflowId: string;
  mode: WorkflowInvocationMode;
  channel: GridsWorkflowChannel;
  inputs: Record<string, WorkflowJsonValue>;
  idempotencyKey: string;
  expectedRevision?: number;
  principal: GridsWorkflowPrincipal;
  launcherId?: string | null;
  authorization?: GridsWorkflowAuthorization;
  occurredAt?: string;
  context?: Record<string, WorkflowJsonValue>;
  trustedRecordIds?: ReadonlyMap<string, ReadonlySet<string>>;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Which occurrence a channel is.
 *
 * The channel is what a caller says about itself; the event type is what the
 * kernel matches activations on. Three of the six are the same press of the
 * same kind of button, so they share one.
 */
const EVENT_TYPE_BY_CHANNEL: Record<GridsWorkflowChannel, string> = {
  api: GRIDS_EVENT.invoked,
  customApp: GRIDS_EVENT.launcherPressed,
  scanner: GRIDS_EVENT.launcherPressed,
  bulk: GRIDS_EVENT.launcherPressed,
  record: GRIDS_EVENT.launcherPressed,
  schedule: GRIDS_EVENT.scheduleTick,
  recordEvent: GRIDS_EVENT.recordChanged,
};

const LAUNCHER_KIND_BY_CHANNEL: Partial<Record<GridsWorkflowChannel, GridsWorkflowLauncherKind>> = {
  customApp: "customApp",
  scanner: "scanner",
  bulk: "bulk",
  record: "record",
};

/**
 * What makes two requests under one idempotency key the same request.
 *
 * The kernel answers a repeated key with the run it already started, which is
 * right for a redelivery and wrong for a changed payload wearing the same key.
 * `context.workflow` is excluded because Grids adds it after the caller's
 * request — including it would make the hash depend on the workflow's name.
 */
const workflowInvocationFingerprint = (input: {
  workflowId: string;
  mode: WorkflowInvocationMode;
  channel: GridsWorkflowChannel;
  principal: GridsWorkflowPrincipal;
  inputs: Record<string, WorkflowJsonValue>;
  context: Record<string, WorkflowJsonValue>;
}): Promise<string> =>
  hashWorkflowJson({
    workflowId: input.workflowId,
    mode: input.mode,
    channel: input.channel,
    actor: {
      userId: input.principal.userId,
      serviceAccountId: input.principal.serviceAccountId,
      actorServiceAccountId: input.principal.actorServiceAccountId ?? null,
      credential: input.principal.credential ?? null,
    },
    inputs: input.inputs,
    context: Object.fromEntries(Object.entries(input.context).filter(([key]) => key !== "workflow")),
  });

// ─── Announcing a run to whoever is watching it ──────────────────────────────

const eventScope = (_authorization: GridsWorkflowAuthorization | undefined): WorkflowRunEventScope => ({ kind: "workflow" });

/**
 * Publishes a run transition to the browsers watching it.
 *
 * Re-read rather than assembled from the event: the trace event says only that
 * something happened and to which run, and the row is what the run page has to
 * agree with. `transitionId` becomes the topic's idempotency key, so two
 * publishes of the same transition collapse into one.
 */
const publishRunEvent = async (runId: string, transitionId: string, stepKey?: string): Promise<void> => {
  const [run, scope] = await Promise.all([getWorkflowRun(runId), getWorkflowRunScope(runId)]);
  if (!run) return;
  const step = stepKey ? await getWorkflowStepRun(runId, stepKey) : null;
  await notifyWorkflowRunEvent(run, step ? [step] : [], eventScope(scope?.authorization), transitionId);
};

/**
 * Maps a trace event onto the transition the run stream names it by.
 *
 * The ids are the ones the pre-kernel runtime published, because they are the
 * topic's idempotency key: changing them would let a redelivered transition
 * appear twice in a browser that is already mid-stream.
 */
const publishRunTraceEvent = async (event: WorkflowTraceEvent): Promise<void> => {
  if (event.type === "run.started") {
    await publishRunEvent(event.run.runId, `running:${event.run.executionGeneration}`);
    return;
  }
  if (event.type === "run.canceled" || event.type === "run.finished") {
    const state = event.type === "run.canceled" ? "canceled" : event.state;
    await publishRunEvent(event.run.runId, `run:${event.run.executionGeneration}:${state}`);
    return;
  }
  if (event.type === "step.started" || event.type === "step.finished" || event.type === "step.waiting") {
    const step = event.step;
    // The persisted status, not one derived from the outcome a second time —
    // the executor writes the step before it announces it.
    const persisted = await getWorkflowStepRun(step.runId, step.key);
    const status = event.type === "step.started" ? "running" : (persisted?.status ?? "waiting");
    await publishRunEvent(step.runId, `step:${step.key}:${step.executionGeneration}:${status}`, step.key);
  }
};

/**
 * The observability span and the live run stream, from the one event stream.
 *
 * Both are best-effort by contract — the kernel swallows what this throws — so
 * a browser nobody is listening on cannot fail a run that did its work.
 */
const workflowTrace: WorkflowTracePort = {
  emit: async (event: WorkflowTraceEvent) => {
    const step = "run" in event ? null : event.step;
    const runId = "run" in event ? event.run.runId : event.step.runId;
    const outcome = event.type === "step.finished" ? event.result.outcome.state : undefined;
    await trace.record({
      spanKey: `grids:workflow-run:${runId}`,
      name: "Grid workflow run",
      source: "grids:workflow-runs:v1",
      appId: GRIDS_APP_ID,
      category: "job",
      kind: "consumer",
      event: `workflow.${event.type}`,
      attributes: {
        "cloud.grids.workflow_run_id": runId,
        "workflow.event": event.type,
        "workflow.step.action": step?.action,
        "workflow.step.key": step?.key,
        "workflow.step.kind": step?.kind,
        "workflow.step.outcome": outcome,
      },
    });
    await publishRunTraceEvent(event);
  },
};

// ─── Requesting a run ────────────────────────────────────────────────────────

export const invokeGridsWorkflow = async (input: InvokeGridsWorkflowInput): Promise<Result<WorkflowInvocationReceipt>> => {
  const locale = typeof input.context?.locale === "string" ? normalizeLocale(input.context.locale) : undefined;
  const t = workflowServiceText(locale);
  const workflow = await getWorkflow(input.workflowId);
  if (!workflow) return fail({ ...err.notFound("workflow"), message: t.workflowNotFound });
  const authorization = input.authorization ?? { kind: "workflow" };
  const claim = {
    baseId: workflow.baseId,
    workflowId: workflow.id,
    principal: input.principal,
    authorization,
    launcherId: input.launcherId,
  };
  if (!(await canExecuteWorkflow(claim))) return fail(err.forbidden(t.actorCannotRun));
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) return fail(err.badInput(t.invalidIdempotencyKey));
  const context = { ...(input.context ?? {}), ...(locale ? { locale } : {}) };
  const requestFingerprint = await workflowInvocationFingerprint({
    workflowId: workflow.id,
    mode: input.mode,
    channel: input.channel,
    principal: input.principal,
    inputs: input.inputs,
    context,
  });
  // A retry belongs to its accepted version, even if publication changed the
  // current input schema. Authorization is still checked above on every call.
  const replay = await replayWorkflowRun({
    workflow,
    mode: input.mode,
    channel: input.channel,
    eventType: EVENT_TYPE_BY_CHANNEL[input.channel],
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    context,
  });
  if (replay) return replay;
  if (input.expectedRevision !== undefined && input.expectedRevision !== workflow.revision) {
    return fail(workflowConflict(t.workflowChangedCaller));
  }
  if (input.mode === "execute" && !workflow.enabled) return fail(err.badInput(t.workflowDisabled));

  let preparedInputs: Record<string, WorkflowJsonValue>;
  try {
    preparedInputs = await prepareWorkflowInputs(
      workflow.plan,
      input.inputs,
      createWorkflowInputPreparationDeps(workflow.baseId, input.principal, {
        trustedRecordIds: input.trustedRecordIds,
        canReadTable: (tableId) => canAccessWorkflowExecutionTable(claim, tableId, "read"),
      }),
    );
  } catch (error) {
    if (error instanceof WorkflowInputPreparationError) {
      return fail(error.status === 403 ? err.forbidden(error.message) : err.badInput(error.message));
    }
    throw error;
  }

  const receipt = await startWorkflowRun({
    workflow: { id: workflow.id, baseId: workflow.baseId, revision: workflow.revision },
    mode: input.mode,
    channel: input.channel,
    eventType: EVENT_TYPE_BY_CHANNEL[input.channel],
    inputs: preparedInputs,
    context: { ...context, workflow: { id: workflow.id, shortId: workflow.shortId, name: workflow.name } },
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    principal: input.principal,
    authorization,
    launcherId: input.launcherId ?? null,
    launcherKind: LAUNCHER_KIND_BY_CHANNEL[input.channel] ?? null,
  });
  // A run appears in the list the moment it is accepted, not when a worker
  // reaches it — a button that queues work has to show something immediately.
  if (receipt.ok && receipt.data.created) await publishRunEvent(receipt.data.runId, "accepted");
  return receipt;
};

const workflowRecordEvents = createWorkflowRecordEventRuntime(invokeGridsWorkflow);

// ─── Draining what the kernel made claimable ─────────────────────────────────

/** Names this process in a run's lease. Only ever read by a human. */
const workerId = `grids:${Bun.env.HOSTNAME ?? "local"}:${process.pid}`;

/**
 * The declared actions, not a per-run port.
 *
 * Each one re-reads its run to find out who it acts as, which is what lets
 * `src/workflows.ts` be a plain vocabulary rather than a factory — and what
 * lets one port serve every run this worker claims.
 */
const declaredWorkflowActions = createWorkflowActionPort(gridsWorkflows);
const declaredWorkflowDryRunActions = createWorkflowDryRunPort(gridsWorkflows);
const builtinWorkflowActions = createWorkflowBuiltinActionPorts({
  authorize: async (context): Promise<WorkflowExecutionError | undefined> => {
    const locale = typeof context.invocation.context?.locale === "string" ? context.invocation.context.locale : undefined;
    const t = workflowServiceText(locale);
    const scope = await getWorkflowRunScope(context.run.runId);
    if (!scope) return { code: "NOT_FOUND", message: t.runUnavailable, retryable: false };
    if (await canExecuteWorkflow({ ...scope, workflowId: scope.workflow.id })) return undefined;
    return { code: "FORBIDDEN", message: t.actorCannotRun, retryable: false };
  },
});
const workflowActions: WorkflowExecuteActionPort = {
  get: (action) => declaredWorkflowActions.get(action) ?? builtinWorkflowActions.execute.get(action),
};
const workflowDryRunActions: WorkflowDryRunActionPort = {
  get: (action) => declaredWorkflowDryRunActions.get(action) ?? builtinWorkflowActions.dryRun.get(action),
};

const workflowValues = (claim: WorkflowRunClaim) =>
  createGridsWorkflowValueResolverPort(async () => {
    const scope = await getWorkflowRunScope(claim.runId);
    const locale = typeof claim.context.locale === "string" ? claim.context.locale : undefined;
    if (!scope) throw workflowConflict(workflowServiceText(locale).runUnavailable);
    return createGridsWorkflowValueResolver(scope.baseId, scope.principal, {
      canReadTable: (tableId) => canAccessWorkflowRunTable(scope, tableId, "read"),
    });
  });

const workerPorts = {
  worker: workerId,
  appId: GRIDS_APP_ID,
  module: gridsWorkflows,
  values: workflowValues,
  trace: workflowTrace,
} as const;

/**
 * Carries one named run, with the wiring the worker uses.
 *
 * The worker itself never names a run — it takes whatever the kernel has made
 * claimable — so these exist for the caller that already has one in hand and
 * wants it carried now rather than within a poll interval.
 */
export const runGridsWorkflowRun = (runId: string) => runOneWorkflow({ ...workerPorts, actions: workflowActions, runId });

export const dryRunGridsWorkflowRun = (runId?: string) =>
  dryRunOneWorkflow({ ...workerPorts, actions: workflowDryRunActions, ...(runId === undefined ? {} : { runId }) });

/**
 * One pass over this app's runs.
 *
 * `tickWorkflows` dispatches events, wakes parked runs and executes what is
 * ready. Dry runs are claimed by mode, so that loop never sees one and they are
 * drained separately — which is exactly what keeps a question from being
 * answered by doing the work.
 */
const drainWorkflowRuns = async (): Promise<void> => {
  await tickWorkflows({ ...workerPorts, actions: workflowActions });
  for (let index = 0; index < MAX_DRY_RUNS_PER_TICK; index += 1) {
    const outcome = await dryRunGridsWorkflowRun();
    if (outcome.state === "idle") break;
  }
};

// ─── Schedules and record events ─────────────────────────────────────────────

type WorkflowScheduleConfig = { cron: string; timezone: string };

const workflowScheduleConfig = (workflow: Pick<GridsWorkflow, "plan">): WorkflowScheduleConfig | null => {
  const trigger = workflow.plan.triggers.find((item) => item.kind === "schedule");
  if (!trigger) return null;
  return {
    cron: String(trigger.config.cron ?? ""),
    timezone: typeof trigger.config.timezone === "string" ? trigger.config.timezone : "UTC",
  };
};

type RegisteredWorkflowSchedule = Awaited<ReturnType<ReturnType<typeof workflowScheduler>["get"]>>;
type WorkflowScheduleRuntimeState = NonNullable<WorkflowTriggerRuntimeState["schedule"]>;

const scheduleRegistrationMatches = (registered: RegisteredWorkflowSchedule, schedule: WorkflowScheduleConfig, revision: number): boolean =>
  registered !== null &&
  registered.cron === schedule.cron &&
  registered.timezone === schedule.timezone &&
  Number(registered.meta?.revision) === revision;

export const scheduleRuntimeState = (
  workflow: Pick<GridsWorkflow, "revision" | "enabled">,
  schedule: WorkflowScheduleConfig,
  registered: RegisteredWorkflowSchedule,
): WorkflowScheduleRuntimeState => {
  if (!workflow.enabled) {
    return { ...schedule, state: "paused", nextRunAt: null, problem: null };
  }
  if (!registered || !scheduleRegistrationMatches(registered, schedule, workflow.revision)) {
    return {
      ...schedule,
      state: "pending",
      nextRunAt: null,
      problem: "The schedule is waiting for runtime reconciliation.",
    };
  }
  // failureCount only ever grows; lastError is cleared by the next successful run.
  if (registered.lastError !== undefined) {
    return {
      ...schedule,
      state: "degraded",
      nextRunAt: null,
      problem: registered.lastError,
    };
  }
  return {
    ...schedule,
    state: "reconciled",
    nextRunAt: registered.nextRunAt?.toISOString() ?? null,
    problem: null,
  };
};

const recordEventRuntimeStates = (workflow: Pick<GridsWorkflow, "enabled" | "plan">): WorkflowTriggerRuntimeState["recordEvents"] =>
  workflow.plan.triggers
    .filter((trigger) => trigger.kind === "recordEvent")
    .map((trigger) => ({
      tableId:
        typeof workflow.plan.bindings["triggers.recordEvent.table"] === "string"
          ? workflow.plan.bindings["triggers.recordEvent.table"]
          : null,
      event: typeof trigger.config.event === "string" ? trigger.config.event : "updated",
      hasFilter: trigger.config.filter !== undefined && trigger.config.filter !== null,
      state: workflow.enabled ? "active" : "paused",
    }));

export const getWorkflowTriggerRuntimeState = async (
  workflow: Pick<GridsWorkflow, "id" | "revision" | "enabled" | "plan">,
): Promise<WorkflowTriggerRuntimeState> => {
  const schedule = workflowScheduleConfig(workflow);
  const registered = schedule ? await workflowScheduler().get({ id: workflowScheduleId(workflow) }) : null;

  return {
    schedule: schedule ? scheduleRuntimeState(workflow, schedule, registered) : null,
    recordEvents: recordEventRuntimeStates(workflow),
  };
};

const workflowScheduleMatches = (workflow: Pick<GridsWorkflow, "plan">, expected: WorkflowScheduleConfig): boolean => {
  const current = workflowScheduleConfig(workflow);
  return current?.cron === expected.cron && current.timezone === expected.timezone;
};

const workflowScheduleShouldRetry = (status: number): boolean => status === 409 || status >= 500;

const registerSchedule = async (workflowId: string): Promise<void> => {
  const workflow = await getWorkflow(workflowId);
  const schedule = workflow ? workflowScheduleConfig(workflow) : null;
  if (!workflow?.enabled || !schedule) {
    await deleteWorkflowSchedules(workflowId);
    const refreshed = await getWorkflow(workflowId);
    if (refreshed?.enabled && workflowScheduleConfig(refreshed)) await registerSchedule(workflowId);
    return;
  }
  const trigger = workflow.plan.triggers.find((item) => item.kind === "schedule");
  if (!trigger) return;
  const scheduleId = workflowScheduleId(workflow);
  await workflowScheduler().create({
    id: scheduleId,
    cron: schedule.cron,
    timezone: schedule.timezone,
    meta: workflowScheduleMetadata(workflow),
    process: async (ctx) => {
      await trace.withSpan(
        {
          spanKey: trace.syncSpanKey("scheduler", "grids:workflows", ctx.runId),
          name: `Grid workflow schedule: ${workflow.name}`,
          source: scheduleId,
          appId: "grids",
          category: "schedule",
          attributes: { "cloud.grids.workflow_id": workflow.id },
        },
        async () => {
          const current = await getWorkflow(workflow.id);
          if (!current?.enabled) return { runId: "", status: "disabled" };
          const currentTrigger = current.plan.triggers.find((item) => item.kind === "schedule");
          if (!currentTrigger) return { runId: "", status: "removed" };
          if (!workflowScheduleMatches(current, schedule)) {
            // Registration is intentionally left to the external reconcile loop. Mutating this schedule inside its callback races its own persistence.
            return { runId: "", status: "stale" };
          }
          const principal: GridsWorkflowPrincipal = {
            userId: current.ownerUserId,
            groupIds: await loadWorkflowUserGroupIds(current.ownerUserId),
            serviceAccountId: null,
          };
          const slot = new Date(ctx.slot.getTime()).toISOString();
          const locale = normalizeLocale(await settingsGet<string>("app.locale"));
          const result = await invokeGridsWorkflow({
            workflowId: current.id,
            mode: "execute",
            channel: "schedule",
            inputs: evaluateWorkflowTriggerInputs({ occurredAt: slot, slot }, currentTrigger.with, slot),
            idempotencyKey: `schedule:${current.id}:${ctx.slot.getTime()}`,
            expectedRevision: current.revision,
            principal,
            occurredAt: slot,
            context: { locale },
          });
          if (!result.ok) {
            if (workflowScheduleShouldRetry(result.error.status)) throw new Error(result.error.message);
            log.warn("Scheduled workflow invocation was rejected", {
              workflowId: current.id,
              slot,
              status: result.error.status,
              error: result.error.message,
            });
            return { runId: "", status: "rejected" };
          }
          return { runId: result.data.runId, status: result.data.status };
        },
        { summarize: (result) => result },
      );
    },
  });
};

const registerWorkflowSchedules = async (
  workflows: ReadonlyArray<Pick<GridsWorkflow, "id">>,
  register: (workflowId: string) => Promise<void> = registerSchedule,
): Promise<void> => {
  for (const workflow of workflows) {
    try {
      await register(workflow.id);
    } catch (error) {
      log.warn("Could not reconcile workflow schedule", { workflowId: workflow.id, error: errorMessage(error) });
    }
  }
};

export const reconcileWorkflowRuntime = async (): Promise<void> => {
  // Only the deadline needs a nudge; whatever this re-queues the worker claims
  // on its next pass, the same as a run that was never parked.
  await wakeExpiredWorkflowRuns(100, { appId: GRIDS_APP_ID });
  const workflows = await listScheduledWorkflows();
  await registerWorkflowSchedules(workflows);
  // Snapshot the registrations BEFORE deriving the active set. A workflow another
  // pod enables in between then lands in `activeIds` (kept) rather than only in
  // `registered` (deleted). The reverse order drops a just-registered schedule.
  const registered = await workflowScheduler().list();
  const activeIds = new Set((await listScheduledWorkflows()).map(workflowScheduleId));
  for (const item of registered) {
    if (!item.id.startsWith(SCHEDULE_PREFIX) || activeIds.has(item.id)) continue;
    await workflowScheduler().delete({ id: item.id });
  }
  await workflowRecordEvents.reconcile();
};

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let workerTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;
let runtimeEventController: AbortController | null = null;
let runtimeEventTask: Promise<void> | null = null;
const workflowRuntimeTasks = createRuntimeTaskTracker();

const applyWorkflowRuntimeEvent = async <T>(event: { cursor: string; data: T }, apply: (data: T) => Promise<void>): Promise<string> => {
  await apply(event.data);
  return event.cursor;
};

const startRuntimeEventReader = (after: string | null): void => {
  if (runtimeEventTask) return;
  runtimeEventController = new AbortController();
  const signal = runtimeEventController.signal;
  runtimeEventTask = workflowRuntimeTasks.run(async () => {
    let cursor = after ?? undefined;
    while (!signal.aborted) {
      try {
        if (!cursor) {
          cursor = await latestWorkflowRuntimeEventCursor();
          await reconcileWorkflowRuntime();
        }
        for await (const event of liveWorkflowRuntimeEvents({ after: cursor, signal })) {
          cursor = await applyWorkflowRuntimeEvent(event, async (data) => {
            await Promise.all([registerSchedule(data.workflowId), workflowRecordEvents.reconcile()]);
          });
        }
      } catch (error) {
        if (signal.aborted) return;
        log.warn("Workflow runtime event reader failed", { error: errorMessage(error) });
        if (error instanceof RetentionGapError || error instanceof CursorMismatchError) {
          // Capture a new baseline before rebuilding registrations from Postgres.
          cursor = undefined;
        }
        await Bun.sleep(1_000);
      }
    }
  });
  if (!runtimeEventTask) throw new Error("Workflow runtime is not accepting event readers");
};

const workflowRuntimeLifecycle = createRuntimeLifecycle({
  start: async () => {
    workflowRuntimeTasks.open();
    const eventCursor = await latestWorkflowRuntimeEventCursor().catch((error) => {
      log.warn("Could not initialize workflow runtime event reader", { error: errorMessage(error) });
      return null;
    });
    await reconcileWorkflowRuntime();
    await workflowScheduler().create({
      id: "grids:evidence-export-cleanup",
      cron: "17 * * * *",
      timezone: "UTC",
      process: cleanupExpiredEvidenceExports,
    });
    await workflowScheduler().create({
      id: "grids:controlled-destruction-reconcile",
      cron: "41 * * * *",
      timezone: "UTC",
      process: async (context) => {
        await reconcileStuckControlledDestructionRuns(context);
      },
    });
    scheduleWorker = await workflowScheduler().process();
    startRuntimeEventReader(eventCursor);
    workerTimer = setInterval(() => {
      // A tick that outlives the interval must not start a second one: two
      // overlapping drains would claim each other's runs and fight the lease.
      if (draining) return;
      draining = true;
      const task = workflowRuntimeTasks.run(async () => {
        await drainWorkflowRuns().catch((error) => log.warn("Workflow worker tick failed", { error: errorMessage(error) }));
      });
      if (task) void task.finally(() => (draining = false));
      else draining = false;
    }, WORKER_INTERVAL_MS);
    reconcileTimer = setInterval(() => {
      workflowRuntimeTasks.run(async () => {
        await reconcileWorkflowRuntime().catch((error) => log.warn("Workflow runtime reconcile failed", { error: errorMessage(error) }));
      });
    }, RECONCILE_INTERVAL_MS);
  },
  stop: async () => {
    if (workerTimer) clearInterval(workerTimer);
    workerTimer = null;
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    runtimeEventController?.abort();
    await stopRuntimeResources([
      async () => {
        workflowRuntimeTasks.close();
        await workflowRuntimeTasks.drain();
      },
      () => workflowRecordEvents.stop(),
      async () => {
        await scheduleWorker?.drain({ timeoutMs: 30_000 });
        scheduleWorker = undefined;
      },
    ]);
    draining = false;
    runtimeEventController = null;
    runtimeEventTask = null;
  },
});

export const startWorkflowRuntime = workflowRuntimeLifecycle.start;
export const stopWorkflowRuntime = workflowRuntimeLifecycle.stop;
