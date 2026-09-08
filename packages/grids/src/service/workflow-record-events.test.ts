import { describe, expect, mock, test } from "bun:test";
import type { QueueMessage } from "@k2b/sync";
import type { GridsRecordEvent } from "./record-events";
import { RECORD_EVENT_WORK_MAX_ATTEMPTS, RECORD_EVENT_WORK_TRANSPORT_ATTEMPTS, workflowRecordEventRetryDelayMs } from "./record-events";
import {
  isDeletedRecordEventBaseError,
  processWorkflowRecordEventDelivery,
  type WorkflowRecordEventDeliveryPorts,
} from "./workflow-record-events";

const BASE_ID = "00000000-0000-4000-8000-000000000001";
const RECORD_ID = "00000000-0000-4000-8000-000000000003";
const event = (): GridsRecordEvent => ({
  v: 1,
  type: "record.updated",
  baseId: BASE_ID,
  tableId: "00000000-0000-4000-8000-000000000002",
  recordId: RECORD_ID,
  version: 2,
  changedFieldIds: [],
  actorId: null,
  occurredAt: "2026-07-15T12:00:00.000Z",
});
const delivery = (overrides: Partial<QueueMessage<GridsRecordEvent>> = {}): QueueMessage<GridsRecordEvent> => ({
  data: event(),
  messageId: "transport-2",
  attempt: 1,
  publishedAt: new Date(),
  tenantId: "workflow-kernel",
  orderingKey: RECORD_ID,
  meta: { baseId: BASE_ID },
  signal: new AbortController().signal,
  heartbeat: async () => undefined,
  ...overrides,
});
const ports = (input: Partial<WorkflowRecordEventDeliveryPorts> = {}): WorkflowRecordEventDeliveryPorts => ({
  recordFailure: mock(async () => ({ attempts: 1, dead: false })),
  requeue: mock(async () => undefined),
  ...input,
});
const failingDispatch = (message: string) =>
  mock(async () => {
    throw new Error(message);
  });

