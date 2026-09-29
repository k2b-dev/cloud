import { expect } from "bun:test";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { SYNC_DEFAULT_RETENTION, withSyncBudgets } from "./sync-budget";

const integration = testFor("nats");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** max_bytes and stored bytes of the work and dead-letter streams Sync created for one declaration. */
const streamLimits = async (connection: NatsConnection, namespace: string, id: string) => {
  const manager = await jetstreamManager(connection);
  const streams: { retention: string; maxBytes: number; bytes: number }[] = [];
  for await (const info of manager.streams.list()) {
    const metadata = info.config.metadata;
    if (metadata?.["sync.namespace"] !== namespace || metadata["sync.id"] !== id || info.config.name.startsWith("KV_")) continue;
    streams.push({ retention: info.config.retention, maxBytes: info.config.max_bytes, bytes: info.state.bytes });
  }
  return streams.sort((a, b) => a.retention.localeCompare(b.retention));
};

const openSync = (connection: NatsConnection, namespace: string, budgets = true) => {
  const sync = createSync({ connection, namespace, application: "budget-test", defaults: { replicas: 1 } });
  return budgets ? withSyncBudgets(sync, { connection, namespace }) : sync;
};

integration(
  "jobs and queues without retention reserve the platform budget, explicit retention wins",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("budget-default");
    const sync = openSync(connection, namespace);
    try {
      await sync.ready();
      await sync.job<null>({ id: "plain-job" }).ready();
      await sync.queue<null>({ id: "plain-queue" }).ready();
      await sync.job<null>({ id: "small-payload", maxPayloadBytes: 8_000 }).ready();
      await sync.job<null>({ id: "explicit", retention: { maxAgeMs: WEEK_MS, maxBytes: 2_000_000 } }).ready();

      const budget = SYNC_DEFAULT_RETENTION.maxBytes;
      expect(budget).toBe(256 * (128 * 1024 + 4096));
      for (const id of ["plain-job", "plain-queue"]) {
        expect((await streamLimits(connection, namespace, id)).map((stream) => stream.maxBytes)).toEqual([budget, budget]);
      }
      expect((await streamLimits(connection, namespace, "small-payload")).map((stream) => stream.maxBytes)).toEqual([
        256 * (8_000 + 4096),
        256 * (8_000 + 4096),
      ]);
      expect((await streamLimits(connection, namespace, "explicit")).map((stream) => stream.maxBytes)).toEqual([2_000_000, 2_000_000]);
    } finally {
      await sync.drain({ timeoutMs: 5_000 });
      await connection.drain();
    }
  },
  30_000,
);

integration(
  "a start lowers the byte limit of existing job streams in place and keeps their pending work",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("budget-shrink");
    try {
      // A release before the platform budget: Sync's own 1 GiB default.
      const legacy = openSync(connection, namespace, false);
      const legacyJob = legacy.job<{ n: number }>({ id: "work" });
      await legacy.ready();
      for (const n of [1, 2, 3]) await legacyJob.submit({ key: `k${n}`, input: { n } });
      expect((await streamLimits(connection, namespace, "work")).map((stream) => stream.maxBytes)).toEqual([1024 ** 3, 1024 ** 3]);
      await legacy.drain({ timeoutMs: 5_000 });

      const current = openSync(connection, namespace);
      await current.ready();
      const seen: number[] = [];
      const worker = await current.job<{ n: number }>({ id: "work" }).process({}, async (context) => {
        seen.push(context.input.n);
      });
      const deadline = Date.now() + 10_000;
      while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(25);
      worker.stop();
      expect(seen.sort()).toEqual([1, 2, 3]);
      expect((await streamLimits(connection, namespace, "work")).map((stream) => stream.maxBytes)).toEqual([
        SYNC_DEFAULT_RETENTION.maxBytes,
        SYNC_DEFAULT_RETENTION.maxBytes,
      ]);
      await current.drain({ timeoutMs: 5_000 });
    } finally {
      await connection.drain();
    }
  },
  30_000,
);

integration(
  "a stream that holds more than the new limit keeps its old limit instead of failing or discarding work",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("budget-keep");
    const retention = (maxBytes: number) => ({ maxAgeMs: WEEK_MS, maxBytes });
    try {
      const legacy = openSync(connection, namespace, false);
      const legacyQueue = legacy.queue<{ n: number; pad: string }>({ id: "full", retention: retention(4 * 1024 * 1024) });
      await legacy.ready();
      for (let n = 0; n < 20; n++) await legacyQueue.send({ data: { n, pad: "x".repeat(10_000) } });
      const [, work] = await streamLimits(connection, namespace, "full");
      expect(work?.bytes).toBeGreaterThan(64 * 1024);
      await legacy.drain({ timeoutMs: 5_000 });

      const current = openSync(connection, namespace);
      await current.ready();
      const queue = current.queue<{ n: number; pad: string }>({ id: "full", retention: retention(64 * 1024) });
      await queue.ready();
      expect((await streamLimits(connection, namespace, "full")).map((stream) => stream.maxBytes)).toEqual([
        4 * 1024 * 1024,
        4 * 1024 * 1024,
      ]);
      const seen = new Set<number>();
      const worker = await queue.process({ concurrency: 4 }, async (message) => {
        seen.add(message.data.n);
      });
      const deadline = Date.now() + 10_000;
      while (seen.size < 20 && Date.now() < deadline) await Bun.sleep(25);
      worker.stop();
      expect(seen.size).toBe(20);
      await current.drain({ timeoutMs: 5_000 });
    } finally {
      await connection.drain();
    }
  },
  30_000,
);
