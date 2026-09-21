import { createSync, type Sync } from "@k2b/sync";
import { connect } from "@nats-io/transport-node";
import { natsServers } from "../../../../../scripts/fixtures/test-infra";

/** A private Sync namespace on the test broker; `close()` removes every stream it declared. */
export const openSync = async (label: string): Promise<{ sync: Sync; close: () => Promise<void> }> => {
  const connection = await connect({ servers: natsServers(), ignoreClusterUpdates: true });
  const sync = createSync({
    connection,
    namespace: `cloud-contract-${label}-${crypto.randomUUID().slice(0, 8)}`,
    application: "test",
    defaults: { replicas: 1 },
  });
  return {
    sync,
    close: async () => {
      const resources = await sync.resources();
      await sync.drain({ timeoutMs: 5_000 });
      for (const name of new Set(resources.flatMap((resource) => resource.natsNames))) {
        const result = await connection.request(`$JS.API.STREAM.DELETE.${name}`);
        const data = result.json<{ success?: boolean; error?: { err_code?: number } }>();
        if (!data.success && data.error?.err_code !== 10059) throw new Error(`Fixture stream cleanup failed: ${name}`);
      }
      await connection.drain();
    },
  };
};

/** Bounded poll; fails instead of sleeping for a fixed duration. */
export const until = async (check: () => Promise<boolean> | boolean, timeoutMs = 5_000, what = "condition"): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await Bun.sleep(25);
  }
};
