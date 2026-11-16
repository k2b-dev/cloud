import { expect } from "bun:test";
import { createSync } from "@k2b/sync";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { createQuiesceController, withQuiesce } from "./runtime-quiesce";

const integration = testFor("nats");

/** Resolves with `true` once `done` resolves, or `false` after `ms`. */
const within = (done: Promise<unknown>, ms: number) =>
  Promise.race([done.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

integration(
  "a quiesced job worker takes no work, and on resume the same handle processes what waited",
  async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("quiesce-job");
    const controller = createQuiesceController();
    const sync = withQuiesce(createSync({ connection, namespace, application: "quiesce-test", defaults: { replicas: 1 } }), controller);
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
    const sync = withQuiesce(createSync({ connection, namespace, application: "quiesce-test", defaults: { replicas: 1 } }), controller);
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
