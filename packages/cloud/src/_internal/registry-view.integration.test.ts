import { expect, spyOn, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { z } from "zod";
import { connectTestNats, natsSuite, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { defineCapabilities } from "../contracts/capabilities";
import { canUseApp, usableAppIds } from "../services/app-access";
import { compileCapabilities } from "./capabilities";
import { createObservedView } from "./observed-view";
import { bindProcessSync, processSyncReaders, unbindProcessSync } from "./process-sync";
import {
  APP_REGISTRY_CONFIG,
  APP_REGISTRY_TTL_MS,
  appRegistry,
  CAPABILITY_REGISTRY_CONFIG,
  type CapabilityRegistryRecord,
  capabilityRegistry,
  getApp,
  getCapability,
  listApps,
  listCapabilities,
  readAppRegistrySnapshot,
  watchAppRegistry,
  watchRuntimeRegistry,
} from "./registry";
import * as validation from "./registry-validation";
import { watchRegistryChanges } from "./registry-watch";

natsSuite()("process-local app registry", () => {
  test("public reads share one snapshot and validation, and observe access revisions and removal", async () => {
    const nc = await connectTestNats({ ignoreClusterUpdates: true });
    const sync = createSync({
      connection: nc,
      namespace: testSyncNamespace("registry-view"),
      application: "test",
      defaults: { replicas: 1 },
    });
    bindProcessSync(sync, nc);
    const registry = appRegistry();
    const snapshot = spyOn(registry, "snapshot");
    const capRegistry = capabilityRegistry();
    const capabilitySnapshot = spyOn(capRegistry, "snapshot");
    const compiled = compileCapabilities(
      "demo",
      defineCapabilities({
        protocolVersion: 2,
        queries: {
          ping: {
            title: "Ping",
            description: "Read a value.",
            input: z.object({}).strict(),
            data: z.string(),
            openWorld: false,
            run: async () => {
              throw new Error("not called");
            },
          },
        },
      }),
    );
    const record: CapabilityRegistryRecord = { appId: "demo", manifest: compiled.manifest };
    const parse = spyOn(validation, "parseAppRegistryEntry");
    const entry = {
      id: "demo",
      name: "Demo",
      icon: "box",
      description: "Demo",
      routes: ["/app/demo"],
      baseUrl: "http://demo:3000",
      capabilities: { protocolVersion: 2 as const, manifestHash: compiled.manifest.manifestHash },
    };
    const until = async (check: () => Promise<boolean>) => {
      const deadline = performance.now() + 2_000;
      while (!(await check())) {
        if (performance.now() > deadline) throw new Error("Registry view did not receive the change");
        await Bun.sleep(1);
      }
    };
    try {
      await sync.ready();
      await registry.upsert({ key: "apps/demo", value: entry });
      await capRegistry.upsert({ key: "capabilities/demo", value: record });
      expect(await getCapability("demo")).toMatchObject({ appId: "demo" });
      expect(await getApp("demo")).toMatchObject(entry);
      // Wait for watch setup using a covering event from the raw source.
      const raw = sync.ephemeral<typeof entry>({ id: "cloud-apps", owner: "cloud", ttlMs: 180_000, maxValueBytes: 64 * 1024 });
      const touched = await raw.upsert({ key: "apps/demo", value: entry });
      await until(async () => (await readAppRegistrySnapshot()).apps[0]?.version === touched.revision);
      expect(await canUseApp(null, (await getApp("demo"))!)).toBe(true);
      const before = nc.stats();
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          expect(await getApp("demo")).toMatchObject(entry);
          expect(await listApps()).toHaveLength(1);
          expect(await listCapabilities()).toHaveLength(1);
          expect(await getCapability("demo")).toMatchObject({ appId: "demo" });
        }),
      );
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(nc.stats().outMsgs).toBe(before.outMsgs);
      expect(capabilitySnapshot).toHaveBeenCalledTimes(1);
      const rawCapabilities = sync.ephemeral<CapabilityRegistryRecord>({
        id: "cloud-capabilities",
        owner: "cloud",
        ttlMs: 180_000,
        maxValueBytes: 512 * 1024,
      });
      const runtimeController = new AbortController();
      let capabilityTitle: string | undefined;
      let refreshes = 0;
      const runtimeWatch = watchRuntimeRegistry({
        signal: runtimeController.signal,
        onChange: async () => {
          refreshes++;
          capabilityTitle = (await getCapability("demo"))?.presentation?.translations.de?.queries?.ping?.title;
        },
      });
      const livenessController = new AbortController();
      let observedLease: string | undefined;
      const livenessWatch = watchAppRegistry({
        signal: livenessController.signal,
        onChange: async () => {
          observedLease = (await readAppRegistrySnapshot()).apps.find((app) => app.id === "demo")?.version;
        },
      });
      try {
        await until(async () => refreshes === 1);
        await until(async () => observedLease === touched.revision);
        await rawCapabilities.upsert({
          key: "capabilities/demo",
          value: {
            ...record,
            presentation: {
              baseLocale: "en",
              translations: { de: { queries: { ping: { title: "Neu", description: "Liest einen Wert." } } } },
            },
          },
        });
        await until(async () => capabilityTitle === "Neu");
        expect(refreshes).toBe(2); // capability-only changes do not wait for an app heartbeat
        expect(capabilitySnapshot).toHaveBeenCalledTimes(1);
        const beforeHeartbeat = nc.stats().outMsgs;
        const heartbeat = await raw.upsert({ key: "apps/demo", value: entry });
        const afterWrite = nc.stats().outMsgs;
        await until(async () => observedLease === heartbeat.revision);
        // Core's skill retries and gateway-ops' lastSeenAt get the renewed lease,
        // while runtime consumers and content validation remain idle.
        expect(refreshes).toBe(2);
        expect(parse).toHaveBeenCalledTimes(1);
        expect(snapshot).toHaveBeenCalledTimes(1);
        expect(nc.stats().outMsgs).toBe(afterWrite);
        expect(afterWrite - beforeHeartbeat).toBeGreaterThan(0);
      } finally {
        livenessController.abort();
        runtimeController.abort();
        await livenessWatch;
        await runtimeWatch;
      }
      // Local touch applies the acknowledged lease without restarting the watch or revalidating content.
      await registry.touch({ key: "apps/demo" });
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(parse).toHaveBeenCalledTimes(1);
      await registry.upsert({ key: "apps/demo", value: { ...entry, access: { kind: "signedIn" } } });
      const changed = (await getApp("demo"))!;
      expect(changed.access?.kind).toBe("signedIn");
      expect(await canUseApp(null, changed)).toBe(false);
      expect(await usableAppIds(null, await listApps())).toEqual(new Set());
      expect(parse).toHaveBeenCalledTimes(2);
      await registry.delete({ key: "apps/demo" });
      expect(await getApp("demo")).toBeNull();
      expect(await usableAppIds(null, await listApps())).toEqual(new Set());
      expect(await listApps()).toEqual([]);
      expect(snapshot).toHaveBeenCalledTimes(3);
      // A second registry watcher must never refresh consumers from an older view.
      const controller = new AbortController();
      let observed: string | null | undefined;
      const watcher = watchAppRegistry({
        signal: controller.signal,
        onChange: async () => {
          const app = await getApp("demo");
          observed = app ? (app.access?.kind ?? "legacy") : null;
        },
      });
      try {
        await raw.upsert({ key: "apps/demo", value: entry });
        await until(async () => observed === "legacy");
        await registry.upsert({ key: "apps/demo", value: { ...entry, access: { kind: "signedIn" } } });
        await until(async () => observed === "signedIn");
        await raw.delete({ key: "apps/demo" });
        await until(async () => observed === null);
      } finally {
        controller.abort();
        await watcher;
      }
      // Stops readers while the NATS status next() is idle, before closing transport.
      await Promise.all([...processSyncReaders().stops].map((stop) => stop()));
    } finally {
      parse.mockRestore();
      snapshot.mockRestore();
      capabilitySnapshot.mockRestore();
      unbindProcessSync();
      await sync.drain();
      await nc.close();
    }
  });
});

