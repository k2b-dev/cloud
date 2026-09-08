import type { Result } from "@k2b/stdlib";
import type { QueueMessage, Worker } from "@k2b/sync";
import { logger } from "@valentinkolb/cloud/services";
import { get as settingsGet } from "@valentinkolb/cloud/services/settings";
import { normalizeLocale, normalizeTimeZone } from "@valentinkolb/cloud/shared";
import type { WorkflowInvocationReceipt, WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { workflowPathKey } from "@valentinkolb/cloud/workflows";
import { evaluateWorkflowTriggerInputs } from "@valentinkolb/cloud/workflows/runtime";
import { sql } from "bun";
import type { FilterTree } from "../contracts";
import type { GridsWorkflow } from "../workflows/contracts";
import { listByTable as listFields } from "./fields";
import { compileFilter, renderClause } from "./filter-compiler";
import { getRecordEventDeliveryFailure, recordRecordEventDeliveryFailure } from "./record-event-delivery-failures";
import { redriveRecordEventOutbox } from "./record-event-outbox";
import {
  type GridsRecordEvent,
  GridsRecordEventSchema,
  publishRecordEvent,
  RECORD_EVENT_WORK_LEASE_MS,
  RECORD_EVENT_WORK_MAX_ATTEMPTS,
  RECORD_EVENT_WORK_PARTITIONS,
  recordEventWorkQueue,
  requeueRecordEventWork,
} from "./record-events";
import { listRecordEventWorkflows } from "./workflow-definitions";
import { type GridsWorkflowPrincipal, loadWorkflowUserGroupIds } from "./workflow-values";

const log = logger("grids:workflow-record-events");
const CONSUMER_GROUP = "workflow-kernel-queue-v1";
const LEASE_HEARTBEAT_MS = Math.floor(RECORD_EVENT_WORK_LEASE_MS / 3);
const DELIVERY_FAILURE_BASE_FOREIGN_KEY = "record_event_delivery_failures_base_id_fkey";

export const isDeletedRecordEventBaseError = (error: unknown): boolean => {
  const postgresError = error as { code?: string; errno?: string; constraint?: string; constraint_name?: string; message?: string } | null;
  if (postgresError?.code !== "23503" && postgresError?.errno !== "23503") return false;
  const constraint = postgresError.constraint ?? postgresError.constraint_name;
  return constraint === DELIVERY_FAILURE_BASE_FOREIGN_KEY || postgresError.message?.includes(DELIVERY_FAILURE_BASE_FOREIGN_KEY) === true;
};

export type WorkflowRecordEventDeliveryPorts = {
  recordFailure: typeof recordRecordEventDeliveryFailure;
  requeue: typeof requeueRecordEventWork;
};

const defaultPorts: WorkflowRecordEventDeliveryPorts = {
  recordFailure: recordRecordEventDeliveryFailure,
  requeue: requeueRecordEventWork,
};

export const replayWorkflowRecordEventDeliveryFailure = async (baseId: string, id: string): Promise<boolean> => {
  const failure = await getRecordEventDeliveryFailure(baseId, id);
  if (!failure?.payload) return false;
  if (failure.consumerGroup === "record-event-outbox") return redriveRecordEventOutbox(failure.eventId);
  let payload: unknown;
  try {
    payload = JSON.parse(failure.payload);
  } catch {
    return false;
  }
  const event = GridsRecordEventSchema.safeParse(payload);
  if (!event.success || event.data.baseId !== baseId) return false;
  await publishRecordEvent(event.data, { replayKey: Bun.randomUUIDv7() });
  return true;
};

type InvokeWorkflow = (input: {
  workflowId: string;
  mode: "execute";
  channel: "recordEvent";
  inputs: Record<string, WorkflowJsonValue>;
  idempotencyKey: string;
  expectedRevision: number;
  principal: GridsWorkflowPrincipal;
  occurredAt: string;
  context: Record<string, WorkflowJsonValue>;
  trustedRecordIds: ReadonlyMap<string, ReadonlySet<string>>;
}) => Promise<Result<WorkflowInvocationReceipt>>;

type Snapshot = { data: Record<string, WorkflowJsonValue>; matched: boolean };

const eventName = (event: GridsRecordEvent): "created" | "updated" | "deleted" | "commented" | null => {
  if (event.type === "record.created") return "created";
  if (event.type === "record.updated") return "updated";
  if (event.type === "record.finalized") return "updated";
  if (event.type === "record.deleted") return "deleted";
  if (event.type === "comment.created") return "commented";
  return null;
};

const eventKey = (workflowId: string, event: GridsRecordEvent): string =>
  `record-event:${workflowId}:${event.type}:${event.recordId}:${event.version ?? "deleted"}:${event.occurredAt}`;

const triggerFor = (workflow: GridsWorkflow) => workflow.plan.triggers.find((trigger) => trigger.kind === "recordEvent") ?? null;

const triggerTableId = (workflow: GridsWorkflow): string | null => {
  const value = workflow.plan.bindings["triggers.recordEvent.table"];
  return typeof value === "string" ? value : null;
};

const bindFilter = (
  workflow: GridsWorkflow,
  value: WorkflowJsonValue,
  path: Array<string | number> = ["triggers", "recordEvent", "filter"],
): WorkflowJsonValue => {
  if (Array.isArray(value)) return value.map((item, index) => bindFilter(workflow, item, [...path, index]));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const itemPath = [...path, key];
      if (key === "fieldId") {
        const binding = workflow.plan.bindings[workflowPathKey(itemPath)];
        if (typeof binding !== "string") throw new Error(`record event filter binding is unavailable at "${workflowPathKey(itemPath)}"`);
        return [key, binding];
      }
      return [key, bindFilter(workflow, item, itemPath)];
    }),
  );
};

