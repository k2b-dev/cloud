import { describe, expect, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { connect } from "@nats-io/transport-node";
import { bindProcessSync, unbindProcessSync } from "../../_internal/process-sync";
import { createWorkflowWorker, notifyWorkflowWorker } from "./worker-runtime";

(process.env.CLOUD_DATABASE_TEST === "1" ? describe : describe.skip)("workflow worker wake transport", () => {
  test("local and remote hints wake workers; lost hints recover and stop drains", async () => {
    const connection = await connect({ servers: process.env.SYNC_TEST_SERVERS ?? "nats://127.0.0.1:4222", ignoreClusterUpdates: true });
    const namespace = `test-workflow-wake-${crypto.randomUUID()}`;
    const sync = createSync({ connection, namespace, application: "worker-test", defaults: { replicas: 1 } });
    const remote = createSync({ connection, namespace, application: "publisher-test", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const queue: Array<() => void> = [];
    let calls = 0;
    const worker = createWorkflowWorker({
      appId: "test",
      concurrency: 2,
      recover: async () => {},
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
      await worker.start();
      const local = Promise.withResolvers<void>();
      queue.push(local.resolve);
      notifyWorkflowWorker("test");
      await wait(local.promise);
      // Independent publisher, same public wire contract; provisioning/payload errors fail the test.
      const topic = remote.topic<null>({
        id: "cloud:workflow-wake",
        owner: "cloud",
        retention: { maxAgeMs: 120_000, maxBytes: 1_048_576 },
        maxPayloadBytes: 2000,
      });
      await topic.publish({ tenantId: "test", data: null });
      await Bun.sleep(50);
      const broadcast = Promise.withResolvers<void>();
      queue.push(broadcast.resolve);
      await topic.publish({ tenantId: "test", data: null });
      await wait(broadcast.promise);
      await Bun.sleep(50);
      const recovery = Promise.withResolvers<void>();
      queue.push(recovery.resolve);
      await wait(recovery.promise); // Deliberately no notification.
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
