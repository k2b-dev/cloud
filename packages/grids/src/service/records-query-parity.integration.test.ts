import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { previewDslQuery } from "../query-dsl/preview";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { listByTable } from "./fields";
import { list } from "./records";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const insertFixture = async () => {
  const baseId = testUuid();
  const table = { kind: "table" as const, id: testUuid(), shortId: testShortId("T"), name: "Items" };
  const target = { kind: "table" as const, id: testUuid(), shortId: testShortId("T"), name: "Customers" };
  const amountId = testUuid();
  const titleId = testUuid();
  const relationId = testUuid();
  const targetNameId = testUuid();
  const targetRecordId = testUuid();
  const rows = [
    { id: testUuid(), amount: null, title: "keep null", version: 1 },
    { id: testUuid(), amount: "9007199254740993.000001", title: "keep a", version: 2 },
    { id: testUuid(), amount: "9007199254740993.000002", title: "keep b", version: 3 },
    { id: testUuid(), amount: "0.10", title: "other", version: 4 },
  ].map((row) => ({ ...row, shortId: testShortId("R") }));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Record query parity')`;
    for (const [position, item] of [table, target].entries()) {
      await tx`INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${item.id}::uuid, ${item.shortId}, ${baseId}::uuid, ${item.name}, ${position})`;
    }
    await tx`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable) VALUES
      (${amountId}::uuid, ${testShortId("F")}, ${table.id}::uuid, 'Amount', 'number', '{}'::jsonb, 0, FALSE),
      (${titleId}::uuid, ${testShortId("F")}, ${table.id}::uuid, 'Title', 'text', '{}'::jsonb, 1, TRUE),
      (${relationId}::uuid, ${testShortId("F")}, ${table.id}::uuid, 'Customer', 'relation', ${{ targetTableId: target.id }}::jsonb, 2, FALSE),
      (${targetNameId}::uuid, ${testShortId("F")}, ${target.id}::uuid, 'Name', 'text', '{}'::jsonb, 0, TRUE)`;
    await tx`INSERT INTO grids.records (id, short_id, table_id, data)
      VALUES (${targetRecordId}::uuid, ${testShortId("R")}, ${target.id}::uuid, ${{ [targetNameId]: "Private customer" }}::jsonb)`;
    for (const row of rows) {
      await tx`INSERT INTO grids.records (id, short_id, table_id, data, version)
        VALUES (${row.id}::uuid, ${row.shortId}, ${table.id}::uuid,
          ${{ [titleId]: row.title, ...(row.amount === null ? {} : { [amountId]: row.amount }) }}::jsonb, ${row.version})`;
      await tx`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
        VALUES (${row.id}::uuid, ${relationId}::uuid, ${targetRecordId}::uuid, 0)`;
    }
  });
  return { baseId, table, target, amountId, titleId, relationId, targetNameId, targetRecordId, rows };
};

type Fixture = Awaited<ReturnType<typeof insertFixture>>;

