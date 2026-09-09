import type { Scheduler, Worker } from "@k2b/sync";
import { lazySync } from "@k2b/cloud";
import { createRuntimeLifecycle, logger, trace } from "@k2b/cloud/services";
import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import {
  createWorkflowScheduleRegistration,
  evaluateWorkflowTriggerInputs,
  reconcileWorkflowSchedules,
  type WorkflowScheduleRegistration,
  workflowScheduleSlotKey,
} from "@k2b/cloud/workflows/runtime";
import { emitWorkflowEvent } from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { MAIL_WORKFLOW_APP_ID, MAIL_WORKFLOW_EVENT } from "../workflows/events";

const SCHEDULER_ID = "mail:workflow-schedules";
const SCHEDULE_PREFIX = "mail:workflow-schedule:";
const log = logger("mail:workflow-schedules");

type DbActivation = {
  activation_id: string;
  workflow_id: string;
  workflow_version_id: string;
  mailbox_id: string;
  workflow_name: string;
  revision: number;
  trigger_key: string;
  trigger_config: Record<string, WorkflowJsonValue> | string;
};

export type MailWorkflowScheduleActivation = {
  activationId: string;
  workflowVersionId: string;
  mailboxId: string;
  workflowName: string;
  config: Record<string, WorkflowJsonValue>;
  registration: WorkflowScheduleRegistration;
};

const parseJson = <T>(value: T | string): T => (typeof value === "string" ? (JSON.parse(value) as T) : value);

export const mailWorkflowScheduleRegistration = (input: {
  workflowId: string;
  triggerKey: string;
  revision: number;
  cron: string;
  timezone: string;
}): WorkflowScheduleRegistration => {
  const registration = createWorkflowScheduleRegistration({
    namespace: "mail",
    workflowId: input.workflowId,
    triggerId: input.triggerKey,
    revision: String(input.revision),
    cron: input.cron,
    timezone: input.timezone,
  });
  return { ...registration, id: `${SCHEDULE_PREFIX}${registration.id}` };
};

const mapActivation = (row: DbActivation): MailWorkflowScheduleActivation => {
  const config = parseJson(row.trigger_config);
  if (typeof config.cron !== "string") throw new Error(`Mail workflow schedule ${row.activation_id} has no cron expression`);
  return {
    activationId: row.activation_id,
    workflowVersionId: row.workflow_version_id,
    mailboxId: row.mailbox_id,
    workflowName: row.workflow_name,
    config,
    registration: mailWorkflowScheduleRegistration({
      workflowId: row.workflow_id,
      triggerKey: row.trigger_key,
      revision: row.revision,
      cron: config.cron,
      timezone: typeof config.timezone === "string" ? config.timezone : "UTC",
    }),
  };
};

const activationColumns = sql`
  activation.id::text AS activation_id,
  activation.workflow_id::text,
  activation.workflow_version_id::text,
  profile.mailbox_id::text,
  workflow.name AS workflow_name,
  version.revision,
  activation.key AS trigger_key,
  activation.config AS trigger_config
`;

