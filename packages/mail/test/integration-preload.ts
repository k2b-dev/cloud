import { afterAll } from "bun:test";
import { createMigratedDatabase, initializeTestPlatform, requireInfra, testInfra } from "../../../scripts/fixtures/test-infra";
import { deleteTestNamespace } from "../../../scripts/fixtures/test-sync";
import { closePlatformClients } from "../../cloud/src/runtime/clients";

/**
 * Integration runs never touch the developer database. The dev stack's
 * app-mail container works on `DATABASE_URL` and would claim the hydration
 * jobs, workflow events and commands the tests create, so every run gets a
 * private `mail_*_test` database cloned from the migrated integration template
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
  // The process sync below connects before any suite checks the NATS test identity.
  await requireInfra("nats");
  const database = await createMigratedDatabase("mail");
  process.env.DATABASE_URL = database.url;

  const namespace = `test-mail-${crypto.randomUUID()}`;
  process.env.SYNC_NAMESPACE = namespace;
  await initializeTestPlatform("mail");
  const { startProcessSync } = await import("@k2b/cloud");
  const runtime = await startProcessSync({ application: "mail" }).catch(async (error: unknown) => {
    await database.drop();
    throw error;
  });

  afterAll(async () => {
    try {
      await runtime.stop();
      await deleteTestNamespace(namespace);
    } finally {
      await closePlatformClients();
      await database.drop();
    }
  });
}
