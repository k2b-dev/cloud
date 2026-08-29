import type { Result } from "@k2b/stdlib";
import { type Lock, mutex, type QueueReceived } from "@k2b/sync";
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
import {
  getDeadRecordEventDeliveryFailure,
  recordInvalidRecordEventDelivery,
  recordRecordEventDeliveryFailure,
} from "./record-event-delivery-failures";
import { redriveRecordEventOutbox } from "./record-event-outbox";
import {
  type GridsRecordEvent,
  GridsRecordEventSchema,
  publishRecordEvent,
  RECORD_EVENT_WORK_LEASE_MS,
  RECORD_EVENT_WORK_PARTITIONS,
  recordEventWorkReader,
} from "./record-events";
import { listRecordEventWorkflows } from "./workflow-definitions";
import { type GridsWorkflowPrincipal, loadWorkflowUserGroupIds } from "./workflow-values";

const log = logger("grids:workflow-record-events");
const CONSUMER_GROUP = "workflow-kernel-queue-v1";
const RETRY_DELAY_MS = 1_000;
const APPLICATION_MAX_DELIVERY_ATTEMPTS = 20;
const LEASE_HEARTBEAT_MS = Math.floor(RECORD_EVENT_WORK_LEASE_MS / 3);
const DELIVERY_FAILURE_BASE_FOREIGN_KEY = "record_event_delivery_failures_base_id_fkey";
const recordEventWorkMutex = mutex({
  id: "grids:workflow-record-events:v1",
  retryCount: 0,
  defaultTtl: RECORD_EVENT_WORK_LEASE_MS,
});

export const isDeletedRecordEventBaseError = (error: unknown): boolean => {
  const postgresError = error as { code?: string; errno?: string; constraint?: string; constraint_name?: string; message?: string } | null;
  if (postgresError?.code !== "23503" && postgresError?.errno !== "23503") return false;
  const constraint = postgresError.constraint ?? postgresError.constraint_name;
  return constraint === DELIVERY_FAILURE_BASE_FOREIGN_KEY || postgresError.message?.includes(DELIVERY_FAILURE_BASE_FOREIGN_KEY) === true;
};

const acknowledgeObsoleteDelivery = async (delivery: QueueReceived<GridsRecordEvent>, error: unknown): Promise<boolean> => {
  if (!isDeletedRecordEventBaseError(error)) return false;
  if (!(await delivery.ack())) throw new Error("obsolete record event acknowledgement was not accepted", { cause: error });
  return true;
};

export const processInvalidWorkflowRecordEventDelivery = async (
  delivery: QueueReceived<GridsRecordEvent>,
  recordFailure: typeof recordInvalidRecordEventDelivery = recordInvalidRecordEventDelivery,
): Promise<void> => {
  const baseId = GridsRecordEventSchema.shape.baseId.safeParse(delivery.meta?.baseId);
  if (!baseId.success) {
    if (!(await delivery.nack({ reason: "invalid", error: "record event base metadata is unavailable" }))) {
      throw new Error("record event rejection was not accepted");
    }
    return;
  }
  let failure: { dead: boolean; attempts: number };
  try {
    failure = await recordFailure({
      baseId: baseId.data,
      consumerGroup: CONSUMER_GROUP,
      eventId: delivery.messageId,
      payload: JSON.stringify(delivery.data),
      error: "record event payload is invalid",
    });
  } catch (failureStoreError) {
    if (await acknowledgeObsoleteDelivery(delivery, failureStoreError)) {
      log.info("Discarded record event for a deleted base", {
        baseId: baseId.data,
        eventId: delivery.messageId,
      });
      return;
    }
    const accepted = await delivery.nack({
      delayMs: workflowRecordEventRetryDelayMs(delivery.attempt),
      reason: "failure_store_unavailable",
      error: "record event payload is invalid",
    });
    if (!accepted) throw new Error("record event rejection was not accepted", { cause: failureStoreError });
    log.error("Could not persist invalid record event delivery", {
      baseId: baseId.data,
      eventId: delivery.messageId,
      attempt: delivery.attempt,
      error: failureStoreError instanceof Error ? failureStoreError.message : String(failureStoreError),
    });
    return;
  }
  const accepted = failure.dead
    ? await delivery.ack()
    : await delivery.nack({
        delayMs: workflowRecordEventRetryDelayMs(failure.attempts),
        reason: "invalid",
        error: "record event payload is invalid",
      });
  if (!accepted) throw new Error(`record event ${failure.dead ? "acknowledgement" : "rejection"} was not accepted`);
};

export const workflowRecordEventRetryDelayMs = (attempt: number): number =>
  Math.min(5 * 60_000, RETRY_DELAY_MS * 2 ** Math.max(0, Math.min(attempt - 1, 12)));

