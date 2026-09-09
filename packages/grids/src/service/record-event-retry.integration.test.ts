import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { bindProcessSync, unbindProcessSync } from "@k2b/cloud";
import { startGridsTestSync } from "../sync-test-utils";
import type { RecordEventDeliveryFailureInput } from "./record-event-delivery-failures";
import { type GridsRecordEvent, RECORD_EVENT_WORK_PARTITIONS, recordEventWorkQueue, requeueRecordEventWork } from "./record-events";
import { processWorkflowRecordEventDelivery } from "./workflow-record-events";

const natsTest = process.env.GRIDS_SYNC_TEST === "1" ? test : test.skip;
const TENANT = "workflow-kernel";
const event = (recordId: string, version: number, baseId = crypto.randomUUID()): GridsRecordEvent => ({
  v: 1,
  type: "record.updated",
  baseId,
  tableId: crypto.randomUUID(),
  recordId,
  version,
  changedFieldIds: [],
  actorId: null,
  occurredAt: new Date().toISOString(),
});
const partitionOf = (orderingKey: string): number =>
  createHash("sha256").update(orderingKey, "utf8").digest().readUInt32BE(0) % RECORD_EVENT_WORK_PARTITIONS;
const waitFor = async (ready: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for record event delivery");
    await Bun.sleep(20);
  }
};

natsTest(
  "a failing record is re-queued behind its partition while other records keep flowing, until the application budget is exhausted",
  async () => {
    const stop = await startGridsTestSync();
    try {
      const failing = crypto.randomUUID();
      let sibling = crypto.randomUUID();
      while (partitionOf(sibling) !== partitionOf(failing)) sibling = crypto.randomUUID();
      const budget = 3;
      const store = new Map<string, { attempts: number; error: string }>();
      const recordFailure = async (input: RecordEventDeliveryFailureInput) => {
        const current = store.get(input.eventId) ?? { attempts: 0, error: "" };
        current.attempts += 1;
        current.error = input.error;
        store.set(input.eventId, current);
        return { attempts: current.attempts, dead: current.attempts >= budget, alreadyDead: current.attempts > budget };
      };
      const seen: Array<{
        recordId: string;
        version: number | null;
        attempt: number;
        messageId: string;
        deliveryKey: unknown;
        at: number;
      }> = [];
      const queue = recordEventWorkQueue();
      await queue.process({ concurrency: RECORD_EVENT_WORK_PARTITIONS }, (delivery) =>
        processWorkflowRecordEventDelivery(
          delivery,
          async (value) => {
            seen.push({
              recordId: value.recordId,
              version: value.version,
              attempt: delivery.attempt,
              messageId: delivery.messageId,
              deliveryKey: delivery.meta?.deliveryKey,
              at: Date.now(),
            });
            if (value.recordId === failing) throw new Error("workflow dispatch failed");
          },
          { recordFailure, requeue: requeueRecordEventWork },
        ),
      );
      const first = event(failing, 1);
      await queue.send({ data: first, tenantId: TENANT, orderingKey: failing, meta: { baseId: first.baseId } });
      const siblingEvent = event(sibling, 1);
      await queue.send({ data: siblingEvent, tenantId: TENANT, orderingKey: sibling, meta: { baseId: siblingEvent.baseId } });
      await waitFor(() => seen.some((item) => item.recordId === sibling));
      // The sibling shares the partition and is served while the failure waits out its delay.
      expect(seen.map((item) => item.recordId)).toEqual([failing, sibling]);
      await waitFor(() => seen.filter((item) => item.recordId === failing).length === budget, 20_000);
      const failures = seen.filter((item) => item.recordId === failing);
      expect(failures.map((item) => item.attempt)).toEqual([1, 1, 1]);
      expect(failures.slice(1).map((item) => item.deliveryKey)).toEqual([failures[0]!.messageId, failures[0]!.messageId]);
      expect(failures[1]!.at - failures[0]!.at).toBeGreaterThanOrEqual(1_000);
      expect(failures[2]!.at - failures[1]!.at).toBeGreaterThanOrEqual(2_000);
      expect(store.get(failures[0]!.messageId)).toEqual({ attempts: budget, error: "workflow dispatch failed" });
      // Exhaustion acknowledges the delivery: nothing reaches the transport DLQ.
      await Bun.sleep(500);
      expect(seen.filter((item) => item.recordId === failing)).toHaveLength(budget);
      expect(await queue.deadLetters.list()).toHaveLength(0);
    } finally {
      await stop();
    }
  },
  40_000,
);

natsTest(
  "workers reopen the existing queue and preserve accepted work without resource drift",
  async () => {
    const connection = await connect({ servers: process.env.SYNC_TEST_SERVERS ?? "nats://127.0.0.1:4222", ignoreClusterUpdates: true });
    const namespace = `grids-cutover-${crypto.randomUUID()}`;
    const previous = createSync({ connection, namespace, application: "grids" });
    const current = createSync({ connection, namespace, application: "grids" });
    try {
      const input = event(crypto.randomUUID(), 1);
      const oldQueue = previous.queue<GridsRecordEvent>({
        id: "grids:workflow-record-events",
        ordering: { mode: "partitioned", partitions: 32 },
        retention: { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxBytes: 1024 * 1024 * 1024 },
        maxPayloadBytes: 68_000,
        delivery: {
          ackWaitMs: 120_000,
          maxAttempts: 20,
          backoffMs: Array.from({ length: 19 }, (_, index) => Math.min(300_000, 1_000 * 2 ** index)),
        },
      });
      await oldQueue.send({ data: input, tenantId: TENANT, orderingKey: input.recordId });
      // Provision the previous durable consumers without admitting deliveries.
      await oldQueue.process({ signal: AbortSignal.abort() }, async () => {
        throw new Error("old process must remain stopped");
      });
      await previous.drain();
      bindProcessSync(current);
      const seen: Array<number | null> = [];
      await recordEventWorkQueue().process({ concurrency: 32 }, (delivery) =>
        processWorkflowRecordEventDelivery(delivery, async (value) => {
          seen.push(value.version);
        }),
      );
      await recordEventWorkQueue().send({ data: { ...input, version: 2 }, tenantId: TENANT, orderingKey: input.recordId });
      await waitFor(() => seen.length === 2);
      expect(seen).toEqual([1, 2]);
    } finally {
      await previous.drain({ timeoutMs: 5_000 });
      await current.drain({ timeoutMs: 5_000 });
      unbindProcessSync();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    }
  },
  30_000,
);
