import { bindProcessSync, unbindProcessSync } from "@k2b/cloud";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { requireInfra, testInfra, testSyncNamespace } from "../../../scripts/fixtures/test-infra";

/**
 * Isolated broker session on `CLOUD_TEST_NATS_SERVERS`; `stop` removes only this namespace's streams.
 * The default namespace is derived from the process namespace, so the fixture deletes it even when a
 * test times out before its `stop`. A caller that keeps the session open past the fixture's cleanup,
 * like the verification preload, passes a separate `test-` namespace.
 */
export const connectGridsTestSync = async (namespace = testSyncNamespace("grids")) => {
  await requireInfra("nats");
  const connection = await connect({ servers: testInfra.nats, ignoreClusterUpdates: true });
  const sync = createSync({ connection, namespace, application: "grids", defaults: { replicas: 1 } });
  bindProcessSync(sync);
  const stop = async () => {
    await sync.drain({ timeoutMs: 5_000 });
    unbindProcessSync();
    const manager = await jetstreamManager(connection);
    for await (const stream of manager.streams.list()) {
      if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
    }
    await connection.drain();
  };
  return { connection, namespace, stop };
};

export const startGridsTestSync = async (namespace?: string) => (await connectGridsTestSync(namespace)).stop;
