import { afterAll } from "bun:test";
import { createDisposableDatabase, testInfra } from "../../../scripts/fixtures/test-infra";

/**
 * Integration runs never touch the developer database. The dev stack's
 * app-mail container works on `DATABASE_URL` and would claim the hydration
 * jobs, workflow events and commands the tests create, so every run gets a
 * private `mail_*_test` database that is migrated like a fresh installation
 * and dropped again once the suite finished.
 *
 * The broker is isolated the same way through a private @k2b/sync namespace.
 * Its streams (topics, queues, KV buckets) are replicated and would otherwise
 * outlive the run, so they are deleted once the process sync has drained.
 */
if (testInfra.database && testInfra.nats) {
  const database = await createDisposableDatabase("mail");
  process.env.DATABASE_URL = database.url;

  const namespace = `mail-test-${crypto.randomUUID()}`;
  process.env.SYNC_NAMESPACE = namespace;
  const { startProcessSync } = await import("@k2b/cloud");
  const runtime = await startProcessSync({ application: "mail" }).catch(async (error: unknown) => {
    await database.drop();
    throw error;
  });

  // Core owns the schemas Mail references (auth, audit, workflows, notifications,
  // capabilities, ai); Mail owns everything in the `mail` schema. Tests create
  // their own users, mailboxes and provider connections, so no data is seeded.
  try {
    const { runCoreSetup } = await import("../../core/src/runtime-helpers");
    await runCoreSetup();
    const { migrate } = await import("../src/migrate");
    await migrate();
  } catch (error) {
    await runtime.stop();
    await database.drop();
    throw error;
  }

  afterAll(async () => {
    try {
      await runtime.stop();
      await deleteNamespaceStreams(namespace);
    } finally {
      const { sql } = await import("bun");
      await sql.close().catch(() => undefined);
      await database.drop();
    }
  });
}

// The NATS client packages are dependencies of @k2b/sync and @k2b/cloud, not of this
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
  const { connect }: TransportModule = await import(resolveFrom("@nats-io/transport-node", "@k2b/cloud"));
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
