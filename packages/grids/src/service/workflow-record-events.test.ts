import { describe, expect, mock, test } from "bun:test";
import type { QueueMessage } from "@k2b/sync";
import type { GridsRecordEvent } from "./record-events";
import {
  isDeletedRecordEventBaseError,
  processFailedWorkflowRecordEventDelivery,
  processInvalidWorkflowRecordEventDelivery,
  workflowRecordEventRetryDelayMs,
} from "./workflow-record-events";

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

describe("workflow record-event recovery", () => {
  test("recognizes only the deleted-base foreign-key failure", () => {
    expect(isDeletedRecordEventBaseError({ code: "23503", constraint: "record_event_delivery_failures_base_id_fkey" })).toBe(true);
    expect(isDeletedRecordEventBaseError({ code: "23503", constraint: "another_foreign_key" })).toBe(false);
  });

  test("backs off without exceeding five minutes", () => {
    expect(workflowRecordEventRetryDelayMs(1)).toBe(1_000);
    expect(workflowRecordEventRetryDelayMs(5)).toBe(16_000);
    expect(workflowRecordEventRetryDelayMs(20)).toBe(300_000);
  });

  test("persists the original identity and resends to the partition tail before acknowledging", async () => {
    const message = delivery();
    const resend = mock(async () => undefined);
    const record = mock(async () => ({ attempts: 3, dead: false }));
    await processFailedWorkflowRecordEventDelivery(message, message.data, new Error("dispatch failed"), record, resend);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ eventId: "original-event", maxAttempts: 20, baseId: BASE_ID }));
    expect(resend).toHaveBeenCalledWith(message, 4_000);
  });

  test("returns successfully without transport DLQ noise for application-terminal failures", async () => {
    const message = delivery();
    const resend = mock(async () => undefined);
    const result = await processFailedWorkflowRecordEventDelivery(
      message,
      message.data,
      new Error("permanent"),
      async () => ({ attempts: 20, dead: true }),
      resend,
    );
    expect(result).toEqual({ attempts: 20, dead: true });
    expect(resend).not.toHaveBeenCalled();
  });

  test("throws when the failure store or delayed resend is unavailable", async () => {
    const message = delivery();
    const unavailable = async () => {
      throw new Error("unavailable");
    };
    await expect(processFailedWorkflowRecordEventDelivery(message, message.data, new Error("dispatch"), unavailable)).rejects.toThrow(
      "unavailable",
    );
    await expect(
      processFailedWorkflowRecordEventDelivery(
        message,
        message.data,
        new Error("dispatch"),
        async () => ({ attempts: 1, dead: false }),
        unavailable,
      ),
    ).rejects.toThrow("unavailable");
  });

  test("acknowledges obsolete work after its base has been deleted", async () => {
    const message = delivery();
    const record = async () => {
      throw { code: "23503", constraint: "record_event_delivery_failures_base_id_fkey" };
    };
    const resend = mock(async () => undefined);
    expect(await processFailedWorkflowRecordEventDelivery(message, message.data, new Error("dispatch"), record, resend)).toEqual({
      attempts: 1,
      dead: true,
    });
    await processInvalidWorkflowRecordEventDelivery(message, record, resend);
    expect(resend).not.toHaveBeenCalled();
  });

  test("invalid payloads use the application budget and infrastructure failures remain retryable", async () => {
    const message = delivery();
    const resend = mock(async () => undefined);
    await processInvalidWorkflowRecordEventDelivery(message, async () => ({ attempts: 1, dead: false }), resend);
    expect(resend).toHaveBeenCalledWith(message, 1_000);
    resend.mockClear();
    await processInvalidWorkflowRecordEventDelivery(message, async () => ({ attempts: 5, dead: true }), resend);
    expect(resend).not.toHaveBeenCalled();
    await expect(processInvalidWorkflowRecordEventDelivery({ ...message, meta: undefined })).rejects.toThrow("base metadata");
    await expect(
      processInvalidWorkflowRecordEventDelivery(message, async () => {
        throw new Error("PG unavailable");
      }),
    ).rejects.toThrow("PG unavailable");
  });
});