const gqlRows = async (fixture: Fixture, source: string) => {
  const fieldsByTableId = {
    [fixture.table.id]: await listByTable(fixture.table.id),
    [fixture.target.id]: await listByTable(fixture.target.id),
  };
  const parsed = parseGridsQueryDsl(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const resolved = resolveDslQueryToQueryPlan(parsed.ast, {
    currentTable: fixture.table,
    tables: [fixture.table, fixture.target],
    fieldsByTableId,
  });
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
  const result = await previewDslQuery(resolved.plan, { fieldsByTableId, limit: 10, labelRelationValues: false });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.rows.map((row) => ({
    ...row,
    values: Object.fromEntries(
      result.data.columns.filter((column) => column.fieldId).map((column) => [column.fieldId!, row.values[column.key]]),
    ),
  }));
};

describe("stored record list and textual GQL parity", () => {
  postgresTest("paginates date and microsecond timestamp keys without changing their SQL types", async () => {
    const f = await insertFixture();
    try {
      const dayId = testUuid();
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${dayId}::uuid, ${testShortId("F")}, ${f.table.id}::uuid, 'Day', 'date', '{}'::jsonb, 3)`;
      for (const [index, row] of f.rows.entries()) {
        await sql`UPDATE grids.records SET data = data || jsonb_build_object(${dayId}::text, ${"2026-09-08"}::text),
          created_at = ${`2026-09-08T00:00:00.00000${index + 1}Z`}::timestamptz WHERE id = ${row.id}::uuid`;
      }
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const result = await list({
          tableId: f.table.id,
          cursor,
          limit: 1,
          sort: [
            { fieldId: dayId, direction: "asc" },
            { source: "record", key: "createdAt", direction: "desc" },
          ],
        });
        if (!result.ok) throw new Error(result.error.message);
        ids.push(...result.data.items.map((row) => row.id));
        cursor = result.data.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(ids).toEqual(f.rows.map((row) => row.id).reverse());
      const textual = await gqlRows(f, "select Title\nsort Day asc, record.createdAt desc");
      expect(ids).toEqual(textual.map((row) => row.recordId!));
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${f.baseId}::uuid`;
    }
  });

  postgresTest("combines filter, scoped search and sorting without changing raw decimal values", async () => {
    const f = await insertFixture();
    try {
      const structured = await list({
        tableId: f.table.id,
        filter: { fieldId: f.amountId, op: ">", value: 1 },
        search: { q: "keep", fieldIds: [f.titleId] },
        sort: [{ fieldId: f.amountId, direction: "desc" }],
      });
      if (!structured.ok) throw new Error(structured.error.message);
      const textual = await gqlRows(f, "select Amount, Title\nwhere Amount > 1\nsearch 'keep' in Title\nsort Amount desc");
      expect(structured.data.items.map((row) => row.id)).toEqual(textual.map((row) => row.recordId!));
      expect(structured.data.items.map((row) => row.data[f.amountId])).toEqual([f.rows[2]!.amount, f.rows[1]!.amount]);
      expect(textual.map((row) => row.values[f.amountId])).toEqual(structured.data.items.map((row) => row.data[f.amountId]));
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${f.baseId}::uuid`;
    }
  });

  postgresTest("paginates from null keys through exact decimal ties and retains record metadata", async () => {
    const f = await insertFixture();
    try {
      const items: Array<{ id: string; version: number; amount: unknown }> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const result = await list({
          tableId: f.table.id,
          limit: 1,
          includeAggregates: true,
          cursor,
          sort: [{ fieldId: f.amountId, direction: "asc", nullsFirst: true }],
        });
        if (!result.ok) throw new Error(result.error.message);
        expect(result.data.aggregates?.["*__count"]).toBe(4);
        items.push(...result.data.items.map((row) => ({ id: row.id, version: row.version, amount: row.data[f.amountId] ?? null })));
        cursor = result.data.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      const textual = await gqlRows(f, "select Amount\nsort Amount asc nulls first");
      expect(items.map((row) => row.id)).toEqual(textual.map((row) => row.recordId!));
      expect(items.map((row) => row.amount)).toEqual([null, "0.10", f.rows[1]!.amount, f.rows[2]!.amount]);
      expect(items.map((row) => row.version)).toEqual([1, 4, 2, 3]);
      const selected = await list({ tableId: f.table.id, recordMeta: { ids: [f.rows[2]!.id] } });
      if (!selected.ok) throw new Error(selected.error.message);
      expect(selected.data.items.map((row) => row.id)).toEqual([f.rows[2]!.id]);
      expect(selected.data.items[0]!.version).toBe(3);
      const selectedTextual = await gqlRows(f, `select Amount\nwhere record.id = '${f.rows[2]!.shortId}'`);
      expect(selectedTextual.map((row) => row.recordId!)).toEqual(selected.data.items.map((row) => row.id));
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${f.baseId}::uuid`;
    }
  });

  postgresTest("rejects malformed cursors and preserves deleted-metadata scope and live parents", async () => {
    const f = await insertFixture();
    const deletedBy = testUuid();
    try {
      for (const cursor of ["null", "[]", "broken", JSON.stringify({ v: ["Unknown record"], i: f.rows[0]!.id })]) {
        const result = await list({ tableId: f.table.id, sort: [{ fieldId: f.amountId, direction: "asc" }], cursor });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("BAD_INPUT");
      }
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${deletedBy}::uuid, ${`query-parity-${deletedBy}`}, 'local', 'user', 'Query parity', 'Query', 'Parity')`;
      await sql`UPDATE grids.records SET deleted_at = NOW(), updated_by = ${deletedBy}::uuid WHERE id = ${f.rows[0]!.id}::uuid`;
      const deleted = await list({ tableId: f.table.id, recordMeta: { users: { deletedBy: [deletedBy] } } });
      if (!deleted.ok) throw new Error(deleted.error.message);
      expect(deleted.data.items.map((row) => row.id)).toEqual([f.rows[0]!.id]);
      expect(deleted.data.items[0]!.shortId).toBe(f.rows[0]!.shortId);
      await sql`UPDATE grids.bases SET deleted_at = NOW() WHERE id = ${f.baseId}::uuid`;
      const hidden = await list({ tableId: f.table.id, includeDeleted: true });
      if (!hidden.ok) throw new Error(hidden.error.message);
      expect(hidden.data.items).toEqual([]);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${f.baseId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${deletedBy}::uuid`;
    }
  });

  postgresTest("keeps relation UUIDs separate from expansions and redacts forbidden targets after querying", async () => {
    const f = await insertFixture();
    try {
      const allowed = await list({ tableId: f.table.id, includeRelations: true });
      if (!allowed.ok) throw new Error(allowed.error.message);
      const textual = await gqlRows(f, "select Customer");
      expect(allowed.data.items[0]!.data[f.relationId]).toEqual([f.targetRecordId]);
      expect(textual[0]!.values[f.relationId]).toEqual([f.targetRecordId]);
      expect(allowed.data.items[0]!.expanded?.[f.targetRecordId]?.[f.targetNameId]).toBe("Private customer");
      const denied = await list({
        tableId: f.table.id,
        includeRelations: true,
        viewer: { userId: null, userGroups: [], readableTableIds: new Set([f.table.id]), tableReadAccess: new Map([[f.table.id, true]]) },
      });
      if (!denied.ok) throw new Error(denied.error.message);
      expect(denied.data.items.map((row) => row.id)).toEqual(allowed.data.items.map((row) => row.id));
      for (const row of denied.data.items) {
        expect(row.data[f.relationId]).toEqual([]);
        expect(row.expanded).toBeUndefined();
      }
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${f.baseId}::uuid`;
    }
  });
});
