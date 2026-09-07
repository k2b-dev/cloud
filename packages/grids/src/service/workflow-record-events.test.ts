import { describe, expect, mock, test } from "bun:test";
import type { QueueMessage } from "@k2b/sync";
import type { GridsRecordEvent } from "./record-events";
import { RECORD_EVENT_WORK_BACKOFF_MS, RECORD_EVENT_WORK_MAX_ATTEMPTS } from "./record-events";
import { processWorkflowRecordEventDelivery } from "./workflow-record-events";

const BASE_ID = "00000000-0000-4000-8000-000000000001";
const delivery = (): QueueMessage<GridsRecordEvent> => ({
  data: {
    v: 1,
    type: "record.updated",
    baseId: BASE_ID,
    tableId: "00000000-0000-4000-8000-000000000002",
    recordId: "00000000-0000-4000-8000-000000000003",
    version: 2,
    changedFieldIds: [],
    actorId: null,
    occurredAt: "2026-07-15T12:00:00.000Z",
  },
  messageId: "transport-2",
  attempt: 1,
  publishedAt: new Date(),
  tenantId: "workflow-kernel",
  orderingKey: "00000000-0000-4000-8000-000000000003",
  meta: { baseId: BASE_ID, eventId: "original-event" },
  signal: new AbortController().signal,
  heartbeat: async () => undefined,
});

describe("native workflow record-event recovery", () => {
  test("preserves the twenty-attempt budget and five-minute capped backoff", () => {
    expect(RECORD_EVENT_WORK_MAX_ATTEMPTS).toBe(20);
    expect(RECORD_EVENT_WORK_BACKOFF_MS).toHaveLength(19);
    expect(RECORD_EVENT_WORK_BACKOFF_MS.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(RECORD_EVENT_WORK_BACKOFF_MS.at(-1)).toBe(300000);
  });

  test("propagates dispatch failures for native retry without publishing another message", async () => {
    const error = new Error("workflow database unavailable");
    const dispatch = mock(async () => {
      throw error;
    });
    await expect(processWorkflowRecordEventDelivery(delivery(), dispatch)).rejects.toBe(error);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test("invalid payloads fail at the worker boundary", async () => {
    const dispatch = mock(async () => undefined);
    const message = delivery();
    message.data = { ...message.data, version: -1 };
    await expect(processWorkflowRecordEventDelivery(message, dispatch)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("does not dispatch aborted work and rechecks cancellation before acknowledgement", async () => {
    const controller = new AbortController();
    const message = { ...delivery(), signal: controller.signal };
    const dispatch = mock(async () => {
      controller.abort();
    });
    await expect(processWorkflowRecordEventDelivery(message, dispatch)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockClear();
    await expect(processWorkflowRecordEventDelivery(message, dispatch)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("heartbeats before returning and propagates lease failures", async () => {
    const message = { ...delivery(), heartbeat: mock(async () => undefined) };
    await processWorkflowRecordEventDelivery(message, async () => undefined);
    expect(message.heartbeat).toHaveBeenCalledTimes(1);
    await expect(
      processWorkflowRecordEventDelivery(
        {
          ...message,
          heartbeat: async () => {
            throw new Error("disconnected");
          },
        },
        async () => undefined,
      ),
    ).rejects.toThrow("disconnected");
  });
});
