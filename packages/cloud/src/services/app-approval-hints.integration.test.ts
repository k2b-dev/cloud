import { expect, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { connect } from "@nats-io/transport-node";
import { natsServers, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { syncLoginDecisionHints } from "./app-approval";

suiteFor("nats")("app login decision hints", () => {
  test("a published decision wakes the browser waiting for that request", async () => {
    const connection = await connect({ servers: natsServers(), ignoreClusterUpdates: true });
    const sync = createSync({
      connection,
      namespace: `test-app-login-${crypto.randomUUID()}`,
      application: "core-test",
      defaults: { replicas: 1 },
    });
    bindProcessSync(sync);
    const waiting = new AbortController();
    try {
      const requestId = crypto.randomUUID();
      let woke = false;
      const done = syncLoginDecisionHints.wait(requestId, waiting.signal).then(() => {
        woke = !waiting.signal.aborted;
      });
      // Core NATS subscriptions register without an acknowledgement, so repeat the hint until it lands.
      for (let attempt = 0; attempt < 50 && !woke; attempt++) {
        syncLoginDecisionHints.publish(requestId);
        await Promise.race([done, Bun.sleep(100)]);
      }
      expect(woke).toBe(true);
    } finally {
      waiting.abort();
      await sync.drain();
      for (const resource of await sync.resources())
        for (const name of resource.natsNames)
          await connection.request(`$JS.API.STREAM.DELETE.${name}`, new Uint8Array(), { timeout: 5_000 });
      unbindProcessSync();
      await connection.drain();
    }
  });
});
