import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import * as fields from "./fields";
import { create, createMany, restore, softDelete, update } from "./record-write";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

const expectUniqueConflict = (result: { ok: boolean; error?: { code?: string; message?: string } }) => {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error?.code).toBe("CONFLICT");
    expect(result.error?.message).toContain("The value for field “External id” must be unique.");
  }
};

describe("record unique-field Postgres integration", () => {
  postgresTest(
    "returns field-specific conflicts from every record write path",
    async () => {
      await migrate();
      const baseId = Bun.randomUUIDv7();
      const tableId = Bun.randomUUIDv7();
      await sql`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES (${baseId}::uuid, ${shortId("B")}, ${`Record uniqueness ${baseId}`})
      `;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Records')
      `;

      try {
        const field = await fields.create({ tableId, name: "External id", type: "text", uniqueConstraint: true }, null);
        if (!field.ok) throw new Error(field.error.message);
        const fieldId = field.data.id;

        const original = await create(tableId, { [fieldId]: "A" }, null, "direct");
        if (!original.ok) throw new Error(original.error.message);
        expectUniqueConflict(await create(tableId, { [fieldId]: "A" }, null, "direct"));

        const bulk = await createMany(tableId, [{ [fieldId]: "B" }, { [fieldId]: "C" }], null, "direct");
        expect(bulk.ok).toBe(true);
        const [beforeFailedBulk] = await sql<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${tableId}::uuid
        `;
        expectUniqueConflict(await createMany(tableId, [{ [fieldId]: "D" }, { [fieldId]: "B" }], null, "direct"));
        const [afterFailedBulk] = await sql<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${tableId}::uuid
        `;
        expect(afterFailedBulk?.count).toBe(beforeFailedBulk?.count);

        if (!bulk.ok) throw new Error(bulk.error.message);
        const updateTarget = bulk.data.find((record) => record.data[fieldId] === "C");
        if (!updateTarget) throw new Error("update target missing");
        expectUniqueConflict(await update(tableId, updateTarget.id, { [fieldId]: "A" }, null, "direct"));

        expect((await softDelete(tableId, original.data.id, null, "direct")).ok).toBe(true);
        expect((await create(tableId, { [fieldId]: "A" }, null, "direct")).ok).toBe(true);
        expectUniqueConflict(await restore(tableId, original.data.id, null, "direct"));
        const [deleted] = await sql<Array<{ deleted: boolean }>>`
          SELECT deleted_at IS NOT NULL AS deleted FROM grids.records WHERE id = ${original.data.id}::uuid
        `;
        expect(deleted?.deleted).toBe(true);
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      }
    },
    30_000,
  );
});