natsSuite()("registry idle scaling", () => {
  test("5 and 20 apps keep idle NATS requests linear and content rebuilds at zero", async () => {
    const results = [];
    for (const count of [5, 20]) {
      const reader = await connectTestNats({ ignoreClusterUpdates: true });
      const writer = await connectTestNats({ ignoreClusterUpdates: true });
      const namespace = testSyncNamespace(`registry-idle-${count}`);
      const makeSync = (connection: typeof reader) => createSync({ connection, namespace, application: "test", defaults: { replicas: 1 } });
      const readers = makeSync(reader);
      const writes = makeSync(writer);
      const controller = new AbortController();
      let snapshots = 0;
      let watches = 0;
      let rebuilds = 0;
      const configurations = [APP_REGISTRY_CONFIG, CAPABILITY_REGISTRY_CONFIG];
      const prefixes = ["apps/", "capabilities/"];
      const sources = configurations.map((config) => readers.ephemeral<{ content: string }>(config));
      const targets = configurations.map((config) => writes.ephemeral<{ content: string }>(config));
      const views = Array.from({ length: count }, () =>
        sources.map((source, index) =>
          createObservedView({
            registry: {
              snapshot: (input) => {
                snapshots++;
                return source.snapshot(input);
              },
              watch: (input) => {
                watches++;
                return source.watch(input);
              },
            },
            prefix: prefixes[index]!,
            ttlMs: APP_REGISTRY_TTL_MS,
            signal: controller.signal,
            read: (entry) => entry.value,
          }),
        ),
      );
      const tasks: Promise<void>[] = [];
      const until = async (check: () => Promise<boolean>) => {
        const deadline = performance.now() + 2_000;
        while (!(await check())) {
          if (performance.now() > deadline) throw new Error("Registry watches did not cover the acknowledged write");
          await Bun.sleep(1);
        }
      };
      const publish = async (index: number, app: number) => {
        const key = `${prefixes[index]}app-${app}`;
        const entry = await targets[index]!.upsert({ key, value: { content: "unchanged" } });
        await until(async () =>
          (await Promise.all(views.map((process) => process[index]!.entries()))).every((entries) =>
            entries.some((value) => value.key === key && value.revision === entry.revision),
          ),
        );
      };
      try {
        await readers.ready();
        await writes.ready();
        for (let app = 0; app < count; app++)
          for (let index = 0; index < 2; index++)
            await targets[index]!.upsert({ key: `${prefixes[index]}app-${app}`, value: { content: "unchanged" } });
        for (const view of views.flat()) {
          await view.values();
          tasks.push(
            watchRegistryChanges({
              signal: controller.signal,
              watch: (signal) => view.changes(signal, { initial: false }),
              onChange: async () => {
                await view.values();
                rebuilds++;
              },
            }),
          );
        }
        // Cover watch setup before measuring; identical writes do not change content.
        await publish(0, 0);
        await publish(1, 0);
        const before = { snapshots, watches, rebuilds, readerRequests: reader.stats().outMsgs, writerRequests: writer.stats().outMsgs };
        for (let app = 0; app < count; app++) for (let index = 0; index < 2; index++) await publish(index, app);
        for (let second = 0; second < 60; second++) for (const view of views.flat()) await view.values();
        const result = {
          apps: count,
          snapshots: snapshots - before.snapshots,
          watches: watches - before.watches,
          rebuilds: rebuilds - before.rebuilds,
          readerRequests: reader.stats().outMsgs - before.readerRequests,
          writerRequests: writer.stats().outMsgs - before.writerRequests,
        };
        results.push(result);
        expect(result.snapshots).toBe(0);
        expect(result.watches).toBe(0);
        expect(result.rebuilds).toBe(0);
        expect(result.readerRequests).toBe(0);
      } finally {
        controller.abort();
        await Promise.all(tasks);
        await Promise.all(views.flat().map((view) => view.stop()));
        await readers.drain();
        await writes.drain();
        await reader.close();
        await writer.close();
      }
    }
    console.info("NATS registry idle operation counts", JSON.stringify(results));
    expect(results[1]!.writerRequests).toBeLessThanOrEqual(results[0]!.writerRequests * 4);
  });
});

