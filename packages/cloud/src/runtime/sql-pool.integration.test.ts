import { expect, test } from "bun:test";
import type { ReservedSQL } from "bun";
import { initializeTestPlatform, requireDatabaseUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { closePlatformClients, createSql, sql } from "./clients";
import { connections } from "./connections";

suiteFor("database")("SQL pool configuration", () => {
  test("bounds real global connections, queues work until release and keeps owned pools independent", async () => {
    const previousMax = process.env.CLOUD_DATABASE_POOL_MAX;
    const previousUrl = process.env.DATABASE_URL;
    const previousAppId = connections().appId;
    const url = new URL(requireDatabaseUrl());
    url.searchParams.set("application_name", "pool-test");
    url.searchParams.set("statement_timeout", "5000");
    const databaseUrl = url.toString();
    const leases: ReservedSQL[] = [];
    let pending: Promise<unknown> | undefined;
    process.env.CLOUD_DATABASE_POOL_MAX = "2";
    process.env.DATABASE_URL = databaseUrl;
    try {
      await initializeTestPlatform("pool-test");
      expect(sql.options.max).toBe(2);
      const pids = new Set<number>();
      for (let index = 0; index < 2; index++) {
        const lease = await sql.reserve();
        leases.push(lease);
        const [row] = await lease`SELECT pg_backend_pid() AS pid, current_setting('application_name') AS name`;
        pids.add(row.pid);
        expect(row.name).toBe("pool-test");
      }
      expect(pids.size).toBe(2);
      let completed = false;
      pending = sql`SELECT 42 AS answer`.then((rows) => {
        completed = true;
        return rows;
      });
      // Observe the absence of completion while both connections remain reserved.
      await Bun.sleep(100);
      expect(completed).toBe(false);
      leases.pop()!.release();
      expect(await pending).toEqual([{ answer: 42 }]);
      const owned = createSql({ max: 1, connect_timeout: 5, idle_timeout: 1 });
      try {
        expect(owned.options.max).toBe(1);
        const rows = await owned<{ answer: number }[]>`SELECT 43 AS answer`;
        expect(rows).toEqual([{ answer: 43 }]);
      } finally {
        await owned.close();
      }
      url.searchParams.set("max", "1");
      expect(() => createSql({ url })).toThrow("SQL URL contains a client option");
      expect(connections().database.url).toBe(databaseUrl);
      expect(process.env.DATABASE_URL).toBe(databaseUrl);
    } finally {
      for (const lease of leases) lease.release();
      try {
        await pending;
      } finally {
        await closePlatformClients();
        if (previousMax === undefined) delete process.env.CLOUD_DATABASE_POOL_MAX;
        else process.env.CLOUD_DATABASE_POOL_MAX = previousMax;
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
        await initializeTestPlatform(previousAppId);
      }
    }
  });
});
