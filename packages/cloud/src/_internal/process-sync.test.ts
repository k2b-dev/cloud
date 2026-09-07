import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as syncModule from "@k2b/sync";
import { env } from "../config/env";
import * as nats from "./nats-connection";
import { getProcessSync, lazySync, startProcessSync } from "./process-sync";

// Explicit opt-in keeps unit test runs independent of a local NATS cluster.
const suite = process.env.NATS_SERVERS ? describe : describe.skip;
const namespaceDescriptor = Object.getOwnPropertyDescriptor(env, "SYNC_NAMESPACE")!;
afterEach(() => Object.defineProperty(env, "SYNC_NAMESPACE", namespaceDescriptor));
const isolate = () => Object.defineProperty(env, "SYNC_NAMESPACE", { value: `test-process-${crypto.randomUUID()}`, configurable: true });

suite("process Sync lifecycle", () => {
  test("binds one instance, declares lazily, pins replication and drains once", async () => {
    isolate();
    let calls = 0;
    const primitive = lazySync((sync) => {
      calls++;
      return sync.mutex({ id: "lazy" });
    });
    const create = syncModule.createSync;
    let config: Parameters<typeof create>[0] | undefined;
    const createSpy = spyOn(syncModule, "createSync").mockImplementation((input) => {
      config = input;
      return create(input);
    });
    const runtime = await startProcessSync({ application: "test-app" });
    const drainSpy = spyOn(runtime.sync, "drain");
    try {
      expect(config?.defaults?.replicas).toBe(3);
      expect(calls).toBe(0);
      expect(primitive()).toBe(primitive());
      expect(calls).toBe(1);
      expect(getProcessSync()).toBe(runtime.sync);
      await expect(startProcessSync({ application: "second" })).rejects.toThrow("already");
      const first = runtime.stop();
      expect(runtime.stop()).toBe(first);
      await first;
      expect(drainSpy).toHaveBeenCalledTimes(1);
      expect(() => getProcessSync()).toThrow("not available");
    } finally {
      await runtime.stop();
      drainSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  test("closes failed startup and allows a later clean start", async () => {
    isolate();
    const connect = nats.connectNats;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    const connectSpy = spyOn(nats, "connectNats").mockImplementation(async (input) => (connection = await connect(input)));
    const create = syncModule.createSync;
    const createSpy = spyOn(syncModule, "createSync").mockImplementation((input) => {
      const sync = create(input);
      spyOn(sync, "ready").mockRejectedValue(new Error("readiness fixture"));
      return sync;
    });
    try {
      await expect(startProcessSync({ application: "test-app" })).rejects.toThrow("readiness fixture");
      expect(connection?.isClosed()).toBe(true);
      expect(() => getProcessSync()).toThrow("not available");
    } finally {
      createSpy.mockRestore();
      connectSpy.mockRestore();
    }
    const runtime = await startProcessSync({ application: "test-app" });
    await runtime.stop();
  });
});

// Run only by explicit coordination: this stops one named local Compose node.
// Example: CLOUD_SYNC_FAILOVER_CONTAINER=ipa_nats_2 NATS_SERVERS=nats://127.0.0.1:4222 bun test <this-file>
const failoverTest = process.env.CLOUD_SYNC_FAILOVER_CONTAINER ? test : test.skip;
failoverTest(
  "retains accepted topic events during one explicitly selected node outage",
  async () => {
    isolate();
    const container = process.env.CLOUD_SYNC_FAILOVER_CONTAINER!;
    const docker = async (action: "stop" | "start") => {
      const child = Bun.spawn(["docker", action, container], { stdout: "pipe", stderr: "pipe" });
      const status = await child.exited;
      if (status !== 0) throw new Error(`docker ${action} ${container}: ${await new Response(child.stderr).text()}`);
    };
    const create = syncModule.createSync;
    let connection: Parameters<typeof create>[0]["connection"] | undefined;
    const createSpy = spyOn(syncModule, "createSync").mockImplementation((config) => {
      connection = config.connection;
      return create(config);
    });
    const runtime = await startProcessSync({ application: "test-failover" });
    let outageStarted = false;
    try {
      const topic = runtime.sync.topic<{ sequence: number }>({
        id: "continuity",
        retention: { maxAgeMs: 60_000, maxBytes: 1_048_576 },
        dedupeWindowMs: 60_000,
        maxPayloadBytes: 1024,
      });
      await runtime.sync.ready();
      await topic.publish({ data: { sequence: 1 } });
      outageStarted = true;
      await docker("stop");
      const second = await topic.publish({ data: { sequence: 2 } });
      const seen: number[] = [];
      for await (const event of topic.replay({ after: topic.cursorAt(0), until: second.cursor })) seen.push(event.data.sequence);
      expect(seen).toEqual([1, 2]);
      await docker("start");
      outageStarted = false;
      expect(runtime.sync.health().connection).toBe("connected");
    } finally {
      try {
        if (outageStarted) await docker("start");
        // Delete only stream names declared in this test's isolated namespace.
        for (const resource of await runtime.sync.resources()) {
          for (const name of resource.natsNames) {
            const response = await connection!.request(`$JS.API.STREAM.DELETE.${name}`, new Uint8Array(), { timeout: 10_000 });
            expect(JSON.parse(new TextDecoder().decode(response.data))).toMatchObject({ success: true });
          }
        }
      } finally {
        await runtime.stop();
        createSpy.mockRestore();
      }
    }
  },
  60_000,
);