natsSuite()("capability polling", () => {
  test("60 reads per observer with 5 and 20 apps use no NATS snapshots", async () => {
    const results = [];
    for (const count of [5, 20]) {
      const nc = await connectTestNats({ ignoreClusterUpdates: true });
      const sync = createSync({
        connection: nc,
        namespace: testSyncNamespace(`capability-poll-${count}`),
        application: "test",
        defaults: { replicas: 1 },
      });
      bindProcessSync(sync, nc);
      const registry = capabilityRegistry();
      const snapshot = spyOn(registry, "snapshot");
      try {
        await sync.ready();
        for (let index = 0; index < count; index++) {
          const id = `app-${index}`;
          const compiled = compileCapabilities(id, defineCapabilities({ protocolVersion: 2 }));
          await appRegistry().upsert({
            key: `apps/${id}`,
            value: {
              id,
              name: id,
              icon: "box",
              description: "Test app",
              routes: [`/app/${id}`],
              baseUrl: `http://${id}:3000`,
              capabilities: { protocolVersion: 2, manifestHash: compiled.manifest.manifestHash },
            },
          });
          await registry.upsert({ key: `capabilities/${id}`, value: { appId: id, manifest: compiled.manifest } });
        }
        expect(await listCapabilities()).toHaveLength(count);
        // A covering app event also lets both watch consumers finish their setup.
        const raw = sync.ephemeral<import("../contracts/registry").AppRegistryEntry>(APP_REGISTRY_CONFIG);
        const renewed = await raw.upsert({ key: "apps/app-0", value: (await getApp("app-0"))! });
        const deadline = performance.now() + 2_000;
        while ((await readAppRegistrySnapshot()).apps.find((app) => app.id === "app-0")?.version !== renewed.revision) {
          if (performance.now() > deadline) throw new Error("App watch did not cover the write");
          await Bun.sleep(1);
        }
        await nc.flush();
        const before = { snapshots: snapshot.mock.calls.length, requests: nc.stats().outMsgs };
        for (let observer = 0; observer < count; observer++)
          for (let second = 0; second < 60; second++) expect(await listCapabilities()).toHaveLength(count);
        results.push({
          apps: count,
          reads: count * 60,
          snapshots: snapshot.mock.calls.length - before.snapshots,
          requests: nc.stats().outMsgs - before.requests,
        });
      } finally {
        snapshot.mockRestore();
        await Promise.all([...processSyncReaders().stops].map((stop) => stop()));
        unbindProcessSync();
        await sync.drain();
        await nc.close();
      }
    }
    console.info("capability polling operation counts", JSON.stringify(results));
    for (const result of results) {
      expect(result.snapshots).toBe(0);
      expect(result.requests).toBe(0);
    }
  });
});