export const processFailedWorkflowRecordEventDelivery = async (
  delivery: QueueReceived<GridsRecordEvent>,
  event: GridsRecordEvent,
  error: unknown,
  recordFailure: typeof recordRecordEventDeliveryFailure = recordRecordEventDeliveryFailure,
): Promise<{ dead: boolean; attempts: number }> => {
  const message = error instanceof Error ? error.message : String(error);
  let failure: { dead: boolean; attempts: number };
  try {
    failure = await recordFailure({
      baseId: event.baseId,
      consumerGroup: CONSUMER_GROUP,
      eventId: delivery.messageId,
      payload: JSON.stringify(event),
      error: message,
      maxAttempts: APPLICATION_MAX_DELIVERY_ATTEMPTS,
    });
  } catch (failureStoreError) {
    if (await acknowledgeObsoleteDelivery(delivery, failureStoreError)) {
      log.info("Discarded record event for a deleted base", {
        baseId: event.baseId,
        eventId: delivery.messageId,
        recordId: event.recordId,
      });
      return { dead: true, attempts: delivery.attempt };
    }
    const accepted = await delivery.nack({
      delayMs: workflowRecordEventRetryDelayMs(delivery.attempt),
      reason: "failure_store_unavailable",
      error: message,
    });
    if (!accepted) throw new Error("record event rejection was not accepted", { cause: failureStoreError });
    log.error("Could not persist workflow record event delivery failure", {
      baseId: event.baseId,
      eventId: delivery.messageId,
      recordId: event.recordId,
      attempt: delivery.attempt,
      error: failureStoreError instanceof Error ? failureStoreError.message : String(failureStoreError),
    });
    return { dead: false, attempts: delivery.attempt };
  }
  const accepted = failure.dead
    ? await delivery.ack()
    : await delivery.nack({
        delayMs: workflowRecordEventRetryDelayMs(failure.attempts),
        reason: "dispatch_failed",
        error: message,
      });
  if (!accepted) throw new Error(`record event ${failure.dead ? "acknowledgement" : "rejection"} was not accepted`);
  if (failure.dead) {
    log.error("Workflow record event moved to the application dead-letter store", {
      baseId: event.baseId,
      eventId: delivery.messageId,
      recordId: event.recordId,
      attempts: failure.attempts,
      error: message,
    });
  }
  return failure;
};

export const replayWorkflowRecordEventDeliveryFailure = async (baseId: string, id: string): Promise<boolean> => {
  const failure = await getDeadRecordEventDeliveryFailure(baseId, id);
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

export const createWorkflowRecordEventRuntime = (invoke: InvokeWorkflow) => {
  const readers = new Map<number, { controller: AbortController; task: Promise<void> }>();

  const dispatch = async (event: GridsRecordEvent): Promise<void> => {
    const name = eventName(event);
    if (!name) return;
    for (const workflow of await listRecordEventWorkflows(event.baseId, event.occurredAt)) {
      const trigger = triggerFor(workflow);
      if (!trigger || trigger.config.event !== name) continue;
      if (triggerTableId(workflow) && triggerTableId(workflow) !== event.tableId) continue;
      const principal = await ownerPrincipal(workflow);
      try {
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
          log.warn("Workflow record event invocation was rejected", {
            workflowId: workflow.id,
            recordId: event.recordId,
            status: result.error.status,
            error: result.error.message,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn("Workflow record event dispatch failed", { workflowId: workflow.id, recordId: event.recordId, error: message });
      }
    }
  };

  const processDelivery = async (delivery: QueueReceived<GridsRecordEvent>, lock: Lock): Promise<void> => {
    const parsed = GridsRecordEventSchema.safeParse(delivery.data);
    if (!parsed.success) {
      await processInvalidWorkflowRecordEventDelivery(delivery);
      return;
    }

    let renewalFailure: unknown = null;
    let renewal: Promise<void> | null = null;
    const renew = (): Promise<void> => {
      if (renewalFailure) return Promise.reject(renewalFailure);
      if (renewal) return renewal;
      renewal = Promise.all([
        delivery.touch({ leaseMs: RECORD_EVENT_WORK_LEASE_MS }),
        recordEventWorkMutex.extend(lock, RECORD_EVENT_WORK_LEASE_MS),
      ])
        .then(([deliveryActive, lockActive]) => {
          if (!deliveryActive || !lockActive) throw new Error("record event work lease is no longer active");
        })
        .catch((error) => {
          renewalFailure ??= error;
          throw error;
        })
        .finally(() => {
          renewal = null;
        });
      return renewal;
    };
    const timer = setInterval(() => {
      void renew().catch(() => undefined);
    }, LEASE_HEARTBEAT_MS);
    try {
      await dispatch(parsed.data);
      await renew();
      if (!(await delivery.ack())) throw new Error("record event acknowledgement was not accepted");
    } catch (error) {
      const failure = await processFailedWorkflowRecordEventDelivery(delivery, parsed.data, error);
      if (!failure.dead) throw error;
    } finally {
      clearInterval(timer);
    }
  };

  const startReader = (partition: number): void => {
    if (readers.has(partition)) return;
    const controller = new AbortController();
    const reader = recordEventWorkReader(partition);
    const task = (async () => {
      while (!controller.signal.aborted) {
        const lock = await recordEventWorkMutex.acquire(`partition:${partition}`, RECORD_EVENT_WORK_LEASE_MS).catch(() => null);
        if (!lock) {
          await Bun.sleep(RETRY_DELAY_MS);
          continue;
        }
        try {
          const delivery = await reader.recv({
            wait: true,
            timeoutMs: 30_000,
            leaseMs: RECORD_EVENT_WORK_LEASE_MS,
            signal: controller.signal,
          });
          if (delivery) await processDelivery(delivery, lock);
        } catch (error) {
          if (controller.signal.aborted) return;
          log.warn("Workflow record event reader failed", {
            partition,
            error: error instanceof Error ? error.message : String(error),
          });
          await Bun.sleep(RETRY_DELAY_MS);
        } finally {
          await recordEventWorkMutex.release(lock).catch(() => undefined);
        }
      }
    })();
    readers.set(partition, { controller, task });
  };

  const stopReader = async (partition: number): Promise<void> => {
    const active = readers.get(partition);
    if (!active) return;
    readers.delete(partition);
    active.controller.abort();
    await active.task;
  };

  return {
    dispatch,
    reconcile: async (): Promise<void> => {
      for (let partition = 0; partition < RECORD_EVENT_WORK_PARTITIONS; partition += 1) startReader(partition);
    },
    stop: async (): Promise<void> => Promise.all([...readers.keys()].map(stopReader)).then(() => undefined),
  };
};
