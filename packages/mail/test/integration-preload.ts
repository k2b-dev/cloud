import { afterAll } from "bun:test";
import { SQL } from "bun";

/**
 * Integration runs never touch the developer database. The dev stack's
 * app-mail container works on `DATABASE_URL` and would claim the hydration
 * jobs, workflow events and commands the tests create, so every run gets a
 * private `cloud_mail_test_*` database that is migrated like a fresh
 * installation and dropped again once the suite finished.
 *
 * The broker is isolated the same way through a private @k2b/sync namespace.
 * Its streams (topics, queues, KV buckets) are replicated and would otherwise
 * outlive the run, so they are deleted once the process sync has drained.
 */
if (process.env.MAIL_INTEGRATION_TESTS === "1") {
  process.env.NATS_SERVERS ||= "nats://localhost:4222";
  const database = await createPrivateDatabase();

  const namespace = `mail-test-${crypto.randomUUID()}`;
  process.env.SYNC_NAMESPACE = namespace;
  process.env.NATS_IGNORE_CLUSTER_UPDATES = "true";
  const { startProcessSync } = await import("@k2b/cloud");
  const runtime = await startProcessSync({ application: "mail" });

  // Core owns the schemas Mail references (auth, audit, workflows, notifications,
  // capabilities, ai); Mail owns everything in the `mail` schema. Tests create
  // their own users, mailboxes and provider connections, so no data is seeded.
  const { runCoreSetup } = await import("../../core/src/runtime-helpers");
  await runCoreSetup();
  const { migrate } = await import("../src/migrate");
  await migrate();

  afterAll(async () => {
    await runtime.stop();
    await deleteNamespaceStreams(namespace);
    await database.drop();
  });
}

async function createPrivateDatabase(): Promise<{ name: string; drop: () => Promise<void> }> {
  const source = new URL(process.env.DATABASE_URL ?? "postgres://localhost/unconfigured");
  if (!["localhost", "127.0.0.1"].includes(source.hostname))
    throw new Error(
      `Mail integration tests provision their own database and refuse to do that on "${source.hostname}". Point DATABASE_URL at localhost.`,
    );

  const name = `cloud_mail_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(source);
  adminUrl.pathname = "/postgres";
  const admin = new SQL(adminUrl.toString());
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.close();

  const target = new URL(source);
  target.pathname = `/${name}`;
  process.env.DATABASE_URL = target.toString();

  return {
    name,
    drop: async () => {
      const { sql } = await import("bun");
      await sql.close().catch(() => undefined);
      const cleanup = new SQL(adminUrl.toString());
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.close();
      }
    },
  };
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