const loadSnapshot = async (workflow: GridsWorkflow, event: GridsRecordEvent): Promise<Snapshot> => {
  const trigger = triggerFor(workflow);
  if (!trigger) throw new Error("workflow record event trigger is unavailable");
  const tableId = triggerTableId(workflow) ?? event.tableId;
  if (tableId !== event.tableId) throw new Error("record event table does not match workflow trigger");

  const rawFilter = trigger.config.filter;
  let clause = null;
  if (rawFilter !== undefined && rawFilter !== null) {
    const fields = await listFields(tableId);
    const filter = bindFilter(workflow, rawFilter) as FilterTree;
    const timeZone = normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC");
    const compiled = compileFilter(filter, fields, { timeZone });
    if (!compiled.ok) throw new Error(`workflow record event filter is invalid: ${compiled.error}`);
    clause = renderClause(compiled.clause, { recordAlias: "event_record", relationSource: "recordData" });
  }

  const [row] = clause
    ? await sql<Array<{ snapshot_id: string; data: Record<string, WorkflowJsonValue>; matched: boolean }>>`
        SELECT snapshot.id::text AS snapshot_id, snapshot.data, COALESCE((${clause}), false) AS matched
        FROM grids.record_event_outbox outbox
        JOIN grids.record_event_snapshots snapshot ON snapshot.id = outbox.id
        CROSS JOIN LATERAL (SELECT snapshot.record_id AS id, snapshot.data AS data) event_record
        WHERE outbox.base_id = ${event.baseId}::uuid
          AND snapshot.table_id = ${tableId}::uuid
          AND snapshot.record_id = ${event.recordId}::uuid
          AND snapshot.event_type = ${event.type}
          AND (${event.version}::int IS NULL OR snapshot.record_version = ${event.version})
          AND outbox.payload->>'occurredAt' = ${event.occurredAt}
      `
    : await sql<Array<{ snapshot_id: string; data: Record<string, WorkflowJsonValue>; matched: boolean }>>`
        SELECT snapshot.id::text AS snapshot_id, snapshot.data, TRUE AS matched
        FROM grids.record_event_outbox outbox
        JOIN grids.record_event_snapshots snapshot ON snapshot.id = outbox.id
        WHERE outbox.base_id = ${event.baseId}::uuid
          AND snapshot.table_id = ${tableId}::uuid
          AND snapshot.record_id = ${event.recordId}::uuid
          AND snapshot.event_type = ${event.type}
          AND (${event.version}::int IS NULL OR snapshot.record_version = ${event.version})
          AND outbox.payload->>'occurredAt' = ${event.occurredAt}
      `;
  if (!row?.snapshot_id) throw new Error("record event snapshot is missing or inconsistent");
  return { data: row.data, matched: Boolean(row.matched) };
};

const ownerPrincipal = async (workflow: GridsWorkflow): Promise<GridsWorkflowPrincipal> => ({
  userId: workflow.ownerUserId,
  groupIds: await loadWorkflowUserGroupIds(workflow.ownerUserId),
  serviceAccountId: null,
});

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The retained error names every failed workflow, not only the aggregate. */
const describeDispatchError = (error: unknown): string =>
  error instanceof AggregateError && error.errors.length > 0
    ? `${error.message}: ${error.errors.map(errorMessage).join("; ")}`
    : errorMessage(error);

/**
 * Retains a failed dispatch in PostgreSQL and re-queues the event behind its
 * partition. Only an unavailable failure store propagates to the transport, so
 * a broken workflow never holds the partition for other records.
 */
