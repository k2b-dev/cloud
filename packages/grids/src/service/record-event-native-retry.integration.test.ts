import { expect, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { bindProcessSync, unbindProcessSync } from "@valentinkolb/cloud";
import { type GridsRecordEvent, recordEventWorkQueue } from "./record-events";
import { processWorkflowRecordEventDelivery } from "./workflow-record-events";

const natsTest = process.env.GRIDS_SYNC_TEST === "1" ? test : test.skip;
const event = (): GridsRecordEvent => ({
  v: 1,
  type: "record.updated",
  baseId: crypto.randomUUID(),
  tableId: crypto.randomUUID(),
  recordId: crypto.randomUUID(),
  version: 1,
  changedFieldIds: [],
  actorId: null,
  occurredAt: new Date().toISOString(),
});
const waitFor = async (ready: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!(await ready())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for record event delivery");
    await Bun.sleep(20);
  }
};

natsTest(
  "native partition retries preserve order and exhausted events can be replayed",
  async () => {
    const connection = await connect({ servers: process.env.NATS_TEST_SERVERS ?? "nats://127.0.0.1:4222", ignoreClusterUpdates: true });
    const namespace = `grids-retry-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "grids" });
    try {
      // A short budget exercises exhaustion without waiting through the production
      // twenty-attempt policy. The same Cloud delivery handler runs unchanged.
      const queue = sync.queue<GridsRecordEvent>({
        id: "grids:retry-test",
        ordering: { mode: "partitioned", partitions: 2 },
        delivery: { maxAttempts: 2, backoffMs: [10] },
      });
      const input = event();
      await queue.send({ data: input, tenantId: "workflow-kernel", orderingKey: input.recordId, meta: { baseId: input.baseId } });
      await queue.send({ data: { ...input, version: 2 }, tenantId: "workflow-kernel", orderingKey: input.recordId });
      const seen: Array<{ version: number | null; attempt: number; orderingKey?: string; baseId?: unknown }> = [];
      let fail = true;
      await queue.process({ concurrency: 2 }, (delivery) =>
        processWorkflowRecordEventDelivery(delivery, async (value) => {
          seen.push({
            version: value.version,
            attempt: delivery.attempt,
            orderingKey: delivery.orderingKey,
            baseId: delivery.meta?.baseId,
          });
          if (value.version === 1 && fail) throw new Error("temporary workflow failure");
        }),
      );
      await waitFor(() => seen.some((item) => item.version === 2));
      expect(seen.map(({ version, attempt }) => ({ version, attempt }))).toEqual([
        { version: 1, attempt: 1 },
        { version: 1, attempt: 2 },
        { version: 2, attempt: 1 },
      ]);
      const dead = await queue.deadLetters.list();
      expect(dead).toHaveLength(1);
      expect(dead[0]?.data).toEqual(input);
      expect(dead[0]?.attempts).toBe(2);
      fail = false;
      await queue.deadLetters.requeue({ messageId: dead[0]!.messageId, idempotencyKey: crypto.randomUUID() });
      await waitFor(() => seen.length === 4);
      expect(seen[3]).toEqual({ version: 1, attempt: 1, orderingKey: input.recordId, baseId: input.baseId });
      expect(await queue.deadLetters.list()).toHaveLength(0);
    } finally {
      await sync.drain({ timeoutMs: 5_000 });
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list()) {
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      }
      await connection.drain();
    }
  },
  30_000,
);

natsTest(
  "twenty-attempt workers reopen the existing queue and preserve accepted work without resource drift",
  async () => {
    const connection = await connect({ servers: process.env.NATS_TEST_SERVERS ?? "nats://127.0.0.1:4222", ignoreClusterUpdates: true });
    const namespace = `grids-cutover-${crypto.randomUUID()}`;
    const previous = createSync({ connection, namespace, application: "grids" });
    const current = createSync({ connection, namespace, application: "grids" });
    try {
      const input = event();
      const oldQueue = previous.queue<GridsRecordEvent>({
        id: "grids:workflow-record-events",
        ordering: { mode: "partitioned", partitions: 32 },
        retention: { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxBytes: 1024 * 1024 * 1024 },
        maxPayloadBytes: 68_000,
        delivery: { ackWaitMs: 120_000, maxAttempts: 4, backoffMs: [1_000, 5_000, 30_000] },
      });
      await oldQueue.send({ data: input, tenantId: "workflow-kernel", orderingKey: input.recordId });
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
      await recordEventWorkQueue().send({ data: { ...input, version: 2 }, tenantId: "workflow-kernel", orderingKey: input.recordId });
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
