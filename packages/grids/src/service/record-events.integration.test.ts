import { expect, spyOn } from "bun:test";
import { getProcessSync } from "@k2b/cloud";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { startGridsTestSync } from "../sync-test-utils";
import { type GridsRecordEvent, publishRecordEvent, RECORD_EVENT_WORK_PARTITIONS, recordEventWorkQueue } from "./record-events";

const natsTest = testFor("nats");

natsTest(
  "competing workflow workers receive the events of one record in order",
  async () => {
    const stop = await startGridsTestSync();
    const event: GridsRecordEvent = {
      v: 1,
      type: "record.updated",
      baseId: Bun.randomUUIDv7(),
      tableId: Bun.randomUUIDv7(),
      recordId: Bun.randomUUIDv7(),
      version: 1,
      changedFieldIds: [],
      actorId: null,
      occurredAt: "2026-07-15T12:00:00.000Z",
    };
    try {
      const versions: Array<number | null> = [];
      const handle = async (message: { data: GridsRecordEvent }) => {
        if (message.data.recordId === event.recordId) versions.push(message.data.version);
      };
      await recordEventWorkQueue().process({ concurrency: 32 }, handle);
      await recordEventWorkQueue().process({ concurrency: 32 }, handle);
      await publishRecordEvent(event);
      await publishRecordEvent({ ...event, version: 2 });
      const deadline = Date.now() + 5_000;
      while (versions.length < 2 && Date.now() < deadline) await Bun.sleep(20);
      expect(versions).toEqual([1, 2]);
    } finally {
      await stop();
    }
  },
  30_000,
);

natsTest(
  "lazy workflow partitions start once, drain at idle, and resume queued events in order",
  async () => {
    const stopSync = await startGridsTestSync();
    const definitions = await import("./workflow-definitions");
    const { createWorkflowRecordEventRuntime } = await import("./workflow-record-events");
    const bases = spyOn(definitions, "getRecordEventActiveSince").mockResolvedValue(null);
    const received: string[] = [];
    const workflows = spyOn(definitions, "listRecordEventWorkflows").mockImplementation(async (_baseId, occurredAt) => {
      received.push(occurredAt);
      return [];
    });
    const runtime = createWorkflowRecordEventRuntime(async () => {
      throw new Error("This test records dispatch before workflow invocation");
    });
    const event: GridsRecordEvent = {
      v: 1,
      type: "record.updated",
      baseId: "00000000-0000-4000-8000-000000000001",
      tableId: "00000000-0000-4000-8000-000000000002",
      recordId: "00000000-0000-4000-8000-000000000003",
      version: 1,
      changedFieldIds: [],
      actorId: null,
      occurredAt: "2026-07-15T12:00:00.000Z",
    };
    const waitForDeliveries = async (count: number): Promise<void> => {
      const deadline = performance.now() + 5_000;
      while (received.length < count) {
        if (performance.now() >= deadline) throw new Error("Queued record events were not delivered");
        await Bun.sleep(20);
      }
    };
    const queue = recordEventWorkQueue();
    const processing = spyOn(queue, "process");
    try {
      const sync = getProcessSync();
      await runtime.reconcile();
      expect(sync.health().activeWorkers).toBe(0);
      expect(processing).toHaveBeenCalledTimes(0);
      // Publishing during the activation/start race must survive without a reader.
      await publishRecordEvent(event);
      await publishRecordEvent({ ...event, version: 2, occurredAt: "2026-07-15T12:00:01.000Z" });

      bases.mockResolvedValue(new Date(event.occurredAt));
      await Promise.all([runtime.reconcile(), runtime.reconcile(), runtime.reconcile()]);
      expect(processing).toHaveBeenCalledTimes(1);
      expect(processing).toHaveBeenCalledWith({ concurrency: RECORD_EVENT_WORK_PARTITIONS }, expect.any(Function));
      expect(sync.health().activeWorkers).toBe(1);
      const workQueue = (await sync.resources()).find((resource) => resource.id === "grids:workflow-record-events");
      expect(Object.keys(workQueue?.detail?.consumers ?? {})).toHaveLength(32);
      await waitForDeliveries(2);

      const handler = processing.mock.calls[0]?.[1];
      if (!handler) throw new Error("Workflow partition handler was not registered");
      const message = {
        data: { ...event, occurredAt: "2026-06-01T00:00:00.000Z" },
        messageId: "old-month-backlog",
        attempt: 1,
        publishedAt: new Date("2026-06-01T00:00:01.000Z"),
        tenantId: "workflow-kernel",
        signal: new AbortController().signal,
        heartbeat: async () => undefined,
      };
      workflows.mockClear();
      // A quiet month's historical queue costs no workflow SQL per message.
      for (let i = 0; i < 1_000; i++) await handler(message);
      expect(workflows).toHaveBeenCalledTimes(0);
      // Another replica may have committed an earlier activation since our
      // snapshot. Delayed outboxes, old publishers, and replays must still query.
      await handler({ ...message, publishedAt: new Date("2026-07-15T12:00:01.000Z") });
      expect(workflows).toHaveBeenCalledTimes(1);
      // The exact activation boundary remains eligible too.
      await handler({ ...message, data: event });
      expect(workflows).toHaveBeenCalledTimes(2);
      received.splice(2);

      bases.mockResolvedValue(null);
      await runtime.reconcile();
      expect(sync.health().activeWorkers).toBe(0);
      await publishRecordEvent({ ...event, version: 3, occurredAt: "2026-07-15T12:00:02.000Z" });
      bases.mockResolvedValue(new Date(event.occurredAt));
      await runtime.reconcile();
      await waitForDeliveries(3);
      expect(processing).toHaveBeenCalledTimes(2);
      expect(received).toEqual(["2026-07-15T12:00:00.000Z", "2026-07-15T12:00:01.000Z", "2026-07-15T12:00:02.000Z"]);
    } finally {
      await runtime.stop();
      processing.mockRestore();
      workflows.mockRestore();
      bases.mockRestore();
      await stopSync();
    }
  },
  30_000,
);
