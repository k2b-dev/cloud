import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createSync } from "@k2b/sync";
import { connectTestNats, suiteFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { buildGatewayRouteSnapshot, notifyGatewayDomainsChanged, publishGatewayRouteSnapshot, watchGatewayDomainChanges } from "./gateway";

suiteFor("nats")("gateway domain invalidation", () => {
  test("domain hints reach another gateway subscriber and shutdown drains it", async () => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("gateway-domains");
    const sync = createSync({ connection, namespace, application: "gateway-test", defaults: { replicas: 1 } });
    const remote = createSync({ connection, namespace, application: "domain-writer-test", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    const controller = new AbortController();
    let delivered = Promise.withResolvers<void>();
    let changes = 0;
    const watcher = watchGatewayDomainChanges({
      signal: controller.signal,
      onChange: async () => {
        changes++;
        delivered.resolve();
      },
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Provision exactly the old declaration before the new writer joins it.
      const oldSnapshots = remote.ephemeral({ id: "gateway-route-snapshots", owner: "cloud", ttlMs: 30_000, maxValueBytes: 128_000 });
      await oldSnapshots.ready();
      const snapshot = buildGatewayRouteSnapshot({
        instanceId: "upgrade-test",
        baseUrl: "http://gateway:3000",
        startedAt: Date.UTC(2030, 0, 1),
        routeHash: "[]",
        routeWarnings: [],
        table: { version: 1, builtAt: Date.UTC(2030, 0, 1), routeCount: 0, routes: [] },
        stats: { totalRequests: 0, noRouteCount: 0, byApp: new Map(), byRoute: new Map() },
      });
      await publishGatewayRouteSnapshot(snapshot);
      expect((await oldSnapshots.snapshot()).entries.map((entry) => entry.value)).toEqual([snapshot]);
      const bucket = (await remote.resources()).find((resource) => resource.id === "gateway-route-snapshots");
      expect(bucket).toBeDefined();
      const stored = await connection.request(
        `$JS.API.STREAM.MSG.GET.${bucket!.natsNames[0]}`,
        new TextEncoder().encode(JSON.stringify({ seq: 1 })),
      );
      const message = JSON.parse(new TextDecoder().decode(stored.data));
      expect(Buffer.from(message.message.hdrs, "base64").toString()).toContain("Nats-TTL: 90s");
      const topic = remote.topic<null>({
        id: "cloud:gateway-domain-changes",
        owner: "cloud",
        retention: { maxAgeMs: 120_000, maxBytes: 1_048_576 },
        maxPayloadBytes: 2000,
      });
      // Subscribe and provision before publishing; a local hint validates the writer as well.
      await topic.publish({ tenantId: "default", data: null });
      await Promise.race([
        delivered.promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Domain hint did not reach gateway")), 5_000);
        }),
      ]);
      expect(changes).toBe(1);
      delivered = Promise.withResolvers<void>();
      notifyGatewayDomainsChanged();
      await Promise.race([
        delivered.promise,
        new Promise<never>((_, reject) => {
          clearTimeout(timeout);
          timeout = setTimeout(() => reject(new Error("Committed domain hint did not reach gateway")), 5_000);
        }),
      ]);
      expect(changes).toBe(2);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await watcher;
      await remote.drain();
      await sync.drain();
      for (const resource of await sync.resources())
        for (const name of resource.natsNames) {
          const response = await connection.request(`$JS.API.STREAM.DELETE.${name}`, new Uint8Array(), { timeout: 5_000 });
          expect(JSON.parse(new TextDecoder().decode(response.data))).toMatchObject({ success: true });
        }
      unbindProcessSync();
      await connection.drain();
    }
  });
});
