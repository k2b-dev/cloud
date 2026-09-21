import { beforeAll, expect, spyOn } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as fieldIndexes from "./field-indexes";
import * as fields from "./fields";
import * as localCalculations from "./local-calculation-storage";
import { get as getRecord } from "./record-read";
import * as records from "./record-write";

beforeAll(async () => {
  if (testInfra.database) await migrate();
}, 30_000);

const fixture = async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${testShortId("B")}, 'Local calculation schema')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
    VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Records')`;
  return { baseId, tableId };
};

postgresTest(
  "field lifecycle refreshes draft calculations, including records in trash, in the schema transaction",
  async () => {
    const item = await fixture();
    try {
      const amount = await fields.create({ tableId: item.tableId, name: "Amount", type: "number" }, null);
      if (!amount.ok) throw amount.error;
      const first = await records.create(item.tableId, { [amount.data.id]: "1.25" }, null, "direct");
      const second = await records.create(item.tableId, { [amount.data.id]: "3.50" }, null, "direct");
      if (!first.ok) throw first.error;
      if (!second.ok) throw second.error;
      expect((await records.softDelete(item.tableId, second.data.id, null, "direct")).ok).toBe(true);

      const total = await fields.create(
        { tableId: item.tableId, name: "Total", type: "formula", config: { expression: "Amount * 2" } },
        null,
      );
      if (!total.ok) throw total.error;
      const read = async (recordId: string, fieldId = total.data.id) => (await getRecord(item.tableId, recordId))?.data[fieldId];
      expect(await read(first.data.id)).toBe("2.5");

      const tax = await fields.create({ tableId: item.tableId, name: "Tax", type: "formula", config: { expression: "Total / 10" } }, null);
      if (!tax.ok) throw tax.error;
      expect(await read(first.data.id, tax.data.id)).toBe("0.25");
      const changed = await fields.update(total.data.id, { config: { expression: "Amount * 4" } }, null);
      if (!changed.ok) throw changed.error;
      expect(await read(first.data.id)).toBe("5");
      expect(await read(first.data.id, tax.data.id)).toBe("0.5");

      const [trashed] = await sql<Array<{ deleted: boolean; total: string; tax: string }>>`
      SELECT deleted_at IS NOT NULL AS deleted,
        local_calculations->'values'->>${total.data.id} AS total,
        local_calculations->'values'->>${tax.data.id} AS tax
      FROM grids.records WHERE id = ${second.data.id}::uuid
    `;
      expect(trashed).toEqual({ deleted: true, total: "14.0", tax: "1.4000000000000000" });

      expect((await records.restore(item.tableId, second.data.id, null, "direct")).ok).toBe(true);
      expect(await read(second.data.id)).toBe("14");
      expect(await read(second.data.id, tax.data.id)).toBe("1.4");

      const renamed = await fields.update(amount.data.id, { name: "Price" }, null);
      if (!renamed.ok) throw renamed.error;
      expect((await fields.get(total.data.id))?.config.expression).toBe("Price * 4");
      expect(await read(first.data.id)).toBe("5");

      const refresh = localCalculations.refreshLocalCalculations;
      const failAfterRefresh = spyOn(localCalculations, "refreshLocalCalculations").mockImplementationOnce(async (...args) => {
        await refresh(...args);
        throw new Error("forced failure after calculation refresh");
      });
      try {
        const rejected = await fields.update(total.data.id, { config: { expression: "Price * 8" } }, null);
        expect(rejected.ok).toBe(false);
      } finally {
        failAfterRefresh.mockRestore();
      }
      expect((await fields.get(total.data.id))?.config.expression).toBe("Price * 4");
      expect(await read(first.data.id)).toBe("5");

      expect((await fields.softDelete(tax.data.id, null)).ok).toBe(true);
      expect((await fields.softDelete(total.data.id, null)).ok).toBe(true);
      expect((await fields.restore(total.data.id, null)).ok).toBe(true);
      expect((await fields.restore(tax.data.id, null)).ok).toBe(true);
      expect(await read(first.data.id, tax.data.id)).toBe("0.5");
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
    }
  },
  30_000,
);

postgresTest(
  "failed index removal restores the schema and matching calculations together",
  async () => {
    const item = await fixture();
    let indexedFieldId: string | undefined;
    try {
      const amount = await fields.create({ tableId: item.tableId, name: "Amount", type: "number", uniqueConstraint: true }, null);
      if (!amount.ok) throw amount.error;
      indexedFieldId = amount.data.id;
      const total = await fields.create(
        { tableId: item.tableId, name: "Total", type: "formula", config: { expression: "Amount * 2" } },
        null,
      );
      if (!total.ok) throw total.error;
      const record = await records.create(item.tableId, { [amount.data.id]: "1.25" }, null, "direct");
      if (!record.ok) throw record.error;
      const drop = spyOn(fieldIndexes, "dropFieldUniqueIndex").mockRejectedValueOnce(new Error("forced index removal failure"));
      try {
        const changed = await fields.update(amount.data.id, { name: "Price", config: { decimalPlaces: 2 }, uniqueConstraint: false }, null);
        expect(changed.ok).toBe(false);
      } finally {
        drop.mockRestore();
      }
      const restored = await fields.get(amount.data.id);
      expect(restored?.name).toBe("Amount");
      expect(restored?.uniqueConstraint).toBe(true);
      expect((await fields.get(total.data.id))?.config.expression).toBe("Amount * 2");
      expect((await getRecord(item.tableId, record.data.id))?.data[total.data.id]).toBe("2.5");
    } finally {
      if (indexedFieldId) await fieldIndexes.dropFieldUniqueIndex(indexedFieldId);
      await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
    }
  },
  30_000,
);
