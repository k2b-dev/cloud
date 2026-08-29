import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { checkFormula } from "./formula-preview";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("formula preview integration", () => {
  postgresTest("reports empty, parse, unknown-reference, and runtime diagnostics", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const nameFieldId = testUuid();
    const recordId = testUuid();
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Formula preview')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'People', 0)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${nameFieldId}::uuid, 'NAME1', ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0)
      `;
      await sql`
        INSERT INTO grids.records (id, table_id, data)
        VALUES (${recordId}::uuid, ${tableId}::uuid, ${{ [nameFieldId]: "Ada" }}::jsonb)
      `;

      const empty = await checkFormula({ tableId, expression: "   " });
      expect(empty.ok && empty.data).toMatchObject({
        ok: true,
        rows: [],
        diagnostics: [{ code: "formula.empty", severity: "info" }],
      });

      const parse = await checkFormula({ tableId, expression: "LEN(" });
      expect(parse.ok && parse.data.ok).toBe(false);
      if (parse.ok)
        expect(parse.data.diagnostics[0]).toMatchObject({ code: "formula.syntax", message: expect.stringContaining("Parse error") });

      const missing = await checkFormula({ tableId, expression: "LEN(Unknown)" });
      expect(missing.ok && missing.data.ok).toBe(false);
      if (missing.ok)
        expect(missing.data.diagnostics).toEqual([
          { code: "formula.unknown_field", severity: "error", message: "Unknown field reference: Unknown" },
        ]);

      const valid = await checkFormula({ tableId, expression: "LEN(Name)" });
      expect(valid.ok && valid.data.ok).toBe(true);
      if (valid.ok) {
        expect(valid.data.fields.map((field) => field.id)).toEqual([nameFieldId]);
        expect(valid.data.rows).toEqual([{ recordId, values: { [nameFieldId]: "Ada" }, result: 3 }]);
      }

      const runtime = await checkFormula({ tableId, expression: "1 / 0" });
      expect(runtime.ok && runtime.data.ok).toBe(false);
      if (runtime.ok)
        expect(runtime.data.diagnostics[0]).toMatchObject({
          code: "formula.evaluation",
          message: expect.stringContaining("formula error"),
        });
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("does not preview rows below a deleted parent", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Deleted formula parent')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position, deleted_at)
        VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Deleted', 0, now())
      `;
      await sql`INSERT INTO grids.records (id, table_id, data) VALUES (${testUuid()}::uuid, ${tableId}::uuid, '{}'::jsonb)`;
      const result = await checkFormula({ tableId, expression: "1 + 1" });
      expect(result.ok && result.data.rows).toEqual([]);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
