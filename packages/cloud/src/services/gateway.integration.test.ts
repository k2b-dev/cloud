import { expect, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { connectTestNats, suiteFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { notifyGatewayDomainsChanged, watchGatewayDomainChanges } from "./gateway";

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
