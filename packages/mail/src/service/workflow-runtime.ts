import { env } from "@k2b/cloud/config";
import { createRuntimeLifecycle, logger } from "@k2b/cloud/services";
import {
  AI_WORKFLOW_ACTIONS,
  createWorkflowBuiltinActionPorts,
  type WorkflowExecutionError,
  type WorkflowJsonValue,
} from "@k2b/cloud/workflows";
import { startWorkflowAiRuntime, stopWorkflowAiRuntime } from "@k2b/cloud/workflows/ai";
import type { WorkflowExecuteActionPort, WorkflowTracePort } from "@k2b/cloud/workflows/runtime";
import {
  createWorkflowActionPort,
  createWorkflowWorker,
  runOneWorkflow,
  tickWorkflows,
  type WorkflowRunClaim,
  wakeExpiredWorkflowRuns,
} from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { authorizeMailWorkflowExecution, MAIL_WORKFLOW_ACTIONS } from "../workflows/actions";
import { MAIL_WORKFLOW_APP_ID } from "../workflows/events";
import { mailWorkflows } from "../workflows/module";
import { recordMailWorkflowAudit } from "./automation-log-recording";
import { renderMailWorkflowTemplate } from "./template-rendering";
import { publishMailWorkflowCollaborationEventFromOutput } from "./workflow-collaboration-events";
import type { FrozenMailWorkflowSource } from "./workflow-data";
import {
  createMailWorkflowProjectedState,
  rebindMailWorkflowRestoredOutput,
  restoreMailWorkflowProjectedState,
} from "./workflow-projected-state";
import {
  createMailWorkflowValueResolver,
  normalizeMailWorkflowFrozenHydration,
  projectMailWorkflowFrozenMessage,
} from "./workflow-runtime-values";
import { startMailWorkflowScheduleRuntime, stopMailWorkflowScheduleRuntime } from "./workflow-schedule-runtime";
import { resolveMailWorkflowTemplateBodies } from "./workflow-template-values";

const auditLog = logger("mail:automation-log");
const workerId = `mail:${env.HOSTNAME ?? "local"}:${process.pid}`;
const inputReadiness = new WeakMap<Record<string, WorkflowJsonValue>, Promise<Record<string, WorkflowJsonValue>>>();

