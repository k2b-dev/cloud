import { expect, test } from "bun:test";
import { initializeTestPlatform, requireDatabaseUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { createSql, sql } from "../runtime/clients";
import { connections, hasConnections } from "../runtime/connections";

const suite = suiteFor("database");
suite("platform Postgres connection identity", () => {
  for (const operator of [false, true]) {
    test(`names every native pool connection (operator URL: ${operator})`, async () => {
      const previousAppId = hasConnections() ? connections().appId : "integration-test";
      const url = new URL(requireDatabaseUrl());
      if (operator) url.searchParams.set("application_name", "operator-owned");
      process.env.DATABASE_URL = url.toString();
      await initializeTestPlatform("diagnostics-test");
      const pool = createSql({ max: 3 });
      const leases: Awaited<ReturnType<typeof pool.reserve>>[] = [];
      try {
        for (let index = 0; index < 3; index++) leases.push(await pool.reserve());
        const rows = await Promise.all(
          leases.map(async (lease) => (await lease`SELECT current_setting('application_name') AS name, pg_backend_pid() AS pid`)[0]),
        );
        expect(rows.map((row) => row.name)).toEqual(Array(3).fill(operator ? "operator-owned" : "cloud:diagnostics-test"));
        expect(new Set(rows.map((row) => row.pid)).size).toBe(3);
        expect(await sql.begin(async (tx) => (await tx`SELECT current_setting('application_name') AS name`)[0].name)).toBe(
          operator ? "operator-owned" : "cloud:diagnostics-test",
        );
      } finally {
        for (const lease of leases) lease.release();
        await pool.close();
        process.env.DATABASE_URL = requireDatabaseUrl();
        await initializeTestPlatform(previousAppId);
      }
    });
  }
});
