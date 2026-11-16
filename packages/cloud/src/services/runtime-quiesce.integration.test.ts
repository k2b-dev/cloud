import { expect } from "bun:test";
import { createSync } from "@k2b/sync";
import type { NatsConnection } from "@nats-io/transport-node";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { withSyncBudgets } from "../_internal/sync-budget";
import { createQuiesceController, type QuiesceController, withQuiesce } from "./runtime-quiesce";

const integration = testFor("nats");

/** The process Sync as `process-sync.ts` builds it: quiesce over the stream budgets over Sync. */
const processSync = (connection: NatsConnection, namespace: string, controller: QuiesceController) =>
  withQuiesce(
    withSyncBudgets(createSync({ connection, namespace, application: "quiesce-test", defaults: { replicas: 1 } }), {
      connection,
      namespace,
    }),
    controller,
  );

/** Resolves with `true` once `done` resolves, or `false` after `ms`. */
const within = (done: Promise<unknown>, ms: number) =>
  Promise.race([done.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

integration(
  "a quiesced job worker takes no work, and on resume the same handle processes what waited",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("quiesce-job");
    const controller = createQuiesceController();
    const sync = processSync(connection, namespace, controller);
    try {
      const job = sync.job<{ n: number }>({ id: "work" });
      await sync.ready();
      const seen: number[] = [];
      let arrived = Promise.withResolvers<void>();
      const worker = await job.process({}, async ({ input }) => {
        seen.push(input.n);
        arrived.resolve();
      });

      await job.submit({ key: "one", input: { n: 1 } });
      expect(await within(arrived.promise, 10_000)).toBe(true);

      expect(await controller.quiesce()).toEqual([]);
      expect(controller.inFlight()).toBe(0);
      arrived = Promise.withResolvers<void>();
      await job.submit({ key: "two", input: { n: 2 } });
      expect(await within(arrived.promise, 1_500)).toBe(false);

      expect(await controller.resume()).toEqual([]);
      expect(await within(arrived.promise, 10_000)).toBe(true);
      expect(seen).toEqual([1, 2]);
      worker.stop();
      await worker.drain({ timeoutMs: 5_000 });
    } finally {
      await sync.drain({ timeoutMs: 5_000 });
      await connection.drain();
    }
  },
  40_000,
);

integration(
  "a scheduler worker comes back after quiesce and runs a run accepted while quiet",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("quiesce-scheduler");
    const controller = createQuiesceController();
    const sync = processSync(connection, namespace, controller);
    try {
      const scheduler = sync.scheduler({ id: "clock" });
      await sync.ready();
      let ran = Promise.withResolvers<void>();
      // Once a year: only manual runs fire during the test.
      await scheduler.create({ id: "yearly", cron: "0 0 1 1 *", timezone: "UTC", process: async () => ran.resolve() });
      const worker = await scheduler.process();

      await controller.quiesce();
      ran = Promise.withResolvers<void>();
      await scheduler.runNow({ id: "yearly", requestId: "while-quiet" });
      expect(await within(ran.promise, 2_000)).toBe(false);

      await controller.resume();
      expect(await within(ran.promise, 15_000)).toBe(true);
      worker.stop();
      await worker.drain({ timeoutMs: 5_000 });
    } finally {
      await sync.drain({ timeoutMs: 5_000 });
      await connection.drain();
    }
  },
  40_000,
);

integration(
  "a resume during a drain that outlives its budget never runs two generations of a worker at once",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("quiesce-race");
    // A short budget: Sync aborts the handler, which ignores it and keeps running.
    const controller = createQuiesceController({ timeoutMs: 300 });
    const sync = processSync(connection, namespace, controller);
    try {
      const job = sync.job<{ n: number }>({ id: "work" });
      await sync.ready();
      let running = 0;
      let most = 0;
      const done: number[] = [];
      const first = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      const worker = await job.process({}, async ({ input }) => {
        running += 1;
        most = Math.max(most, running);
        if (input.n === 1) {
          first.resolve();
          await release.promise;
        }
        running -= 1;
        done.push(input.n);
        if (input.n === 2) second.resolve();
      });

      await job.submit({ key: "one", input: { n: 1 } });
      expect(await within(first.promise, 10_000)).toBe(true);
      const quiet = controller.quiesce();
      const resumed = controller.resume();
      await job.submit({ key: "two", input: { n: 2 } });
      expect((await quiet).length).toBe(1);
      // The drain ended, but the first generation still runs its handler: the second must not start yet.
      expect(await within(second.promise, 2_500)).toBe(false);
      expect(controller.inFlight()).toBe(1);
      release.resolve();
      expect(await resumed).toEqual([]);
      expect(await within(second.promise, 10_000)).toBe(true);
      expect(done.slice(0, 2)).toEqual([1, 2]);
      expect(most).toBe(1);
      worker.stop();
      await worker.drain({ timeoutMs: 5_000 });
    } finally {
      await sync.drain({ timeoutMs: 5_000 });
      await connection.drain();
    }
  },
  40_000,
);

/** Milliseconds until `count` minute boundaries have passed, plus a margin for the broker to publish the tick. */
const untilMinuteBoundaries = (count: number, marginMs: number) => 60_000 * count - (Date.now() % 60_000) + marginMs;

integration(
  "a schedule that missed ticks while quiet runs once after resume",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("quiesce-misfire");
    const controller = createQuiesceController();
    const sync = processSync(connection, namespace, controller);
    try {
      // A whole minute before the next boundary, so setup never races the first tick.
      if (Date.now() % 60_000 > 50_000) await Bun.sleep(untilMinuteBoundaries(1, 500)); // fixed wait: Sync cron ticks follow the wall clock.
      const scheduler = sync.scheduler({ id: "clock" });
      await sync.ready();
      const runs: string[] = [];
      let ran = Promise.withResolvers<void>();
      await scheduler.create({
        id: "every-minute",
        cron: "* * * * *",
        timezone: "UTC",
        misfire: "latest",
        process: async ({ runId }) => {
          runs.push(runId);
          ran.resolve();
        },
      });
      const worker = await scheduler.process();

      await controller.quiesce();
      // Two ticks fall due while no worker serves the schedule.
      await Bun.sleep(untilMinuteBoundaries(2, 3_000)); // fixed wait: Sync cron ticks follow the wall clock.
      expect(runs).toEqual([]);
      const latestTick = Math.floor(Date.now() / 60_000) * 60_000;

      ran = Promise.withResolvers<void>();
      expect(await controller.resume()).toEqual([]);
      expect(await within(ran.promise, 20_000)).toBe(true);
      // The next tick is about 55 s away; any second run now would be a replayed missed tick.
      await Bun.sleep(3_000); // fixed wait: proves that no second missed tick follows.
      expect(runs).toHaveLength(1);
      // The one run is the latest missed tick, not the first: its run id carries the tick's slot.
      const slot = Date.parse(runs[0]!.slice("every-minute:".length));
      expect(slot).toBeGreaterThanOrEqual(latestTick);
      expect(slot).toBeLessThan(latestTick + 60_000);
      worker.stop();
      await worker.drain({ timeoutMs: 5_000 });
    } finally {
      await sync.drain({ timeoutMs: 5_000 });
      await connection.drain();
    }
  },
  240_000,
);