describe("workflow record-event delivery recovery", () => {
  test("keeps the twenty-attempt application budget and a short transport budget", () => {
    expect(RECORD_EVENT_WORK_MAX_ATTEMPTS).toBe(20);
    expect(RECORD_EVENT_WORK_TRANSPORT_ATTEMPTS).toBe(3);
  });

  test("backs off re-queued deliveries without exceeding five minutes", () => {
    expect(workflowRecordEventRetryDelayMs(1)).toBe(1_000);
    expect(workflowRecordEventRetryDelayMs(5)).toBe(16_000);
    expect(workflowRecordEventRetryDelayMs(20)).toBe(300_000);
  });

  test("recognizes only the deleted-base foreign-key failure", () => {
    expect(isDeletedRecordEventBaseError({ code: "23503", constraint: "record_event_delivery_failures_base_id_fkey" })).toBe(true);
    expect(isDeletedRecordEventBaseError({ code: "23503", constraint: "another_foreign_key" })).toBe(false);
    expect(isDeletedRecordEventBaseError(new Error("PostgreSQL unavailable"))).toBe(false);
  });

  test("retains a dispatch failure, re-queues behind the record with backoff, and acknowledges", async () => {
    const recordFailure = mock(async () => ({ attempts: 3, dead: false }));
    const requeue = mock(async () => undefined);
    await processWorkflowRecordEventDelivery(
      delivery(),
      failingDispatch("workflow database unavailable"),
      ports({ recordFailure, requeue }),
    );
    expect(recordFailure).toHaveBeenCalledWith({
      baseId: BASE_ID,
      consumerGroup: "workflow-kernel-queue-v1",
      eventId: "transport-2",
      payload: JSON.stringify(event()),
      error: "workflow database unavailable",
      maxAttempts: 20,
    });
    expect(requeue).toHaveBeenCalledWith({
      event: event(),
      tenantId: "workflow-kernel",
      meta: { baseId: BASE_ID },
      deliveryKey: "transport-2",
      attempts: 3,
    });
  });

  test("keeps the original delivery key across re-queued attempts", async () => {
    const recordFailure = mock(async () => ({ attempts: 4, dead: false }));
    const requeue = mock(async () => undefined);
    const retried = delivery({ messageId: "retry-3", meta: { baseId: BASE_ID, deliveryKey: "transport-2" } });
    await processWorkflowRecordEventDelivery(retried, failingDispatch("still failing"), ports({ recordFailure, requeue }));
    expect(recordFailure).toHaveBeenCalledWith(expect.objectContaining({ eventId: "transport-2" }));
    expect(requeue).toHaveBeenCalledWith(expect.objectContaining({ deliveryKey: "transport-2", attempts: 4 }));
  });

  test("acknowledges without re-queueing once the application budget is exhausted", async () => {
    const requeue = mock(async () => undefined);
    await processWorkflowRecordEventDelivery(
      delivery(),
      failingDispatch("permanent failure"),
      ports({ recordFailure: mock(async () => ({ attempts: 20, dead: true })), requeue }),
    );
    expect(requeue).not.toHaveBeenCalled();
  });

  test("acknowledges dispatch work whose base was deleted", async () => {
    const requeue = mock(async () => undefined);
    const recordFailure = mock(async () => {
      throw { code: "23503", constraint_name: "record_event_delivery_failures_base_id_fkey" };
    });
    await processWorkflowRecordEventDelivery(delivery(), failingDispatch("dispatch failed"), ports({ recordFailure, requeue }));
    expect(requeue).not.toHaveBeenCalled();
  });

  test("retries in place only while the failure store is unavailable", async () => {
    const requeue = mock(async () => undefined);
    const recordFailure = mock(async () => {
      throw new Error("PostgreSQL unavailable");
    });
    await expect(
      processWorkflowRecordEventDelivery(delivery(), failingDispatch("dispatch failed"), ports({ recordFailure, requeue })),
    ).rejects.toThrow("PostgreSQL unavailable");
    expect(requeue).not.toHaveBeenCalled();
  });

  test("does not retain a failure for successful dispatch", async () => {
    const recordFailure = mock(async () => ({ attempts: 1, dead: false }));
    const dispatch = mock(async () => undefined);
    await processWorkflowRecordEventDelivery(delivery(), dispatch, ports({ recordFailure }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  test("invalid payloads fail at the worker boundary without touching the failure store", async () => {
    const dispatch = mock(async () => undefined);
    const recordFailure = mock(async () => ({ attempts: 1, dead: false }));
    const message = delivery();
    message.data = { ...message.data, version: -1 };
    await expect(processWorkflowRecordEventDelivery(message, dispatch, ports({ recordFailure }))).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  test("leaves aborted work to redelivery instead of retaining a failure", async () => {
    const controller = new AbortController();
    const message = delivery({ signal: controller.signal });
    const recordFailure = mock(async () => ({ attempts: 1, dead: false }));
    const dispatch = mock(async () => {
      controller.abort();
      throw new Error("interrupted");
    });
    await expect(processWorkflowRecordEventDelivery(message, dispatch, ports({ recordFailure }))).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(recordFailure).not.toHaveBeenCalled();
    dispatch.mockClear();
    await expect(processWorkflowRecordEventDelivery(message, dispatch, ports({ recordFailure }))).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("heartbeats before returning and propagates lease failures", async () => {
    const message = delivery({ heartbeat: mock(async () => undefined) });
    await processWorkflowRecordEventDelivery(message, async () => undefined, ports());
    expect(message.heartbeat).toHaveBeenCalledTimes(1);
    await expect(
      processWorkflowRecordEventDelivery(
        delivery({
          heartbeat: async () => {
            throw new Error("disconnected");
          },
        }),
        async () => undefined,
        ports(),
      ),
    ).rejects.toThrow("disconnected");
  });
});
