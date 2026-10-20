import "../../../../scripts/fixtures/test-infra";
import { expect } from "bun:test";
import { createSync, type Ephemeral, type EphemeralEvent } from "@k2b/sync";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { createHeartbeat, createRegistryMembership } from "./heartbeat";
import {
  APP_MEMBERSHIP_LOCK_CONFIG,
  APP_REGISTRY_CONFIG,
  type AppInstanceRecord,
  appInstancePrefix,
  CAPABILITY_REGISTRY_CONFIG,
} from "./registry";

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
        const options = { membership, intervalMs: 300 };
        const app = createHeartbeat("test", { instanceId }, { ...options, registry: apps });
        const capability = createHeartbeat("test", { instanceId }, { ...options, registry: capabilities, key: "capabilities/test" });
        heartbeats.push(app, capability);
        const start = async () => {
          await bounded(capability.start(), "Capability start");
          await bounded(app.start(), "App start");
        };
        await start();
        return {
          apps,
          instances,
          capabilities,
          start,
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
      const values = async () =>
        Promise.all(
          ([a.apps, a.capabilities] as const).map(async (registry, index) => {
            const key = index === 0 ? "apps/test" : "capabilities/test";
            const snapshot = await bounded(registry.snapshot({ prefix: key }), "Shared entry snapshot");
            return snapshot.entries.find((entry) => entry.key === key)?.value;
          }),
        );
      await bounded(Bun.sleep(900), "Multiple live refresh intervals");
      expect(await values()).toEqual([{ instanceId: "b" }, { instanceId: "b" }]);
      await bounded(b.stop(), "Stop publisher B");
      const adoptionDeadline = performance.now() + 5_000;
      await bounded(
        (async () => {
          while (!(await values()).every((value) => value?.instanceId === "a")) {
            if (performance.now() >= adoptionDeadline) throw new Error("A did not adopt both orphaned entries");
            await bounded(Bun.sleep(25), "Adoption poll interval");
          }
        })(),
        "A adopts both orphaned entries",
        6_000,
      );
      expect(await values()).toEqual([{ instanceId: "a" }, { instanceId: "a" }]);
      for (const watch of [apps, capabilities]) {
        expect(
          watch.events.filter((event) => event.type === "delete" || event.type === "expire" || event.type === "resync_required"),
        ).toEqual([]);
      }
      // Repeat the original stop ordering after B returns, preserving the last-replica watch assertions.
      await bounded(b.start(), "Restart B");
      await bounded(a.stop(), "Stop A");
      expect(
        (await bounded(b.instances.snapshot({ prefix: appInstancePrefix("test") }), "Instance snapshot")).entries.map(({ key }) => key),
      ).toEqual([`${appInstancePrefix("test")}b`]);
      await bounded(Bun.sleep(200), "Survivor watch observation");
      for (const watch of [apps, capabilities]) {
        expect(
          watch.events.filter((event) => event.type === "delete" || event.type === "expire" || event.type === "resync_required"),
        ).toEqual([]);
      }
      await bounded(b.stop(), "Stop B");
      await bounded(Promise.all([apps.deleted, capabilities.deleted]), "Last replica delete events");
      expect((await bounded(b.instances.snapshot({ prefix: appInstancePrefix("test") }), "Final instance snapshot")).entries).toEqual([]);
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
