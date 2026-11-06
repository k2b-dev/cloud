import { expect, spyOn, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { connectTestNats, suiteFor, testSyncNamespace } from "../../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../../_internal/process-sync";
import { workWakeOrigin } from "../../_internal/work-wake";
import { createWorkflowWorker, notifyWorkflowWorker } from "./worker-runtime";

suiteFor("nats")("workflow worker wake transport", () => {
  test("local and remote hints wake workers; lost hints recover and stop drains", async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("workflow-wake");
    const sync = createSync({ connection, namespace, application: "worker-test", defaults: { replicas: 1 } });
    const remote = createSync({ connection, namespace, application: "publisher-test", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const queue: Array<() => void> = [];
    let calls = 0;
    let recoveries = 0;
    const worker = createWorkflowWorker({
      appId: "test",
      concurrency: 2,
      recover: async () => {
        recoveries++;
      },
      run: async () => {
        const action = queue.shift();
        if (!action) return false;
        calls++;
        action();
        return true;
      },
    });
    const wait = async (work: Promise<void>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Worker did not wake")), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const intervals = spyOn(globalThis, "setInterval");
      let recoveryTick: (() => void) | undefined;
      try {
        await worker.start();
        const handler = intervals.mock.calls.findLast(([, ms]) => ms === 30_000)?.[0];
        if (typeof handler === "function") recoveryTick = () => handler();
      } finally {
        intervals.mockRestore();
      }
      expect(recoveryTick).toBeDefined();
      const local = Promise.withResolvers<void>();
      queue.push(local.resolve);
      notifyWorkflowWorker("test");
      await wait(local.promise);
      // Independent publisher, same public wire contract; provisioning/payload errors fail the test.
      const topic = remote.topic<{ origin: string } | null>({
        id: "cloud:workflow-wake",
        owner: "cloud",
        retention: { maxAgeMs: 120_000, maxBytes: 1_048_576 },
        maxPayloadBytes: 2000,
      });
      await topic.publish({ tenantId: "test", data: null });
      await Bun.sleep(50);
      const beforeEcho = recoveries;
      await topic.publish({ tenantId: "test", data: { origin: workWakeOrigin } });
      await Bun.sleep(50);
      expect(recoveries).toBe(beforeEcho);
      const broadcast = Promise.withResolvers<void>();
      queue.push(broadcast.resolve);
      await topic.publish({ tenantId: "test", data: { origin: "independent-publisher" } });
      await wait(broadcast.promise);
      await Bun.sleep(50);
      const recovery = Promise.withResolvers<void>();
      queue.push(recovery.resolve);
      recoveryTick?.(); // Deliberately no notification: advance the safety scan deterministically.
      await wait(recovery.promise);
      await worker.stop();
      const restarted = Promise.withResolvers<void>();
      queue.push(restarted.resolve);
      notifyWorkflowWorker("test");
      await Bun.sleep(25);
      expect(calls).toBe(3);
      await worker.start();
      await wait(restarted.promise);
      await worker.stop();
      expect(calls).toBe(4);
    } finally {
      await worker.stop();
      await remote.drain();
      await sync.drain();
      for (const resource of await sync.resources()) {
        for (const name of resource.natsNames) {
          const response = await connection.request(`$JS.API.STREAM.DELETE.${name}`, new Uint8Array(), { timeout: 5_000 });
          expect(JSON.parse(new TextDecoder().decode(response.data))).toMatchObject({ success: true });
        }
      }
      unbindProcessSync();
      await connection.drain();
    }
  });
});
