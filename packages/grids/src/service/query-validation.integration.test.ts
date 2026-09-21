import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { tableBelongsToBase } from "./query-validation";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

describe("query parent validation integration", () => {
  postgresTest("rejects foreign, deleted table, and deleted base ownership", async () => {
    const baseId = testUuid();
    const foreignBaseId = testUuid();
    const tableId = testUuid();
    try {
      await sql`
        INSERT INTO grids.bases (id, short_id, name) VALUES
          (${baseId}::uuid, ${testShortId("B")}, 'Query parent'),
          (${foreignBaseId}::uuid, ${testShortId("B")}, 'Query foreign')
      `;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Items', 0)
      `;
      expect(await tableBelongsToBase(tableId, baseId)).toBe(true);
      expect(await tableBelongsToBase(tableId, foreignBaseId)).toBe(false);

      await sql`UPDATE grids.tables SET deleted_at = now() WHERE id = ${tableId}::uuid`;
      expect(await tableBelongsToBase(tableId, baseId)).toBe(false);
      await sql`UPDATE grids.tables SET deleted_at = NULL WHERE id = ${tableId}::uuid`;
      await sql`UPDATE grids.bases SET deleted_at = now() WHERE id = ${baseId}::uuid`;
      expect(await tableBelongsToBase(tableId, baseId)).toBe(false);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id IN (${baseId}::uuid, ${foreignBaseId}::uuid)`;
    }
  });
});
