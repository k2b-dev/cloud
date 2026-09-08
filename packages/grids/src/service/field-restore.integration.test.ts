import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { fieldUniqueIndexName } from "./field-indexes";
import * as fields from "./fields";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

describe("field restore Postgres integration", () => {
  postgresTest(
    "restores unique enforcement and stays deleted when values conflict",
    async () => {
      await migrate();
      const baseId = Bun.randomUUIDv7();
      const tableId = Bun.randomUUIDv7();
      await sql`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES (${baseId}::uuid, ${shortId("B")}, ${`Field restore ${baseId}`})
      `;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Records')
      `;

      try {
        const created = await fields.create({ tableId, name: "External id", type: "text", uniqueConstraint: true }, null);
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error.message);
        const fieldId = created.data.id;
        const firstRecordId = Bun.randomUUIDv7();
        const secondRecordId = Bun.randomUUIDv7();
        await sql`
          INSERT INTO grids.records (short_id, id, table_id, data)
          VALUES
            (${shortId("R")}, ${firstRecordId}::uuid, ${tableId}::uuid, jsonb_build_object(${fieldId}::text, 'A'::text)),
            (${shortId("R")}, ${secondRecordId}::uuid, ${tableId}::uuid, jsonb_build_object(${fieldId}::text, 'B'::text))
        `;

        expect((await fields.softDelete(fieldId, null)).ok).toBe(true);
        const restored = await fields.restore(fieldId, null);
        expect(restored.ok).toBe(true);
        const [restoredIndex] = await sql<Array<{ indexName: string | null }>>`
          SELECT to_regclass(${`grids.${fieldUniqueIndexName(fieldId)}`})::text AS "indexName"
        `;
        expect(restoredIndex?.indexName).toBe(`grids.${fieldUniqueIndexName(fieldId)}`);

        expect((await fields.softDelete(fieldId, null)).ok).toBe(true);
        await sql`
          UPDATE grids.records
          SET data = jsonb_set(data, ${`{${fieldId}}`}::text[], '"A"'::jsonb)
          WHERE id = ${secondRecordId}::uuid
        `;
        const conflicted = await fields.restore(fieldId, null);
        expect(conflicted.ok).toBe(false);
        if (!conflicted.ok) {
          expect(conflicted.error.code).toBe("CONFLICT");
          expect(conflicted.error.message).toContain("field cannot be restored because its existing values are not unique");
        }
        const [fieldRow] = await sql<Array<{ deleted: boolean }>>`
          SELECT deleted_at IS NOT NULL AS deleted
          FROM grids.fields
          WHERE id = ${fieldId}::uuid
        `;
        expect(fieldRow?.deleted).toBe(true);
        const [failedIndex] = await sql<Array<{ indexName: string | null }>>`
          SELECT to_regclass(${`grids.${fieldUniqueIndexName(fieldId)}`})::text AS "indexName"
        `;
        expect(failedIndex?.indexName).toBeNull();
        const [audit] = await sql<Array<{ restoredCount: number }>>`
          SELECT count(*)::int AS "restoredCount"
          FROM grids.audit_log
          WHERE table_id = ${tableId}::uuid AND action = 'restored'
        `;
        expect(audit?.restoredCount).toBe(1);
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      }
    },
    30_000,
  );
});
