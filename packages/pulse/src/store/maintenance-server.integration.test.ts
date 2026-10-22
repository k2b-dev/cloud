import { expect, test } from "bun:test";
import { clickhouseAdminQuery, clickhouseTestAdmin, clickhouseTestPrefix } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { clickhouseQuery, StoreQueryError } from "./client";
import { createMaintenanceQuery, MAINTENANCE_LEASE_MS } from "./maintenance-query";
import { quoteIdentifier } from "./validation";

suiteFor("clickhouse")("maintenance server admission", () => {
  test("same-user ingest defers maintenance and a previous maintenance query is stopped before replacement", async () => {
    const user = `${clickhouseTestPrefix}maintenance`;
    const connection = { ...clickhouseTestAdmin(), user, password: "fictional-maintenance-fixture-password" };
    const ingestId = `${clickhouseTestPrefix}ingest`,
      orphanId = `pulse_maintenance_${crypto.randomUUID()}`;
    const requests: Promise<unknown>[] = [];
    await clickhouseAdminQuery(`CREATE USER ${quoteIdentifier(user)} IDENTIFIED BY 'fictional-maintenance-fixture-password'`);
    await clickhouseAdminQuery(`GRANT SELECT ON system.processes TO ${quoteIdentifier(user)}`);
    await clickhouseAdminQuery(`GRANT KILL QUERY ON *.* TO ${quoteIdentifier(user)}`);
    const running = async (id: string) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await clickhouseAdminQuery("SELECT query_id FROM system.processes WHERE query_id={id:String} AND user={user:String}", {
          params: { id, user },
        });
        if (rows.length) return;
        await Bun.sleep(20);
      }
      throw new Error("Fixture query did not enter ClickHouse");
    };
    const slow = (queryId: string) => {
      const result = clickhouseQuery({
        ...connection,
        queryId,
        query: "SELECT sleepEachRow(0.1) FROM numbers(100)",
        timeoutMs: 15000,
      }).then(
        () => null,
        (error) => error,
      );
      requests.push(result);
      return result;
    };
    const run = createMaintenanceQuery({
      mutex: () => ({
        acquire: async () => ({
          resource: "clickhouse",
          ownerToken: "fixture",
          fence: 1n,
          expiresAt: new Date(Date.now() + MAINTENANCE_LEASE_MS),
        }),
        release: async () => true,
      }),
    });
    try {
      const ingest = slow(ingestId);
      await running(ingestId);
      await expect(run({ ...connection, query: "SELECT 1 AS value", timeoutMs: 30000 })).rejects.toThrow("MAINTENANCE_BUSY");
      await running(ingestId); // The maintenance cleanup never targets ingest.
      await clickhouseAdminQuery("KILL QUERY WHERE query_id={id:String} AND user={user:String} SYNC", { params: { id: ingestId, user } });
      expect(await ingest).toBeInstanceOf(StoreQueryError);
      const orphan = slow(orphanId);
      await running(orphanId);
      expect(await run({ ...connection, query: "SELECT 1 AS value", timeoutMs: 30000 })).toEqual([{ value: 1 }]);
      expect(await orphan).toBeInstanceOf(StoreQueryError);
    } finally {
      for (const id of [ingestId, orphanId])
        await clickhouseAdminQuery("KILL QUERY WHERE query_id={id:String} AND user={user:String} SYNC", { params: { id, user } });
      await Promise.all(requests);
      await clickhouseAdminQuery(`DROP USER IF EXISTS ${quoteIdentifier(user)}`);
    }
  }, 30000);
});
