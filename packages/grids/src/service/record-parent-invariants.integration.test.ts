import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { createInTransaction, restore } from "./record-write";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

const createFixture = async () => {
  const baseId = Bun.randomUUIDv7();
  const tableId = Bun.randomUUIDv7();
  const fieldId = Bun.randomUUIDv7();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("B")}, 'Parent invariant')`;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Records', 0)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
    VALUES (${fieldId}::uuid, ${shortId("F")}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0)
  `;
  return { baseId, tableId, fieldId };
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("record parent invariants", () => {
  postgresTest("create observes an uncommitted parent deletion in its transaction", async () => {
    const fixture = await createFixture();
    try {
      const result = await sql.begin(async (tx) => {
        await tx`UPDATE grids.tables SET deleted_at = now() WHERE id = ${fixture.tableId}::uuid`;
        return createInTransaction(tx, fixture.tableId, { [fixture.fieldId]: "hidden" }, null, "direct");
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe("The parent Table or Base is in the trash. Restore the parent first.");
      const [{ count } = { count: 0 }] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${fixture.tableId}::uuid
      `;
      expect(count).toBe(0);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });

  postgresTest("restore rejects a record whose table is trashed", async () => {
    const fixture = await createFixture();
    const recordId = Bun.randomUUIDv7();
    try {
      await sql`
        INSERT INTO grids.records (short_id, id, table_id, data, deleted_at)
        VALUES (${shortId("R")}, ${recordId}::uuid, ${fixture.tableId}::uuid, '{}'::jsonb, now())
      `;
      await sql`UPDATE grids.tables SET deleted_at = now() WHERE id = ${fixture.tableId}::uuid`;

      const result = await restore(fixture.tableId, recordId, null, "direct");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe("The parent Table or Base is in the trash. Restore the parent first.");
      const [row] = await sql<Array<{ deleted: boolean }>>`
        SELECT deleted_at IS NOT NULL AS deleted FROM grids.records WHERE id = ${recordId}::uuid
      `;
      expect(row?.deleted).toBe(true);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });
});
