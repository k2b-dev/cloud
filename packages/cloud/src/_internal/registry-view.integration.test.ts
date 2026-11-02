import { expect, spyOn, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { connectTestNats, natsSuite, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { canUseApp, usableAppIds } from "../services/app-access";
import { bindProcessSync, processSyncReaders, unbindProcessSync } from "./process-sync";
import { appRegistry, getApp, listApps, readAppRegistrySnapshot, watchAppRegistry } from "./registry";
import * as validation from "./registry-validation";

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
    const parse = spyOn(validation, "parseAppRegistryEntry");
    const entry = { id: "demo", name: "Demo", icon: "box", description: "Demo", routes: ["/app/demo"], baseUrl: "http://demo:3000" };
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
        }),
      );
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(parse).toHaveBeenCalledTimes(2);
      expect(nc.stats().outMsgs).toBe(before.outMsgs);
      await registry.upsert({ key: "apps/demo", value: { ...entry, access: { kind: "signedIn" } } });
      const changed = (await getApp("demo"))!;
      expect(changed.access?.kind).toBe("signedIn");
      expect(await canUseApp(null, changed)).toBe(false);
      expect(await usableAppIds(null, await listApps())).toEqual(new Set());
      expect(parse).toHaveBeenCalledTimes(3);
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
      unbindProcessSync();
      await sync.drain();
      await nc.close();
    }
  });
});
