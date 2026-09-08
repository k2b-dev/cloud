import { expBackoff, isRetryableTransportError, retry } from "@k2b/sync/retry";
import { lazySync } from "@valentinkolb/cloud";
import { ratelimit } from "@valentinkolb/cloud/server";
import { defineWorkflowModule, type WorkflowBoundPlan, workflowAction } from "@valentinkolb/cloud/workflows";
import { bindWorkflow, compileWorkflow } from "@valentinkolb/cloud/workflows/language";
import {
  createWorkflowScheduleRegistration,
  reconcileWorkflowSchedules,
  type WorkflowScheduleRegistration,
  workflowScheduleSlotKey,
} from "@valentinkolb/cloud/workflows/runtime";
import {
  createWorkflow,
  createWorkflowActionPort,
  emitWorkflowEvent,
  getWorkflowRun,
  listStrandedWorkflowEffects,
  listWorkflowRuns,
  publishWorkflowVersion,
  requestWorkflowRunCancel,
  resolveWorkflowRunAttention,
  WORKFLOW_RUN_LEASE_MS,
  WORKFLOW_RUN_MAX_CONSECUTIVE_FAILURES,
  type WorkflowActivationInput,
} from "@valentinkolb/cloud/workflows/store";
import { directOnlyProcessFixture, runWorkflowProcessFixture } from "@valentinkolb/cloud/workflows/testing";
import type { SQL } from "bun";

export const inventoryJobs = lazySync((sync) =>
  sync.job<{ itemId: string }>({
    id: "inventory.reindex",
    delivery: { maxAttempts: 4, backoffMs: [1_000, 5_000, 30_000] },
  }),
);
export const startInventoryJobs = (rebuildIndex: (itemId: string) => Promise<void>) =>
  inventoryJobs().process({ concurrency: 2 }, async (context) => {
    await rebuildIndex(context.input.itemId);
  });

export const fetchInventoryWithRetry = (signal: AbortSignal) =>
  retry({
    run: () => fetch("https://inventory.example.com/items", { signal }),
    after: ({ ctx }) => {
      if (ctx.error && ctx.attempt < 3 && isRetryableTransportError(ctx.error)) {
        ctx.reschedule({ delayMs: ctx.expBackoff() });
      }
    },
    signal,
  });

export const nextRetryDelay = (attempt: number) => expBackoff(attempt, { baseMs: 500, maxMs: 30_000 });

export const inventoryQueue = lazySync((sync) =>
  sync.queue<{ itemId: string }>({
    id: "inventory.imports",
  }),
);

export const inventoryTopic = lazySync((sync) =>
  sync.topic<{ itemId: string }>({
    id: "inventory.events",
    retention: { maxAgeMs: 7 * 24 * 60 * 60_000, maxBytes: 64 * 1024 * 1024 },
  }),
);

export const inventoryPresence = lazySync((sync) =>
  sync.ephemeral<{ userId: string }>({
    id: "inventory.editors",
    ttlMs: 30_000,
  }),
);

export const inventoryMutex = lazySync((sync) =>
  sync.mutex({
    id: "inventory.stock",
    ttlMs: 10_000,
  }),
);

export const inventoryRateLimit = ratelimit({
  id: "inventory.exports",
  limit: 10,
  windowSecs: 60,
});

export const inventoryScheduler = lazySync((sync) => sync.scheduler({ id: "inventory", delivery: { maxAttempts: 1 } }));

export const INVENTORY_EVENT = { itemChanged: "inventory.itemChanged" } as const;

export const INVENTORY_ACTIONS = {
  loadItem: workflowAction.pure({
    label: "Load item",
    description: "Loads an inventory item.",
    config: {
      kind: "object",
      properties: { itemId: { kind: "string" } },
    },
    run: async (_ctx, config) => ({
      state: "succeeded",
      output: { itemId: config.itemId },
    }),
  }),
};

export const inventoryWorkflows = defineWorkflowModule({
  id: "inventory",
  version: 1,
  inputs: [
    {
      kind: "text",
      label: "Text",
      description: "A text value supplied to the workflow.",
      valueType: "core.string",
      config: {
        kind: "object",
        properties: {
          required: { kind: "boolean", optional: true },
        },
      },
    },
  ],
  triggers: [
    {
      kind: "itemChanged",
      label: "Item changed",
      description: "Starts when an inventory item changes.",
      eventValues: { itemId: "core.string" },
      config: { kind: "object", properties: {} },
    },
  ],
  actions: INVENTORY_ACTIONS,
  limits: {
    maxInputs: 20,
    maxSteps: 200,
    maxDepth: 20,
    maxConditions: 200,
    maxConditionDepth: 20,
    maxLoopItems: 500,
  },
});