const listActive = async (): Promise<MailWorkflowScheduleActivation[]> => {
  const rows = await sql<DbActivation[]>`
    SELECT ${activationColumns}
    FROM workflows.activation activation
    JOIN workflows.workflow workflow
      ON workflow.id = activation.workflow_id
     AND workflow.active_version_id = activation.workflow_version_id
    JOIN workflows.version version ON version.id = activation.workflow_version_id
    JOIN mail.workflow_profile profile ON profile.id = workflow.id AND profile.enabled
    WHERE activation.event_type = ${MAIL_WORKFLOW_EVENT.schedule}
      AND activation.enabled
    ORDER BY activation.workflow_id, activation.key, activation.id
  `;
  return rows.flatMap((row) => {
    try {
      return [mapActivation(row)];
    } catch (error) {
      log.warn("Ignoring invalid Mail workflow schedule", {
        activationId: row.activation_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });
};

const loadCurrent = async (registration: WorkflowScheduleRegistration): Promise<MailWorkflowScheduleActivation | null> => {
  const [row] = await sql<DbActivation[]>`
    SELECT ${activationColumns}
    FROM workflows.activation activation
    JOIN workflows.workflow workflow
      ON workflow.id = activation.workflow_id
     AND workflow.active_version_id = activation.workflow_version_id
    JOIN workflows.version version ON version.id = activation.workflow_version_id
    JOIN mail.workflow_profile profile ON profile.id = workflow.id AND profile.enabled
    WHERE activation.workflow_id = ${registration.workflowId}::uuid
      AND activation.key = ${registration.triggerId}
      AND activation.event_type = ${MAIL_WORKFLOW_EVENT.schedule}
      AND activation.enabled
  `;
  return row ? mapActivation(row) : null;
};

const currentRegistration = (item: Awaited<ReturnType<Scheduler["list"]>>[number]): WorkflowScheduleRegistration => ({
  id: item.id,
  namespace: typeof item.meta?.namespace === "string" ? item.meta.namespace : "mail",
  workflowId: typeof item.meta?.workflowId === "string" ? item.meta.workflowId : item.id,
  triggerId: typeof item.meta?.triggerId === "string" ? item.meta.triggerId : "stale",
  revision: typeof item.meta?.revision === "string" ? item.meta.revision : "stale",
  schedule: { cron: item.cron, timezone: item.timezone },
});

const transport = lazySync((sync) =>
  sync.scheduler({ id: SCHEDULER_ID, delivery: { maxAttempts: 5, backoffMs: [5_000, 20_000, 60_000, 120_000] } }),
);
let transportWorker: Worker | undefined;

const register = async (registration: WorkflowScheduleRegistration, activation: MailWorkflowScheduleActivation): Promise<void> => {
  await transport().create({
    id: registration.id,
    cron: registration.schedule.cron,
    timezone: registration.schedule.timezone,
    meta: {
      appId: MAIL_WORKFLOW_APP_ID,
      family: SCHEDULER_ID,
      label: `Workflow: ${activation.workflowName}`,
      namespace: registration.namespace,
      source: SCHEDULER_ID,
      resourceLabel: activation.workflowName,
      workflowId: registration.workflowId,
      workflowVersionId: activation.workflowVersionId,
      revision: registration.revision,
      triggerId: registration.triggerId,
    },
    process: async (ctx) => {
      const spanKey = trace.syncSpanKey("scheduler", SCHEDULER_ID, ctx.runId);
      await trace.start({
        name: `Mail workflow schedule: ${activation.workflowName}`,
        source: SCHEDULER_ID,
        appId: MAIL_WORKFLOW_APP_ID,
        category: "schedule",
        spanKey,
        attributes: { "cloud.mail.workflow_id": registration.workflowId },
      });
      const current = await loadCurrent(registration);
      if (!current || current.registration.revision !== registration.revision) {
        await trace.end({ spanKey, summary: { runId: null, status: "stale" } });
        return;
      }
      const slot = new Date(ctx.slot).toISOString();
      const triggerValues = { occurredAt: slot, slot };
      const withValues = isJsonObject(current.config.with) ? current.config.with : {};
      const emission = await emitWorkflowEvent(
        {
          appId: MAIL_WORKFLOW_APP_ID,
          scopeId: current.mailboxId,
          type: MAIL_WORKFLOW_EVENT.schedule,
          targetWorkflowId: registration.workflowId,
          data: evaluateWorkflowTriggerInputs(triggerValues, withValues, slot),
          dedupeKey: workflowScheduleSlotKey(registration.id, slot),
          occurredAt: new Date(slot),
        },
        { dispatch: "now" },
      );
      await trace.end({ spanKey, summary: { runId: emission.runIds[0] ?? null, status: emission.runIds.length ? "queued" : "ignored" } });
    },
  });
};

const isJsonObject = (value: WorkflowJsonValue | undefined): value is Record<string, WorkflowJsonValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const reconcileMailWorkflowSchedules = async (): Promise<void> => {
  const activations = await listActive();
  const desired = activations.map((item) => item.registration);
  const byId = new Map(activations.map((item) => [item.registration.id, item]));
  const current = (await transport().list()).filter((item) => item.id.startsWith(SCHEDULE_PREFIX)).map(currentRegistration);
  await reconcileWorkflowSchedules({
    desired,
    current,
    port: {
      create: (registration) => register(registration, byId.get(registration.id)!),
      update: (_current, registration) => register(registration, byId.get(registration.id)!),
      register: (registration) => register(registration, byId.get(registration.id)!),
      remove: async (registration) => {
        await transport().delete({ id: registration.id });
      },
    },
  });
};

const lifecycle = createRuntimeLifecycle({
  start: async () => {
    await reconcileMailWorkflowSchedules();
    transportWorker = await transport().process();
  },
  stop: async () => {
    await transportWorker?.drain();
    transportWorker = undefined;
  },
});

export const startMailWorkflowScheduleRuntime = lifecycle.start;
export const stopMailWorkflowScheduleRuntime = lifecycle.stop;
