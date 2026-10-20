import "../../../../scripts/fixtures/test-infra";
import { expect } from "bun:test";
import { createSync, type Ephemeral, type EphemeralEvent } from "@k2b/sync";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { createHeartbeat, createRegistryMembership } from "./heartbeat";
import { APP_MEMBERSHIP_LOCK_CONFIG, APP_REGISTRY_CONFIG, type AppInstanceRecord, CAPABILITY_REGISTRY_CONFIG } from "./registry";

const integration = testFor("nats");
const bounded = async <T>(operation: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> => {
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

integration(
  "real replica stops preserve app and capability watches until the last replica leaves",
  async () => {
    const namespace = testSyncNamespace("heartbeat-membership");
    const connections: Awaited<ReturnType<typeof connectTestNats>>[] = [];
    const syncs: ReturnType<typeof createSync>[] = [];
    const heartbeats: ReturnType<typeof createHeartbeat>[] = [];
    const watchers: Promise<void>[] = [];
    const controller = new AbortController();
    try {
      const process = async (instanceId: string) => {
        const connection = await connectTestNats({ ignoreClusterUpdates: true, timeout: 3_000, maxReconnectAttempts: 0 });
        connections.push(connection);
        const sync = createSync({ connection, namespace, application: "heartbeat-test", defaults: { replicas: 1 } });
        syncs.push(sync);
        const apps = sync.ephemeral<{ instanceId: string }>(APP_REGISTRY_CONFIG);
        const instances = sync.ephemeral<AppInstanceRecord>(APP_REGISTRY_CONFIG);
        const capabilities = sync.ephemeral<{ instanceId: string }>(CAPABILITY_REGISTRY_CONFIG);
        const lock = sync.mutex(APP_MEMBERSHIP_LOCK_CONFIG);
        await bounded(sync.ready(), "Sync ready");
        const membership = createRegistryMembership("test", { registry: () => instances, lock: () => lock, instanceId, startedAt: 0 });
        const options = { membership, intervalMs: 3_600_000 };
        const app = createHeartbeat("test", { instanceId }, { ...options, registry: apps });
        const capability = createHeartbeat("test", { instanceId }, { ...options, registry: capabilities, key: "capabilities/test" });
        heartbeats.push(app, capability);
        await bounded(capability.start(), "Capability start");
        await bounded(app.start(), "App start");
        return {
          apps,
          instances,
          capabilities,
          stop: async () => {
            await app.stop();
            await capability.stop();
          },
        };
      };
      const a = await process("a"),
        b = await process("b");
      const observe = (registry: Ephemeral<{ instanceId: string }>, prefix: string) => {
        const events: EphemeralEvent<{ instanceId: string }>[] = [];
        const ready = Promise.withResolvers<void>(),
          deleted = Promise.withResolvers<void>();
        const watch = (async () => {
          try {
            for await (const event of registry.watch({ prefix, signal: controller.signal })) {
              events.push(event);
              if (event.type === "resync_required") throw new Error("Registry watch needs resync");
              if (event.type === "upsert" && event.entry.key === `${prefix}test`) ready.resolve();
              if (event.type === "delete" && event.key === `${prefix}test`) deleted.resolve();
            }
          } catch (error) {
            ready.reject(error);
            deleted.reject(error);
          }
        })();
        watchers.push(watch);
        // Attach rejection handlers before either watch can fail.
        void ready.promise.catch(() => {});
        void deleted.promise.catch(() => {});
        return { events, ready: ready.promise, deleted: deleted.promise };
      };
      // These are the exact prefixes followed by readers, including the gateway.
      const apps = observe(b.apps, "apps/"),
        capabilities = observe(b.capabilities, "capabilities/");
      await bounded(Promise.all([apps.ready, capabilities.ready]), "Initial registry watch replay");
      await bounded(a.stop(), "Stop A");
      expect(
        (await bounded(b.instances.snapshot({ prefix: "instances/test/" }), "Instance snapshot")).entries.map(({ key }) => key),
      ).toEqual(["instances/test/b"]);
      await Bun.sleep(200);
      for (const watch of [apps, capabilities]) {
        expect(
          watch.events.filter((event) => event.type === "delete" || event.type === "expire" || event.type === "resync_required"),
        ).toEqual([]);
      }
      await bounded(b.stop(), "Stop B");
      await bounded(Promise.all([apps.deleted, capabilities.deleted]), "Last replica delete events");
      expect((await bounded(b.instances.snapshot({ prefix: "instances/test/" }), "Final instance snapshot")).entries).toEqual([]);
    } finally {
      controller.abort();
      const results = await Promise.allSettled([
        ...watchers.map((watch) => bounded(watch, "Watch shutdown")),
        ...heartbeats.map((heartbeat) => bounded(heartbeat.stop(), "Heartbeat cleanup")),
      ]);
      const drains = await Promise.allSettled(syncs.map((sync) => sync.drain({ timeoutMs: 5_000 })));
      const closes = await Promise.allSettled(connections.map((connection) => bounded(connection.close(), "NATS close")));
      for (const result of [...results, ...drains, ...closes]) if (result.status === "rejected") throw result.reason;
    }
  },
  30_000,
);