export const inventoryWorkflowActions = createWorkflowActionPort(inventoryWorkflows);

export const inventoryWorkflowSource = `inputs:
  itemId:
    type: text
    required: true
triggers:
  itemChanged:
    with:
      itemId: "\${{ trigger.itemId }}"
steps:
  - loadItem:
      itemId: "\${{ inputs.itemId }}"
`;

const inventoryWorkflowActivations = (plan: WorkflowBoundPlan): WorkflowActivationInput[] =>
  plan.triggers.map((trigger, index) => ({
    key: `${trigger.kind}:${index}`,
    eventType: `inventory.${trigger.kind}`,
    config: { ...trigger.config, with: trigger.with },
  }));

export const compileAndBindInventoryWorkflow = async (source: string) => {
  const compiled = await compileWorkflow(source, inventoryWorkflows);
  if (!compiled.ok) return compiled;
  const plan = await bindWorkflow(compiled.ir, inventoryWorkflows, async () => ({
    catalog: {},
    bindings: {},
  }));
  return { ok: true as const, plan };
};

export const publishInventoryWorkflow = async (input: { db: SQL; scopeId: string; source: string; actorId: string }) => {
  const validation = await compileAndBindInventoryWorkflow(input.source);
  if (!validation.ok) throw new Error(validation.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  const plan = validation.plan;
  const workflow = await createWorkflow(
    {
      appId: "inventory",
      scopeId: input.scopeId,
      key: "restock",
      name: "Restock inventory",
      author: { kind: "user", id: input.actorId },
    },
    { db: input.db },
  );
  return publishWorkflowVersion(
    {
      workflowId: workflow.id,
      source: input.source,
      plan,
      author: { kind: "user", id: input.actorId },
      activations: inventoryWorkflowActivations(plan),
    },
    { db: input.db },
  );
};

export const emitItemChanged = (warehouseId: string, itemId: string, version: number) =>
  emitWorkflowEvent({
    appId: "inventory",
    scopeId: warehouseId,
    type: "inventory.itemChanged",
    data: { itemId },
    dedupeKey: `item:${itemId}:${version}`,
  });

export const inspectInventoryWorkflowRuns = (warehouseId: string) =>
  listWorkflowRuns({
    appId: "inventory",
    scopeId: warehouseId,
    includeChildren: false,
    limit: 50,
  });

export const inspectInventoryWorkflowRun = (runId: string) => getWorkflowRun(runId);

export const inspectStrandedInventoryWorkflowEffects = () =>
  listStrandedWorkflowEffects({
    appId: "inventory",
    olderThanMs: WORKFLOW_RUN_LEASE_MS,
    limit: 100,
  });

export const inventoryWorkflowRecoveryLimits = {
  leaseMs: WORKFLOW_RUN_LEASE_MS,
  maxConsecutiveFailures: WORKFLOW_RUN_MAX_CONSECUTIVE_FAILURES,
};

export const cancelInventoryWorkflowRun = (runId: string) => requestWorkflowRunCancel(runId);

export const resolveInventoryWorkflowEffect = (runId: string, stepKey: string) =>
  resolveWorkflowRunAttention({
    runId,
    stepKey,
    resolution: {
      state: "failed",
      code: "INVENTORY_PROVIDER_REJECTED",
      message: "The inventory provider confirmed that the operation failed.",
    },
  });

export const inventoryWorkflowSchedule = (workflowId: string, revision: string) =>
  createWorkflowScheduleRegistration({
    namespace: "inventory",
    workflowId,
    triggerId: "morning",
    revision,
    cron: "0 8 * * *",
    timezone: "Europe/Berlin",
  });

export const reconcileInventoryWorkflowSchedules = (desired: WorkflowScheduleRegistration[], current: WorkflowScheduleRegistration[]) =>
  reconcileWorkflowSchedules({
    desired,
    current,
    port: {
      create: async () => undefined,
      update: async () => undefined,
      register: async () => undefined,
      remove: async () => undefined,
    },
  });

export const inventoryWorkflowScheduleEventKey = (registrationId: string, slot: Date) =>
  workflowScheduleSlotKey(registrationId, slot.toISOString());

export const runDirectWorkflowProcessFixture = () => runWorkflowProcessFixture(directOnlyProcessFixture);