const retainDispatchFailure = async (
  delivery: QueueMessage<GridsRecordEvent>,
  event: GridsRecordEvent,
  error: unknown,
  ports: WorkflowRecordEventDeliveryPorts,
): Promise<void> => {
  const message = describeDispatchError(error);
  const deliveryKey = typeof delivery.meta?.deliveryKey === "string" ? delivery.meta.deliveryKey : delivery.messageId;
  const context = { baseId: event.baseId, deliveryKey, recordId: event.recordId, transportAttempt: delivery.attempt };
  let failure: { attempts: number; dead: boolean };
  try {
    failure = await ports.recordFailure({
      baseId: event.baseId,
      consumerGroup: CONSUMER_GROUP,
      eventId: deliveryKey,
      payload: JSON.stringify(event),
      error: message,
      maxAttempts: RECORD_EVENT_WORK_MAX_ATTEMPTS,
    });
  } catch (storeError) {
    if (isDeletedRecordEventBaseError(storeError)) {
      log.info("Discarded record event for a deleted base", context);
      return;
    }
    log.error("Could not persist workflow record event delivery failure; retrying in place", {
      ...context,
      error: storeError instanceof Error ? storeError.message : String(storeError),
    });
    throw storeError;
  }
  if (failure.dead) {
    log.error("Workflow record event moved to the application dead-letter store", {
      ...context,
      attempts: failure.attempts,
      error: message,
    });
    return;
  }
  await ports.requeue({ event, tenantId: delivery.tenantId, meta: delivery.meta, deliveryKey, attempts: failure.attempts });
  log.warn("Workflow record event re-queued after a failed dispatch", { ...context, attempts: failure.attempts, error: message });
};

export const processWorkflowRecordEventDelivery = async (
  delivery: QueueMessage<GridsRecordEvent>,
  dispatch: (event: GridsRecordEvent) => Promise<void>,
  ports: WorkflowRecordEventDeliveryPorts = defaultPorts,
): Promise<void> => {
  delivery.signal.throwIfAborted();
  const event = GridsRecordEventSchema.parse(delivery.data);
  let renewalFailure: unknown;
  const timer = setInterval(() => {
    void delivery.heartbeat().catch((error) => {
      renewalFailure = error;
    });
  }, LEASE_HEARTBEAT_MS);
  try {
    let dispatchError: unknown;
    try {
      await dispatch(event);
    } catch (error) {
      dispatchError = error;
    }
    // A lost lease or a shutdown leaves the delivery to the broker: redelivery
    // repeats the dispatch instead of retaining a failure it may not own.
    delivery.signal.throwIfAborted();
    if (renewalFailure) throw renewalFailure;
    if (dispatchError !== undefined) await retainDispatchFailure(delivery, event, dispatchError, ports);
    await delivery.heartbeat();
  } finally {
    clearInterval(timer);
  }
};

export const createWorkflowRecordEventRuntime = (invoke: InvokeWorkflow) => {
  let worker: Worker | undefined;

  const dispatch = async (event: GridsRecordEvent): Promise<void> => {
    const name = eventName(event);
    if (!name) return;
    const failures: unknown[] = [];
    for (const workflow of await listRecordEventWorkflows(event.baseId, event.occurredAt)) {
      const trigger = triggerFor(workflow);
      if (!trigger || trigger.config.event !== name) continue;
      if (triggerTableId(workflow) && triggerTableId(workflow) !== event.tableId) continue;
      try {
        const principal = await ownerPrincipal(workflow);
        const snapshot = await loadSnapshot(workflow, event);
        if (!snapshot.matched) continue;
        const inputs = evaluateWorkflowTriggerInputs(
          { record: event.recordId, event: name, occurredAt: event.occurredAt },
          trigger.with,
          event.occurredAt,
        );
        const locale = normalizeLocale(await settingsGet<string>("app.locale"));
        const result = await invoke({
          workflowId: workflow.id,
          mode: "execute",
          channel: "recordEvent",
          inputs,
          idempotencyKey: eventKey(workflow.id, event),
          expectedRevision: workflow.revision,
          principal,
          occurredAt: event.occurredAt,
          context: {
            locale,
            recordEvent: event,
            workflowRecordSnapshots: { [`${event.tableId}:${event.recordId}`]: snapshot.data },
          },
          trustedRecordIds: new Map([[event.tableId, new Set([event.recordId])]]),
        });
        /*
         * A refusal is not a run. It used to be materialised as a failed one so
         * that somebody would see it; the event row now carries that — an
         * occurrence that matched a workflow and produced nothing is visible as
         * an undispatched `workflows.event`, without inventing a run that never
         * executed a step.
         */
        if (!result.ok) {
          if (result.error.status === 409 || result.error.status >= 500) throw new Error(result.error.message);
          log.warn("Workflow record event invocation was rejected", {
            workflowId: workflow.id,
            recordId: event.recordId,
            status: result.error.status,
            error: result.error.message,
          });
        }
      } catch (error) {
        failures.push(error);
        const message = error instanceof Error ? error.message : String(error);
        log.warn("Workflow record event dispatch failed", { workflowId: workflow.id, recordId: event.recordId, error: message });
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Workflow record event dispatch failed");
  };

  return {
    dispatch,
    reconcile: async (): Promise<void> => {
      worker ??= await recordEventWorkQueue().process({ concurrency: RECORD_EVENT_WORK_PARTITIONS }, (delivery) =>
        processWorkflowRecordEventDelivery(delivery, dispatch),
      );
    },
    stop: async (): Promise<void> => {
      await worker?.drain({ timeoutMs: RECORD_EVENT_WORK_LEASE_MS });
      worker = undefined;
    },
  };
};
