import { env } from "@k2b/cloud/config";
import { createRuntimeLifecycle } from "@k2b/cloud/services";
import { AI_WORKFLOW_ACTIONS, createWorkflowBuiltinActionPorts, type WorkflowExecutionError } from "@k2b/cloud/workflows";
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
import { authorizeMailWorkflowExecution } from "../workflows/actions";
import { MAIL_WORKFLOW_APP_ID } from "../workflows/events";
import { mailWorkflows } from "../workflows/module";
import { renderMailLiquidTemplate } from "./template-rendering";
import { publishMailWorkflowCollaborationEventFromOutput } from "./workflow-collaboration-events";
import type { FrozenMailWorkflowSource } from "./workflow-data";
import { createMailWorkflowProjectedState, restoreMailWorkflowProjectedState } from "./workflow-projected-state";
import { createMailWorkflowValueResolver } from "./workflow-runtime-values";
import { startMailWorkflowScheduleRuntime, stopMailWorkflowScheduleRuntime } from "./workflow-schedule-runtime";

const workerId = `mail:${env.HOSTNAME ?? "local"}:${process.pid}`;

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
  renderText: ({ context, value }) => {
    const rendered = renderMailLiquidTemplate(
      value,
      {
        inputs: context.invocation.inputs,
        context: {
          ...(context.invocation.context ?? {}),
          actor: context.invocation.actor,
          occurredAt: context.invocation.occurredAt,
        },
        ...(context.variables.snapshot?.() ?? {}),
      },
      "text",
    );
    if (!rendered.ok) throw rendered.error;
    return rendered.data;
  },
});
const actions: WorkflowExecuteActionPort = {
  get: (name) => {
    const declared = declaredActions.get(name);
    if (!declared) return builtins.execute.get(name);
    return {
      execute: async (ctx, step) => {
        const outcome = await declared.execute(ctx, step);
        if (outcome.state === "completed") await publishMailWorkflowCollaborationEventFromOutput(outcome.output);
        return outcome;
      },
      restoreCompleted: async (ctx, step, outcome) => {
        await declared.restoreCompleted?.(ctx, step, outcome);
        await restoreMailWorkflowProjectedState(ctx, step, outcome);
        await publishMailWorkflowCollaborationEventFromOutput(outcome.output);
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
  claim.context.source = projected.source as unknown as import("@k2b/cloud/workflows").WorkflowJsonValue;

  let frozen: Promise<Record<string, import("@k2b/cloud/workflows").WorkflowJsonValue>> | null = null;
  return {
    resolve: async (input: Parameters<ReturnType<typeof createMailWorkflowValueResolver>["resolve"]>[0]) => {
      frozen ??= sql<{ frozen_hydration: Record<string, import("@k2b/cloud/workflows").WorkflowJsonValue> | string }[]>`
        SELECT frozen_hydration
        FROM mail.workflow_run_state
        WHERE run_id = ${claim.runId}::uuid
      `.then((rows) => {
        const value = rows[0]?.frozen_hydration;
        return typeof value === "string" ? JSON.parse(value) : (value ?? {});
      });
      return createMailWorkflowValueResolver({
        claim,
        mailboxId: claim.scopeId,
        frozenHydration: await frozen,
      }).resolve(input);
    },
  };
};

const workerPorts = { worker: workerId, appId: MAIL_WORKFLOW_APP_ID, module: mailWorkflows, values } as const;

export const runMailWorkflow = (runId: string, trace?: WorkflowTracePort) =>
  runOneWorkflow({ ...workerPorts, actions, runId, ...(trace ? { trace } : {}) });

const worker = createWorkflowWorker({
  appId: MAIL_WORKFLOW_APP_ID,
  concurrency: 2,
  recover: () => tickWorkflows({ ...workerPorts, actions, maxRuns: 0 }),
  run: async () => (await runOneWorkflow({ ...workerPorts, actions })).state !== "idle",
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
