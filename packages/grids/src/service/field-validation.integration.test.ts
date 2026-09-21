import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import * as fields from "./fields";
import { checkFormula } from "./formula-preview";
import * as tables from "./tables";
import * as views from "./views";

const postgresTest = testFor("database");
const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

const createBase = async (name: string): Promise<string> => {
  const id = uuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${id}::uuid, ${shortId("V")}, ${name})`;
  return id;
};

const expectBadInput = (result: { ok: boolean; error?: { code?: string; message?: string } }, message: string): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error?.code).toBe("BAD_INPUT");
    expect(result.error?.message?.toLowerCase()).toContain(message.toLowerCase());
  }
};

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

describe("field relationship scope validation", () => {
  postgresTest("Select lookups reject scalar formulas before any records exist", async () => {
    const baseId = await createBase("Collection lookup");
    try {
      const parent = await tables.create({ baseId, name: "Parents" }, null);
      const child = await tables.create({ baseId, name: "Children" }, null);
      if (!parent.ok || !child.ok) throw Error("tables");
      const tax = await fields.create(
        { tableId: parent.data.id, name: "Tax", type: "select", config: { options: [{ id: "normal", label: "Normal" }] } },
        null,
      );
      const relation = await fields.create(
        { tableId: child.data.id, name: "Parent", type: "relation", config: { targetTableId: parent.data.id, multiple: false } },
        null,
      );
      if (!tax.ok || !relation.ok) throw Error("fields");
      const lookup = await fields.create(
        {
          tableId: child.data.id,
          name: "TaxLookup",
          type: "lookup",
          config: { relationFieldId: relation.data.id, targetFieldId: tax.data.id },
        },
        null,
      );
      if (!lookup.ok) throw lookup.error;
      for (const expression of ["CONTAINS(TaxLookup, 'normal')", "LEN(TaxLookup)", "HAS_OPTION(TaxLookup, 'normal')"]) {
        const checked = await checkFormula({ tableId: child.data.id, expression });
        expect(checked.ok && checked.data.ok).toBe(false);
        const created = await fields.create({ tableId: child.data.id, name: "Invalid", type: "formula", config: { expression } }, null);
        expect(created.ok).toBe(false);
      }
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
  postgresTest("view and object-list authoring bind options and protect dependent expressions", async () => {
    const baseId = await createBase("Stable option authoring");
    try {
      const table = await tables.create({ baseId, name: "Cases" }, null);
      if (!table.ok) throw table.error;
      const tax = await fields.create(
        { tableId: table.data.id, name: "Tax", type: "select", config: { options: [{ id: "normal", label: "Standard" }] } },
        null,
      );
      if (!tax.ok) throw tax.error;
      const view = await views.create(
        {
          tableId: table.data.id,
          name: "Tax overview",
          ui: { columns: [{ kind: "computed", id: "computed_Tax01", label: "Rate", expression: "IF(Tax = 'Standard', 19, 0)" }] },
        },
        null,
      );
      if (!view.ok) throw view.error;
      expect(view.data.ui.columns?.[0]).toMatchObject({ expression: "IF(Tax = 'normal', 19, 0)" });
      const renamed = await fields.update(tax.data.id, { config: { options: [{ id: "normal", label: "Normal" }] } }, null);
      expect(renamed.ok).toBe(true);
      const removed = await fields.update(tax.data.id, { config: { options: [] } }, null);
      expect(removed.ok).toBe(false);
      expect((await fields.get(tax.data.id))?.config.options).toEqual([{ id: "normal", label: "Normal" }]);
      const invalidView = await views.create(
        {
          tableId: table.data.id,
          name: "Invalid",
          ui: { columns: [{ kind: "computed", id: "computed_Tax02", label: "Rate", expression: "CONTAINS(Tax, 'normal')" }] },
        },
        null,
      );
      expect(invalidView.ok).toBe(false);
      const list = await fields.create(
        {
          tableId: table.data.id,
          name: "Lines",
          type: "object_list",
          config: {
            fields: [
              { id: "Tax001", name: "Tax", type: "select", config: { options: [{ id: "normal", label: "Standard" }] } },
              { id: "Rate01", name: "Rate", type: "number", formula: { expression: "IF(Tax = 'Standard', 19, 0)" } },
            ],
          },
        },
        null,
      );
      if (!list.ok) throw list.error;
      expect(list.data.config.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "Rate01", formula: { expression: "IF(Tax = 'normal', 19, 0)" } })]),
      );
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
  postgresTest("rejects cross-base relations and inconsistent lookup or rollup paths", async () => {
    const baseId = await createBase("Field validation source");
    const foreignBaseId = await createBase("Field validation foreign");
    try {
      const source = await tables.create({ baseId, name: "Source" }, null);
      const target = await tables.create({ baseId, name: "Target" }, null);
      const foreign = await tables.create({ baseId: foreignBaseId, name: "Foreign" }, null);
      expect(source.ok && target.ok && foreign.ok).toBe(true);
      if (!source.ok || !target.ok || !foreign.ok) throw new Error("table setup failed");

      const targetAmount = await fields.create({ tableId: target.data.id, name: "Amount", type: "number" }, null);
      const foreignAmount = await fields.create({ tableId: foreign.data.id, name: "Amount", type: "number" }, null);
      expect(targetAmount.ok && foreignAmount.ok).toBe(true);
      if (!targetAmount.ok || !foreignAmount.ok) throw new Error("field setup failed");

      const crossBaseRelation = await fields.create(
        {
          tableId: source.data.id,
          name: "Foreign link",
          type: "relation",
          config: { targetTableId: foreign.data.id },
        },
        null,
      );
      expectBadInput(crossBaseRelation, "same base");

      const relation = await fields.create(
        {
          tableId: source.data.id,
          name: "Target link",
          type: "relation",
          config: { targetTableId: target.data.id },
        },
        null,
      );
      expect(relation.ok).toBe(true);
      if (!relation.ok) throw new Error(relation.error.message);

      const relationOnTarget = await fields.create(
        {
          tableId: target.data.id,
          name: "Nested link",
          type: "relation",
          config: { targetTableId: source.data.id },
        },
        null,
      );
      expect(relationOnTarget.ok).toBe(true);
      if (!relationOnTarget.ok) throw new Error(relationOnTarget.error.message);

      expectBadInput(
        await fields.create(
          {
            tableId: source.data.id,
            name: "Wrong source lookup",
            type: "lookup",
            config: { relationFieldId: relationOnTarget.data.id, targetFieldId: targetAmount.data.id },
          },
          null,
        ),
        "same table",
      );

      expectBadInput(
        await fields.create(
          {
            tableId: source.data.id,
            name: "Wrong target lookup",
            type: "lookup",
            config: { relationFieldId: relation.data.id, targetFieldId: foreignAmount.data.id },
          },
          null,
        ),
        "relation's target table",
      );

      expectBadInput(
        await fields.create(
          {
            tableId: source.data.id,
            name: "Wrong target rollup",
            type: "rollup",
            config: { relationFieldId: relation.data.id, targetFieldId: foreignAmount.data.id, agg: "sum" },
          },
          null,
        ),
        "relation's target table",
      );

      const lookup = await fields.create(
        {
          tableId: source.data.id,
          name: "Target amount",
          type: "lookup",
          config: { relationFieldId: relation.data.id, targetFieldId: targetAmount.data.id },
        },
        null,
      );
      const rollup = await fields.create(
        {
          tableId: source.data.id,
          name: "Target total",
          type: "rollup",
          config: { relationFieldId: relation.data.id, targetFieldId: targetAmount.data.id, agg: "sum" },
        },
        null,
      );
      expect(lookup.ok && rollup.ok).toBe(true);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id IN (${baseId}::uuid, ${foreignBaseId}::uuid)`;
    }
  });
});
