import { expect, spyOn } from "bun:test";
import { createSync, type JobConfig, type Sync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { syncDefaultMaxBytes, withSyncBudgets } from "./sync-budget";

const integration = testFor("nats");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BUDGET = syncDefaultMaxBytes();
/** What Sync 6 gave a job or queue declared without `retention`. */
const SYNC_6_RETENTION = { maxAgeMs: WEEK_MS, maxBytes: 1024 ** 3 };

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

const createTestSync = (connection: NatsConnection, namespace: string) =>
  createSync({ connection, namespace, application: "budget-test", defaults: { replicas: 1 } });

const openSync = (connection: NatsConnection, namespace: string, budgets = true): Sync => {
  const sync = createTestSync(connection, namespace);
  return budgets ? withSyncBudgets(sync, { connection, namespace }) : sync;
};

const limitsOf = async (connection: NatsConnection, namespace: string, id: string) =>
  (await streamLimits(connection, namespace, id)).map((stream) => stream.maxBytes);

integration(
  "jobs and queues keep the limits they declare, Sync's default included",
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
      await sync.queue<null>({ id: "dead-letters", deadLetterRetention: { maxBytes: 1_000_000 } }).ready();

      for (const id of ["plain-job", "plain-queue"]) {
        expect(await limitsOf(connection, namespace, id)).toEqual([BUDGET, BUDGET]);
      }
      expect(await limitsOf(connection, namespace, "small-payload")).toEqual([256 * (8_000 + 4096), 256 * (8_000 + 4096)]);
      expect(await limitsOf(connection, namespace, "explicit")).toEqual([2_000_000, 2_000_000]);
      // Dead letters (limits retention) sort before work (workqueue retention).
      expect(await limitsOf(connection, namespace, "dead-letters")).toEqual([1_000_000, BUDGET]);
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
      // Streams as Sync 6 created them for a job without retention.
      const legacy = openSync(connection, namespace, false);
      const legacyJob = legacy.job<{ n: number }>({ id: "work", retention: SYNC_6_RETENTION });
      await legacy.ready();
      for (const n of [1, 2, 3]) await legacyJob.submit({ key: `k${n}`, input: { n } });
      expect(await limitsOf(connection, namespace, "work")).toEqual([1024 ** 3, 1024 ** 3]);
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
      expect(await limitsOf(connection, namespace, "work")).toEqual([BUDGET, BUDGET]);
      await current.drain({ timeoutMs: 5_000 });
    } finally {
      await connection.drain();
    }
  },
  30_000,
);

integration(
  "a job or queue stream that holds more than its new limit keeps its old limit instead of failing or discarding work",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("budget-keep");
    const retention = (maxBytes: number) => ({ maxAgeMs: WEEK_MS, maxBytes });
    try {
      const legacy = openSync(connection, namespace, false);
      const legacyQueue = legacy.queue<{ n: number; pad: string }>({
        id: "full",
        retention: retention(4 * 1024 * 1024),
        maxPayloadBytes: 16_000,
      });
      await legacy.ready();
      for (let n = 0; n < 20; n++) await legacyQueue.send({ data: { n, pad: "x".repeat(10_000) } });
      const [, work] = await streamLimits(connection, namespace, "full");
      expect(work?.bytes).toBeGreaterThan(64 * 1024);
      await legacy.drain({ timeoutMs: 5_000 });

      const current = openSync(connection, namespace);
      await current.ready();
      const queue = current.queue<{ n: number; pad: string }>({ id: "full", retention: retention(64 * 1024), maxPayloadBytes: 16_000 });
      await queue.ready();
      // The empty dead-letter stream gets the new limit; the work stream keeps its old one.
      expect(await limitsOf(connection, namespace, "full")).toEqual([64 * 1024, 4 * 1024 * 1024]);
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

integration(
  "ready() provisions the jobs and queues declared before it, so controls() lists them",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("budget-ready");
    const sync = openSync(connection, namespace);
    try {
      await sync.ready();
      sync.job<null>({ id: "declared-job" });
      sync.queue<null>({ id: "declared-queue" });
      expect(await limitsOf(connection, namespace, "declared-queue")).toEqual([]);

      await sync.ready();
      expect(await limitsOf(connection, namespace, "declared-job")).toEqual([BUDGET, BUDGET]);
      expect(await limitsOf(connection, namespace, "declared-queue")).toEqual([BUDGET, BUDGET]);
      expect(
        sync
          .controls()
          .map((control) => `${control.kind}:${control.id}`)
          .sort(),
      ).toEqual(["job:declared-job", "queue:declared-queue"]);
    } finally {
      await sync.drain({ timeoutMs: 5_000 });
      await connection.drain();
    }
  },
  30_000,
);

integration(
  "a job first used after another process created its streams gets its limit instead of drifting",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("budget-late");
    const current = openSync(connection, namespace);
    const legacy = openSync(connection, namespace, false);
    try {
      await current.ready();
      await current.job<null>({ id: "first" }).ready();
      // An older release creates the next job at Sync's own limit after this process listed its streams.
      await legacy.job<null>({ id: "later", retention: SYNC_6_RETENTION }).ready();
      expect(await limitsOf(connection, namespace, "later")).toEqual([1024 ** 3, 1024 ** 3]);

      await current.job<null>({ id: "later" }).ready();
      expect(await limitsOf(connection, namespace, "later")).toEqual([BUDGET, BUDGET]);
    } finally {
      await legacy.drain({ timeoutMs: 5_000 });
      await current.drain({ timeoutMs: 5_000 });
      await connection.drain();
    }
  },
  30_000,
);

