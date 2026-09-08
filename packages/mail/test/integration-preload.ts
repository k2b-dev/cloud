import { afterAll } from "bun:test";

/**
 * Integration runs get a private @k2b/sync namespace so parallel or aborted
 * runs never share broker state. The streams (topics, queues, KV buckets)
 * are replicated and would otherwise outlive the run, so they are deleted
 * once the process sync has drained.
 */
if (process.env.MAIL_INTEGRATION_TESTS === "1") {
  const namespace = `mail-test-${crypto.randomUUID()}`;
  process.env.SYNC_NAMESPACE = namespace;
  process.env.NATS_IGNORE_CLUSTER_UPDATES = "true";
  const { startProcessSync } = await import("@valentinkolb/cloud");
  const runtime = await startProcessSync({ application: "mail" });
  afterAll(async () => {
    await runtime.stop();
    await deleteNamespaceStreams(namespace);
  });
}

// The NATS client packages are dependencies of @k2b/sync and @valentinkolb/cloud, not of this
// app, so they are resolved from those packages; only the members used here are typed.
type CleanupConnection = { drain(): Promise<void> };
type TransportModule = {
  connect(options: { servers: string[]; name: string; ignoreClusterUpdates: boolean }): Promise<CleanupConnection>;
};
type JetStreamModule = {
  jetstreamManager(connection: CleanupConnection): Promise<{
    streams: {
      list(): AsyncIterable<{ config: { name: string; metadata?: Record<string, string> } }>;
      delete(name: string): Promise<boolean>;
    };
  }>;
};
const resolveFrom = (specifier: string, from: string) => Bun.resolveSync(specifier, new URL(".", import.meta.resolve(from)).pathname);

async function deleteNamespaceStreams(namespace: string): Promise<void> {
  const { connect }: TransportModule = await import(resolveFrom("@nats-io/transport-node", "@valentinkolb/cloud"));
  const { jetstreamManager }: JetStreamModule = await import(resolveFrom("@nats-io/jetstream", "@k2b/sync"));
  const servers = (process.env.NATS_SERVERS ?? "").split(",").filter(Boolean);
  const connection = await connect({ servers, name: "mail-test-cleanup", ignoreClusterUpdates: true });
  try {
    const manager = await jetstreamManager(connection);
    for await (const stream of manager.streams.list()) {
      if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
    }
  } finally {
    await connection.drain();
  }
}