const mailActionNames = new Set(Object.keys(MAIL_WORKFLOW_ACTIONS));
const aiActionNames = new Set(Object.keys(AI_WORKFLOW_ACTIONS));
const declaredActions = createWorkflowActionPort(mailWorkflows, {
  authorize: (context, step) => (aiActionNames.has(step.action) ? authorizeMailWorkflowExecution(context) : Promise.resolve(true)),
});
const builtins = createWorkflowBuiltinActionPorts({
  authorize: async (context): Promise<WorkflowExecutionError | undefined> => {
    const [active] = await sql<{ active: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM workflows.run run
        JOIN workflows.workflow workflow
          ON workflow.id = run.workflow_id
         AND workflow.active_version_id = run.workflow_version_id
        JOIN mail.workflow_profile profile
          ON profile.id = workflow.id
         AND profile.enabled
        WHERE run.id = ${context.run.runId}::uuid
      ) AS active
    `;
    return active?.active ? undefined : { code: "FORBIDDEN", message: "Workflow is no longer active.", retryable: false };
  },
  renderText: ({ context, value }) =>
    renderMailWorkflowTemplate({ invocation: context.invocation, variableSnapshot: () => context.variables.snapshot?.() ?? {} }, value),
});
// Resolve before entering an action transaction: freezing locks workflows.run in its own transaction.
const actions: WorkflowExecuteActionPort = {
  get: (name) => {
    const declared = declaredActions.get(name);
    const action = declared ?? builtins.execute.get(name);
    if (!action) return undefined;
    const handler = declared ? action : rebindMailWorkflowRestoredOutput(action);
    return {
      execute: async (ctx, step) => {
        await inputReadiness.get(ctx.invocation.inputs);
        await resolveMailWorkflowTemplateBodies(ctx, step);
        const outcome = await handler.execute(ctx, step);
        if (declared && outcome.state === "completed") await publishMailWorkflowCollaborationEventFromOutput(outcome.output);
        return outcome;
      },
      restoreCompleted: async (ctx, step, outcome) => {
        await inputReadiness.get(ctx.invocation.inputs);
        await handler.restoreCompleted?.(ctx, step, outcome);
        if (declared) {
          await restoreMailWorkflowProjectedState(ctx, step, outcome);
          await publishMailWorkflowCollaborationEventFromOutput(outcome.output);
        }
      },
    };
  },
};

const values = (claim: WorkflowRunClaim) => {
  // The kernel invocation retains these claim object references, so preparing
  // them in the per-claim resolver factory also prepares the action context.
  const source = claim.context.source;
  const projected = createMailWorkflowProjectedState(
    claim.plan,
    source && typeof source === "object" && !Array.isArray(source) ? (source as unknown as FrozenMailWorkflowSource) : {},
    claim.inputs,
  );
  for (const key of Object.keys(claim.inputs)) delete claim.inputs[key];
  Object.assign(claim.inputs, projected.inputs);
  claim.context.source = projected.source as unknown as WorkflowJsonValue;

  const frozen = sql<{ frozen_hydration: Record<string, WorkflowJsonValue> | string }[]>`
    SELECT frozen_hydration
    FROM mail.workflow_run_state
    WHERE run_id = ${claim.runId}::uuid
  `.then((rows) => {
    const value = rows[0]?.frozen_hydration;
    const hydration: Record<string, WorkflowJsonValue> = typeof value === "string" ? JSON.parse(value) : (value ?? {});
    normalizeMailWorkflowFrozenHydration(hydration);
    for (const input of claim.plan.inputs) {
      if (input.type === "mailMessage") projectMailWorkflowFrozenMessage(input.name, claim.inputs[input.name], hydration);
    }
    return hydration;
  });
  // Steps and the resolver await this promise and see a load failure; a run that never awaits it must not crash the worker.
  frozen.catch(() => {});
  inputReadiness.set(claim.inputs, frozen);
  return {
    resolve: async (input: Parameters<ReturnType<typeof createMailWorkflowValueResolver>["resolve"]>[0]) => {
      return createMailWorkflowValueResolver({
        claim,
        mailboxId: claim.scopeId,
        frozenHydration: await frozen,
        mailActionNames,
      }).resolve(input);
    },
  };
};

const workerPorts = { worker: workerId, appId: MAIL_WORKFLOW_APP_ID, module: mailWorkflows, values } as const;

const auditTrace = (forward?: WorkflowTracePort): WorkflowTracePort => ({
  emit: async (event) => {
    await forward?.emit(event);
    const runId = "run" in event ? event.run.runId : event.step.runId;
    if (event.type === "step.finished" || event.type === "step.restored" || event.type === "run.finished") {
      try {
        await recordMailWorkflowAudit(runId);
      } catch (error) {
        auditLog.error("Automation log projection failed; recovery will retry", { runId, error: String(error) });
      }
    }
  },
});

const recoverAudit = async (): Promise<void> => {
  const runs = await sql<{ id: string; updated_at: string }[]>`SELECT run.id, run.updated_at::text AS updated_at FROM workflows.run run
    LEFT JOIN mail.workflow_run_state snapshot ON snapshot.run_id = run.id
    WHERE run.app_id = 'mail' AND run.mode = 'execute' AND run.state IN ('succeeded', 'failed', 'canceled', 'needs_attention')
      AND run.created_at > now() - interval '30 days'
      AND (snapshot.audit_updated_at IS NULL OR snapshot.audit_updated_at < run.updated_at)
    ORDER BY run.updated_at, run.id LIMIT 100`;
  for (const run of runs) {
    try {
      await recordMailWorkflowAudit(run.id);
      await sql`INSERT INTO mail.workflow_run_state (run_id, audit_updated_at)
      SELECT id, ${run.updated_at}::timestamptz FROM workflows.run WHERE id = ${run.id}::uuid
      ON CONFLICT (run_id) DO UPDATE SET audit_updated_at = EXCLUDED.audit_updated_at`;
    } catch (error) {
      auditLog.error("Automation log recovery failed; later runs will still be repaired", { runId: run.id, error: String(error) });
    }
  }
};

export const runMailWorkflow = (runId: string, trace?: WorkflowTracePort) =>
  runOneWorkflow({ ...workerPorts, actions, runId, trace: auditTrace(trace) });

const worker = createWorkflowWorker({
  appId: MAIL_WORKFLOW_APP_ID,
  concurrency: 2,
  recover: async () => {
    await tickWorkflows({ ...workerPorts, actions, maxRuns: 0 });
    await recoverAudit();
  },
  run: async () => (await runOneWorkflow({ ...workerPorts, actions, trace: auditTrace() })).state !== "idle",
});

const lifecycle = createRuntimeLifecycle({
  start: async () => {
    try {
      await startWorkflowAiRuntime();
      await startMailWorkflowScheduleRuntime();
      await wakeExpiredWorkflowRuns(100, { appId: MAIL_WORKFLOW_APP_ID });
      await worker.start();
    } catch (error) {
      await stopMailWorkflowScheduleRuntime();
      stopWorkflowAiRuntime();
      await worker.stop();
      throw error;
    }
  },
  stop: async () => {
    await worker.stop();
    await stopMailWorkflowScheduleRuntime();
    stopWorkflowAiRuntime();
  },
});

export const workflowRuntime = { start: lifecycle.start, stop: lifecycle.stop };
