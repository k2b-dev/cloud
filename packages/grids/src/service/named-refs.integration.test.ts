import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import * as fields from "./fields";
import * as tables from "./tables";
import * as views from "./views";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

const createBase = async (): Promise<string> => {
  const baseId = uuid();
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${shortId("B")}, 'Named refs integration')
  `;
  return baseId;
};

const cleanupBase = async (baseId: string): Promise<void> => {
  await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
};

const expectConflict = (result: { ok: boolean; error?: { code?: string; message?: string } }) => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error?.code).toBe("CONFLICT");
};

const expectSingleConcurrentConflict = (results: Array<{ ok: boolean; error?: { code?: string } }>) => {
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  const [conflict] = results.filter((result) => !result.ok);
  expectConflict(conflict ?? { ok: true });
};

describe("named refs Postgres integration", () => {
  postgresTest("enforces table, field, and view name uniqueness", async () => {
    const baseId = await createBase();
    try {
      const orders = await tables.create({ baseId, name: "Orders" }, null);
      expect(orders.ok).toBe(true);
      if (!orders.ok) throw new Error(orders.error.message);

      expectConflict(await tables.create({ baseId, name: " orders " }, null));

      const archive = await tables.create({ baseId, name: "Archive" }, null);
      expect(archive.ok).toBe(true);
      if (!archive.ok) throw new Error(archive.error.message);
      expectConflict(await tables.update(archive.data.id, { name: "ORDERS" }, null));

      const price = await fields.create({ tableId: orders.data.id, name: "Price", type: "number" }, null);
      expect(price.ok).toBe(true);
      if (!price.ok) throw new Error(price.error.message);
      expectConflict(await fields.create({ tableId: orders.data.id, name: " price ", type: "number" }, null));

      const quantity = await fields.create({ tableId: orders.data.id, name: "Quantity", type: "number" }, null);
      expect(quantity.ok).toBe(true);
      if (!quantity.ok) throw new Error(quantity.error.message);
      expectConflict(await fields.update(quantity.data.id, { name: "PRICE" }, null));

      const openOrders = await views.create({ tableId: orders.data.id, name: "Open orders" }, null);
      expect(openOrders.ok).toBe(true);
      if (!openOrders.ok) throw new Error(openOrders.error.message);
      expectConflict(await views.create({ tableId: archive.data.id, name: " open orders " }, null));
    } finally {
      await cleanupBase(baseId);
    }
  });

  postgresTest("keeps named references unambiguous under concurrent creates", async () => {
    const baseId = await createBase();
    try {
      const tableResults = await Promise.all([
        tables.create({ baseId, name: "Concurrent orders" }, null),
        tables.create({ baseId, name: " concurrent ORDERS " }, null),
      ]);
      expectSingleConcurrentConflict(tableResults);
      const table = tableResults.find((result) => result.ok);
      if (!table?.ok) throw new Error("table setup failed");

      const fieldResults = await Promise.all([
        fields.create({ tableId: table.data.id, name: "Amount", type: "number" }, null),
        fields.create({ tableId: table.data.id, name: " amount ", type: "number" }, null),
      ]);
      expectSingleConcurrentConflict(fieldResults);

      const otherTable = await tables.create({ baseId, name: "Concurrent archive" }, null);
      if (!otherTable.ok) throw new Error(otherTable.error.message);
      const viewResults = await Promise.all([
        views.create({ tableId: table.data.id, name: "Current items" }, null),
        views.create({ tableId: otherTable.data.id, name: " current ITEMS " }, null),
      ]);
      expectSingleConcurrentConflict(viewResults);
    } finally {
      await cleanupBase(baseId);
    }
  });

  postgresTest("reuses soft-deleted names and reports restore collisions", async () => {
    const baseId = await createBase();
    try {
      const originalTable = await tables.create({ baseId, name: "Reusable" }, null);
      if (!originalTable.ok) throw new Error(originalTable.error.message);
      expect((await tables.remove(originalTable.data.id, null)).ok).toBe(true);
      const replacementTable = await tables.create({ baseId, name: " reusable " }, null);
      expect(replacementTable.ok).toBe(true);
      expectConflict(await tables.restore(originalTable.data.id, null));

      if (!replacementTable.ok) throw new Error(replacementTable.error.message);
      const originalField = await fields.create({ tableId: replacementTable.data.id, name: "Reference", type: "text" }, null);
      if (!originalField.ok) throw new Error(originalField.error.message);
      expect((await fields.softDelete(originalField.data.id, null)).ok).toBe(true);
      expect((await fields.create({ tableId: replacementTable.data.id, name: " REFERENCE ", type: "text" }, null)).ok).toBe(true);
      expectConflict(await fields.restore(originalField.data.id, null));

      const otherTable = await tables.create({ baseId, name: "View source" }, null);
      if (!otherTable.ok) throw new Error(otherTable.error.message);
      const originalView = await views.create({ tableId: replacementTable.data.id, name: "Reusable view" }, null);
      if (!originalView.ok) throw new Error(originalView.error.message);
      expect((await views.remove(originalView.data.id, null)).ok).toBe(true);
      expect((await views.create({ tableId: otherTable.data.id, name: " reusable VIEW " }, null)).ok).toBe(true);
      expectConflict(await views.restore(originalView.data.id, null));
    } finally {
      await cleanupBase(baseId);
    }
  });

  postgresTest("reserves view names while their parent table is in the trash", async () => {
    const baseId = await createBase();
    try {
      const source = await tables.create({ baseId, name: "Source" }, null);
      const target = await tables.create({ baseId, name: "Target" }, null);
      if (!source.ok || !target.ok) throw new Error("table setup failed");
      const view = await views.create({ tableId: source.data.id, name: "Restorable view" }, null);
      if (!view.ok) throw new Error(view.error.message);

      expect((await tables.remove(source.data.id, null)).ok).toBe(true);
      expectConflict(await views.create({ tableId: target.data.id, name: " restorable VIEW " }, null));
      expect((await tables.restore(source.data.id, null)).ok).toBe(true);
      expect((await views.get(view.data.id))?.name).toBe("Restorable view");
    } finally {
      await cleanupBase(baseId);
    }
  });

  postgresTest("rewrites saved formula expressions on field rename", async () => {
    const baseId = await createBase();
    try {
      const table = await tables.create({ baseId, name: "Orders" }, null);
      expect(table.ok).toBe(true);
      if (!table.ok) throw new Error(table.error.message);

      const price = await fields.create({ tableId: table.data.id, name: "Price", type: "number" }, null);
      const quantity = await fields.create({ tableId: table.data.id, name: "Quantity", type: "number" }, null);
      const notes = await fields.create({ tableId: table.data.id, name: "Notes", type: "text" }, null);
      expect(price.ok && quantity.ok && notes.ok).toBe(true);
      if (!price.ok || !quantity.ok || !notes.ok) throw new Error("field setup failed");

      const total = await fields.create(
        {
          tableId: table.data.id,
          name: "Total",
          type: "formula",
          config: { expression: "ROUND(Price * Quantity, 2)" },
        },
        null,
      );
      expect(total.ok).toBe(true);
      if (!total.ok) throw new Error(total.error.message);

      const renamed = await fields.update(price.data.id, { name: "Unit price" }, null);
      expect(renamed.ok).toBe(true);
      if (!renamed.ok) throw new Error(renamed.error.message);

      const [formulaRow] = await sql<{ config: unknown }[]>`
        SELECT config FROM grids.fields WHERE id = ${total.data.id}::uuid
      `;
      expect(formulaRow?.config).toMatchObject({ expression: 'ROUND("Unit price" * Quantity, 2)' });
    } finally {
      await cleanupBase(baseId);
    }
  });

  postgresTest("keeps table and view renames stable through id-backed queries", async () => {
    const baseId = await createBase();
    try {
      const table = await tables.create({ baseId, name: "Orders" }, null);
      expect(table.ok).toBe(true);
      if (!table.ok) throw new Error(table.error.message);

      const price = await fields.create({ tableId: table.data.id, name: "Price", type: "number" }, null);
      expect(price.ok).toBe(true);
      if (!price.ok) throw new Error(price.error.message);

      const view = await views.create(
        {
          tableId: table.data.id,
          name: "Current orders",
          source: `from table {${table.data.id}}\nselect {${price.data.id}}`,
          ui: { columns: [{ fieldId: price.data.id }] },
        },
        null,
      );
      expect(view.ok).toBe(true);
      if (!view.ok) throw new Error(view.error.message);

      const renamedTable = await tables.update(table.data.id, { name: "Invoices" }, null);
      expect(renamedTable.ok).toBe(true);
      if (!renamedTable.ok) throw new Error(renamedTable.error.message);
      const renamedView = await views.update(view.data.id, { name: "Current invoices" }, null);
      expect(renamedView.ok).toBe(true);
      if (!renamedView.ok) throw new Error(renamedView.error.message);

      const persisted = await views.get(view.data.id);
      expect(persisted?.ui.columns?.[0]).toEqual({ fieldId: price.data.id });

      const query = parseGridsQueryDsl(`
        from table Invoices
        select Price
        limit 5
      `);
      expect(query.ok).toBe(true);
      if (!query.ok) throw new Error(query.diagnostics.map((d) => d.message).join("\n"));

      const tableFields = await fields.listByTable(table.data.id);
      const resolved = resolveDslQueryToQueryPlan(query.ast, {
        tables: [{ kind: "table", id: table.data.id, shortId: table.data.shortId, name: "Invoices" }],
        views: [
          { kind: "view", id: view.data.id, shortId: view.data.shortId, tableId: table.data.id, name: "Current invoices", query: {} },
        ],
        fieldsByTableId: { [table.data.id]: tableFields },
      });
      if (!resolved.ok) {
        throw new Error(
          `${resolved.diagnostics.map((d) => d.message).join("\n")}\nfields: ${tableFields.map((field) => field.name).join(", ")}`,
        );
      }
      expect(resolved.ok).toBe(true);
      expect(resolved.plan.source.name).toBe("Invoices");
      expect(resolved.plan.outputColumns?.[0]).toEqual({ kind: "field", fieldId: price.data.id });
    } finally {
      await cleanupBase(baseId);
    }
  });
});