integration(
  "a declaration repairs streams another process created between the check and the declaration",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("budget-race");
    const raw = createTestSync(connection, namespace);
    const current = withSyncBudgets(raw, { connection, namespace });
    const legacy = openSync(connection, namespace, false);
    const declareJob = raw.job;
    const race = spyOn(raw, "job").mockImplementation(<Input>(config: JobConfig) => {
      const handle = declareJob<Input>(config);
      return {
        ...handle,
        ready: async () => {
          await legacy.job<Input>({ id: config.id, retention: SYNC_6_RETENTION }).ready();
          await handle.ready();
        },
      };
    });
    try {
      await current.ready();
      const job = current.job<{ n: number }>({ id: "raced" });
      await job.ready();
      expect(race).toHaveBeenCalledTimes(1);
      expect(await limitsOf(connection, namespace, "raced")).toEqual([BUDGET, BUDGET]);

      const seen: number[] = [];
      const worker = await job.process({}, async (context) => {
        seen.push(context.input.n);
      });
      await job.submit({ key: "one", input: { n: 1 } });
      const deadline = Date.now() + 10_000;
      while (seen.length < 1 && Date.now() < deadline) await Bun.sleep(25);
      worker.stop();
      expect(seen).toEqual([1]);
    } finally {
      race.mockRestore();
      await legacy.drain({ timeoutMs: 5_000 });
      await current.drain({ timeoutMs: 5_000 });
      await connection.drain();
    }
  },
  30_000,
);

integration(
  "a topic first used through a hub lowers its existing dead-letter stream to its deadLetterRetention",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("budget-topic");
    const retention = { maxAgeMs: 24 * 60 * 60 * 1000, maxBytes: 4 * 1024 * 1024 };
    const legacy = openSync(connection, namespace, false);
    const current = openSync(connection, namespace);
    const abort = new AbortController();
    try {
      // Before deadLetterRetention, the dead-letter stream inherited the event stream's limit.
      await legacy.topic<{ n: number }>({ id: "events", retention, maxPayloadBytes: 16_000 }).ready();
      expect(await limitsOf(connection, namespace, "events")).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024]);

      const topic = current.topic<{ n: number }>({
        id: "events",
        retention,
        deadLetterRetention: { maxBytes: 64 * 1024 },
        maxPayloadBytes: 16_000,
      });
      const seen: number[] = [];
      const tail = (async () => {
        for await (const event of topic.hub().subscribe({ signal: abort.signal })) {
          seen.push(event.data.n);
          abort.abort();
        }
      })();
      await Bun.sleep(200);
      await topic.publish({ data: { n: 1 } });
      await tail;
      expect(seen).toEqual([1]);
      const limits = await limitsOf(connection, namespace, "events");
      expect(limits.sort((a, b) => a - b)).toEqual([64 * 1024, 4 * 1024 * 1024]);
    } finally {
      abort.abort();
      await legacy.drain({ timeoutMs: 5_000 });
      await current.drain({ timeoutMs: 5_000 });
      await connection.drain();
    }
  },
  30_000,
);

integration(
  "a topic dead-letter stream that holds more than its new limit keeps it, and the declaration reports the drift",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("budget-topic-full");
    const retention = { maxAgeMs: 24 * 60 * 60 * 1000, maxBytes: 4 * 1024 * 1024 };
    const legacy = openSync(connection, namespace, false);
    const current = openSync(connection, namespace);
    try {
      const legacyTopic = legacy.topic<{ pad: string }>({ id: "failing", retention, maxPayloadBytes: 16_000 });
      const worker = await legacyTopic.process({ consumer: "fails", start: "earliest", delivery: { maxAttempts: 1 } }, async () => {
        throw new Error("dead-letter this event");
      });
      for (let n = 0; n < 8; n++) await legacyTopic.publish({ data: { pad: "x".repeat(10_000) } });
      const deadline = Date.now() + 10_000;
      while ((await legacyTopic.deadLetters.list({ limit: 8 })).length < 8 && Date.now() < deadline) await Bun.sleep(50);
      await worker.drain();
      const before = await streamLimits(connection, namespace, "failing");
      const held = Math.max(...before.map((stream) => stream.bytes));
      expect(held).toBeGreaterThan(32 * 1024);

      const topic = current.topic<{ pad: string }>({
        id: "failing",
        retention,
        deadLetterRetention: { maxBytes: 32 * 1024 },
        maxPayloadBytes: 16_000,
      });
      await expect(topic.publish({ data: { pad: "y" } })).rejects.toThrow("max_bytes");
      expect(await limitsOf(connection, namespace, "failing")).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024]);
      expect(Math.max(...(await streamLimits(connection, namespace, "failing")).map((stream) => stream.bytes))).toBe(held);
    } finally {
      await legacy.drain({ timeoutMs: 5_000 });
      await current.drain({ timeoutMs: 5_000 });
      await connection.drain();
    }
  },
  30_000,
);
