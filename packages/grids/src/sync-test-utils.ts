import { createSync } from "@k2b/sync";
import { connect } from "@nats-io/transport-node";
import { bindProcessSync, unbindProcessSync } from "@valentinkolb/cloud";

/** Isolated broker resources; never mutates the running application's namespace. */
export const startGridsTestSync = async () => {
  const connection = await connect({
    servers: process.env.NATS_TEST_SERVERS ?? "nats://127.0.0.1:4222",
    ignoreClusterUpdates: true,
  });
  const sync = createSync({ connection, namespace: `grids-test-${Bun.randomUUIDv7()}`, application: "grids" });
  bindProcessSync(sync);
  return async () => {
    await sync.drain({ timeoutMs: 5_000 });
    unbindProcessSync();
    await connection.drain();
  };
};
