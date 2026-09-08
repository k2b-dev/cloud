import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import * as fields from "./fields";
import * as tables from "./tables";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;
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
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("field relationship scope validation", () => {
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
