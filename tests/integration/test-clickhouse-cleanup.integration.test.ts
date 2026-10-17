import { expect, test } from "bun:test";
import { suiteFor } from "../../scripts/fixtures/test-infra";
import { clickhouseAdminQuery, clickhouseTestPrefix, cleanupClickhouseTestObjects } from "../../scripts/fixtures/test-clickhouse";

suiteFor("clickhouse")("ClickHouse prefix cleanup", () => {
  test("drops only this process's objects and leaves an outside database", async () => {
    const outside = `pulseother_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const inside = `${clickhouseTestPrefix}fixture`;
    await clickhouseAdminQuery(`CREATE DATABASE \`${outside}\``);
    try {
      await clickhouseAdminQuery(`CREATE DATABASE \`${inside}\``);
      await cleanupClickhouseTestObjects();
      const rows = await clickhouseAdminQuery("SELECT name FROM system.databases WHERE name IN ({inside:String}, {outside:String})", {
        params: { inside, outside },
      });
      expect(rows).toEqual([{ name: outside }]);
    } finally {
      await clickhouseAdminQuery(`DROP DATABASE IF EXISTS \`${outside}\``);
    }
  });
});
