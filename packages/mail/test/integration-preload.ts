import { afterAll } from "bun:test";
import { sql } from "bun";
import { createDisposableDatabase, natsServers, testInfra } from "../../../scripts/fixtures/test-infra";
import { deleteTestNamespace } from "../../../scripts/fixtures/test-sync";

/**
 * Integration runs never touch the developer database. The dev stack's
 * app-mail container works on `DATABASE_URL` and would claim the hydration
 * jobs, workflow events and commands the tests create, so every run gets a
 * private `mail_*_test` database that is migrated like a fresh installation
 * and dropped again once the suite finished.
 *
 * The broker is isolated the same way through a private @k2b/sync namespace.
 * Its streams (topics, queues, KV buckets) would otherwise outlive the run, so
 * they are deleted once the process sync has drained. The fixture deletes the
 * process namespace before this hook runs, while the process sync is still
 * live, so the namespace is a separate `test-` namespace rather than one
 * derived from it.
 */
if (testInfra.database && testInfra.nats) {
  const database = await createDisposableDatabase("mail");
  process.env.DATABASE_URL = database.url;

  const namespace = `test-mail-${crypto.randomUUID()}`;
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
      await deleteTestNamespace(natsServers(), namespace);
    } finally {
      await sql.close().catch(() => undefined);
      await database.drop();
    }
  });
}
