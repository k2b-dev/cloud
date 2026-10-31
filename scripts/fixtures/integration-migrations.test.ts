import { afterAll, expect, test } from "bun:test";
import { closePlatformClients, sql } from "../../packages/cloud/src/runtime/clients";
import { connections } from "../../packages/cloud/src/runtime/connections";
import { migrateIntegrationDatabase } from "./integration-migrations";
import { requireDatabaseUrl, suiteFor } from "./test-infra";

afterAll(closePlatformClients);

suiteFor("database")("direct migration fixture", () => {
  test("initializes the selected target before loading production migrations", async () => {
    await migrateIntegrationDatabase();
    expect(connections().database.url).toBe(requireDatabaseUrl());
    const [row] = await sql`SELECT current_database() AS name, to_regclass('settings.entries') IS NOT NULL AS migrated`;
    expect(row.name).toBe(decodeURIComponent(new URL(requireDatabaseUrl()).pathname.slice(1)));
    expect(row.migrated).toBe(true);
  }, 120_000);
});
