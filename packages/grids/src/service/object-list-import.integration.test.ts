import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as fields from "./fields";
import { createMany } from "./record-write";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("object-list atomic import", () => {
  postgresTest(
    "calculates typed rows and rolls back a batch with an invalid or forged cell",
    async () => {
      const baseId = testUuid();
      const tableId = testUuid();
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'List import test')`;
      try {
        await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Invoices')`;
        const field = await fields.create(
          {
            tableId,
            name: "Lines",
            type: "object_list",
            config: {
              fields: [
                { id: "Amount", name: "Amount", type: "number", required: true, config: { decimalPlaces: 2 } },
                { id: "Total1", name: "Total", type: "number", config: { decimalPlaces: 2 }, formula: { expression: "Amount * 2" } },
              ],
            },
          },
          null,
        );
        if (!field.ok) throw field.error;
        const imported = await createMany(tableId, [{ [field.data.id]: [{ Amount: "0.15" }] }, { [field.data.id]: [] }], null, "direct");
        if (!imported.ok) throw imported.error;
        expect(imported.data.map((record) => record.data[field.data.id])).toEqual([[{ Amount: "0.15", Total1: "0.30" }], []]);
        const localized = await createMany(tableId, [{ [field.data.id]: [{ Amount: "wrong" }] }], null, "direct", { locale: "de-CH" });
        expect(localized.ok).toBe(false);
        if (!localized.ok) expect(localized.error.message).toContain("Zeile 1, Amount: Bitte eine gültige, endliche Zahl eingeben.");
        for (const invalid of [{ Amount: "wrong" }, { Amount: "1.00", Total1: "999.00" }, { Amount: "1.00", Extra1: true }]) {
          const result = await createMany(
            tableId,
            [{ [field.data.id]: [{ Amount: "0.25" }] }, { [field.data.id]: [invalid] }],
            null,
            "direct",
          );
          expect(result.ok).toBe(false);
          const [count] = await sql<
            Array<{ count: number }>
          >`SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${tableId}::uuid`;
          expect(count?.count).toBe(2);
        }
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      }
    },
    30_000,
  );
});
