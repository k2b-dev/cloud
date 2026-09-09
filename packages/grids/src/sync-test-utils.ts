import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { bindProcessSync, unbindProcessSync } from "@k2b/cloud";

/** Isolated broker resources; the returned stop removes only this namespace's streams. */
export const startGridsTestSync = async () => {
  const connection = await connect({
    servers: process.env.SYNC_TEST_SERVERS ?? "nats://127.0.0.1:4222",
    ignoreClusterUpdates: true,
  });
  const namespace = `grids-test-${Bun.randomUUIDv7()}`;
  const sync = createSync({ connection, namespace, application: "grids" });
  bindProcessSync(sync);
  return async () => {
    await sync.drain({ timeoutMs: 5_000 });
    unbindProcessSync();
    const manager = await jetstreamManager(connection);
    for await (const stream of manager.streams.list()) {
      if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
    }
    await connection.drain();
  };
};
