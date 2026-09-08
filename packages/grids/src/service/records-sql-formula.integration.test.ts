import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { parseFormula } from "../formula/parser";
import { aggregate, get, group, list } from "./records";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

type TestShape = {
  baseId: string;
  tableId: string;
  targetTableId: string;
  recordId: string;
  secondRecordId: string;
  targetRecordId: string;
  priceId: string;
  quantityId: string;
  subtotalId: string;
  grossId: string;
  statusId: string;
  relationId: string;
  targetNameId: string;
  priceRef: string;
  quantityRef: string;
};

const insertSqlFormulaFixture = async (): Promise<TestShape> => {
  const baseId = uuid();
  const tableId = uuid();
  const targetTableId = uuid();
  const recordId = uuid();
  const secondRecordId = uuid();
  const targetRecordId = uuid();
  const priceId = uuid();
  const quantityId = uuid();
  const subtotalId = uuid();
  const grossId = uuid();
  const statusId = uuid();
  const relationId = uuid();
  const targetNameId = uuid();
  const priceRef = shortId("P");
  const quantityRef = shortId("Q");
  const subtotalRef = shortId("S");

  await sql.begin(async (sql) => {
    await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${shortId("B")}, 'SQL formula integration')
  `;
    await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES
      (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Line items', 0),
      (${targetTableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Products', 1)
  `;
    await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
    VALUES
      (${priceId}::uuid, ${priceRef}, ${tableId}::uuid, 'Price', 'number', '{}'::jsonb, 0),
      (${quantityId}::uuid, ${quantityRef}, ${tableId}::uuid, 'Quantity', 'number', '{}'::jsonb, 1),
      (${subtotalId}::uuid, ${subtotalRef}, ${tableId}::uuid, 'Subtotal', 'formula', ${{ expression: `{${priceRef}} + {${quantityRef}} * 0.20` }}::jsonb, 2),
      (${grossId}::uuid, ${shortId("G")}, ${tableId}::uuid, 'Gross', 'formula', ${{ expression: `{${subtotalRef}} + 1` }}::jsonb, 3),
      (
        ${statusId}::uuid,
        ${shortId("S")},
        ${tableId}::uuid,
        'Status',
        'select',
        ${{
          multiple: false,
          options: [
            { id: "open", label: "Open" },
            { id: "done", label: "Done" },
          ],
        }}::jsonb,
        4
      ),
      (${relationId}::uuid, ${shortId("R")}, ${tableId}::uuid, 'Product', 'relation', ${{ targetTableId }}::jsonb, 5),
      (${targetNameId}::uuid, ${shortId("N")}, ${targetTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0)
  `;
    await sql`
    INSERT INTO grids.records (id, short_id, table_id, data, version)
    VALUES
      (
        ${recordId}::uuid,
        ${shortId("R")},
        ${tableId}::uuid,
        ${{ [priceId]: "0.10", [quantityId]: "1.00", [statusId]: ["open"] }}::jsonb,
        1
      ),
      (
        ${secondRecordId}::uuid,
        ${shortId("R")},
        ${tableId}::uuid,
        ${{ [priceId]: "1.00", [quantityId]: "1.00", [statusId]: ["done"] }}::jsonb,
        1
      ),
      (
        ${targetRecordId}::uuid,
        ${shortId("R")},
        ${targetTableId}::uuid,
        ${{ [targetNameId]: "Product A" }}::jsonb,
        1
      )
  `;
    await sql`
    INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
    VALUES (${recordId}::uuid, ${relationId}::uuid, ${targetRecordId}::uuid, 0)
  `;
  });

  return {
    baseId,
    tableId,
    targetTableId,
    recordId,
    secondRecordId,
    targetRecordId,
    priceId,
    quantityId,
    subtotalId,
    grossId,
    statusId,
    relationId,
    targetNameId,
    priceRef,
    quantityRef,
  };
};

const cleanupFixture = async (baseId: string): Promise<void> => {
  await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
};

describe("records SQL formula projection integration", () => {
  postgresTest(
    "releases record-list transactions after concurrent queries",
    async () => {
      const fixture = await insertSqlFormulaFixture();
      try {
        const results = await Promise.all(
          Array.from({ length: 16 }, () => list({ tableId: fixture.tableId, limit: 10, includeRelations: true })),
        );

        expect(results).toHaveLength(16);
        expect(results.every((result) => result.ok && result.data.items.length === 2)).toBe(true);
        expect(
          results.every((result) => {
            if (!result.ok) return false;
            const record = result.data.items.find((item) => item.id === fixture.recordId);
            return record?.expanded?.[fixture.targetRecordId]?.[fixture.targetNameId] === "Product A";
          }),
        ).toBe(true);

        const followUp = await list({ tableId: fixture.tableId, limit: 10 });
        expect(followUp.ok).toBe(true);
        if (followUp.ok) expect(followUp.data.items).toHaveLength(2);
      } finally {
        await cleanupFixture(fixture.baseId);
      }
    },
    15_000,
  );

  postgresTest("list returns SQL-projected formula values and keeps JS fallback dependencies correct", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      const result = await list({ tableId: fixture.tableId, limit: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const record = result.data.items.find((item) => item.id === fixture.recordId);
      const secondRecord = result.data.items.find((item) => item.id === fixture.secondRecordId);
      expect(record?.data[fixture.subtotalId]).toBe("0.3");
      expect(record?.data[fixture.grossId]).toBe("1.3");
      expect(secondRecord?.data[fixture.subtotalId]).toBe("1.2");
      expect(secondRecord?.data[fixture.grossId]).toBe("2.2");
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("list returns SQL-projected formula values for readable field references", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      await sql`
        UPDATE grids.fields
        SET config = CASE id
          WHEN ${fixture.subtotalId}::uuid THEN ${{ expression: "Price + Quantity * 0.20" }}::jsonb
          WHEN ${fixture.grossId}::uuid THEN ${{ expression: "Subtotal + 1" }}::jsonb
          ELSE config
        END
        WHERE id IN (${fixture.subtotalId}::uuid, ${fixture.grossId}::uuid)
      `;

      const result = await list({ tableId: fixture.tableId, limit: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const record = result.data.items.find((item) => item.id === fixture.recordId);
      const secondRecord = result.data.items.find((item) => item.id === fixture.secondRecordId);
      expect(record?.data[fixture.subtotalId]).toBe("0.3");
      expect(record?.data[fixture.grossId]).toBe("1.3");
      expect(secondRecord?.data[fixture.subtotalId]).toBe("1.2");
      expect(secondRecord?.data[fixture.grossId]).toBe("2.2");
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("get returns the same SQL-projected formula values as list", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      const result = await get(fixture.tableId, fixture.recordId);
      expect(result).not.toBeNull();
      if (!result) return;

      expect(result.data[fixture.subtotalId]).toBe("0.3");
      expect(result.data[fixture.grossId]).toBe("1.3");
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("list applies SQL formula where predicates inside the record query", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      const parsed = parseFormula(`{${fixture.priceRef}} <= {${fixture.quantityRef}} * 0.20`);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const result = await list({ tableId: fixture.tableId, limit: 10, formulaWhere: parsed.ast });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.items.map((item) => item.id)).toEqual([fixture.recordId]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("list applies readable SQL formula where predicates", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      const parsed = parseFormula("Price <= Quantity * 0.20");
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const result = await list({ tableId: fixture.tableId, limit: 10, formulaWhere: parsed.ast });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.items.map((item) => item.id)).toEqual([fixture.recordId]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("list applies SQL formula where before limit and sort", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      const parsed = parseFormula(`{${fixture.priceRef}} <= {${fixture.quantityRef}} * 0.20`);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const result = await list({
        tableId: fixture.tableId,
        limit: 1,
        sort: [{ fieldId: fixture.priceId, direction: "desc" }],
        formulaWhere: parsed.ast,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.items.map((item) => item.id)).toEqual([fixture.recordId]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("filters and groups single-select values without explode semantics", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data, version)
        VALUES (${uuid()}::uuid, ${shortId("R")}, ${fixture.tableId}::uuid, ${{ [fixture.quantityId]: "2.00" }}::jsonb, 1)
      `;

      const filtered = await list({
        tableId: fixture.tableId,
        limit: 10,
        filter: { fieldId: fixture.statusId, op: "is", value: "open" },
      });
      expect(filtered.ok).toBe(true);
      if (!filtered.ok) return;
      expect(filtered.data.items.map((item) => item.id)).toEqual([fixture.recordId]);

      const notOpen = await list({
        tableId: fixture.tableId,
        limit: 10,
        filter: { fieldId: fixture.statusId, op: "isNot", value: "open" },
      });
      expect(notOpen.ok).toBe(true);
      if (!notOpen.ok) return;
      expect(notOpen.data.items).toHaveLength(2);
      expect(notOpen.data.items.find((item) => item.id === fixture.secondRecordId)?.data[fixture.statusId]).toEqual(["done"]);
      expect(notOpen.data.items.some((item) => item.data[fixture.statusId] === undefined)).toBe(true);

      const grouped = await group({
        tableId: fixture.tableId,
        groupBy: [{ fieldId: fixture.statusId }],
        aggregations: [{ fieldId: "*", agg: "count" }],
        limit: 10,
      });
      expect(grouped.ok).toBe(true);
      if (!grouped.ok) return;
      expect(grouped.data.explode).toBe(false);
      expect(new Map(grouped.data.buckets.map((bucket) => [bucket.keys[0], bucket.values["*__count"]]))).toEqual(
        new Map([
          [null, 1],
          ["done", 1],
          ["open", 1],
        ]),
      );
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("aggregate applies SQL formula where predicates", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      const parsed = parseFormula(`{${fixture.priceRef}} <= {${fixture.quantityRef}} * 0.20`);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const result = await aggregate({
        tableId: fixture.tableId,
        requests: [
          { fieldId: "*", agg: "count" },
          { fieldId: fixture.priceId, agg: "sum" },
        ],
        formulaWhere: parsed.ast,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data["*__count"]).toBe(1);
      expect(result.data[`${fixture.priceId}__sum`]).toBe(0.1);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("group applies SQL formula having predicates over aggregate aliases", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      const parsed = parseFormula("revenue < 0.50");
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const result = await group({
        tableId: fixture.tableId,
        groupBy: [{ fieldId: fixture.priceId }],
        aggregations: [{ fieldId: fixture.priceId, agg: "sum" }],
        formulaHaving: {
          expression: parsed.ast,
          refs: [{ ref: "revenue", fieldId: fixture.priceId, agg: "sum" }],
        },
        limit: 10,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.buckets).toHaveLength(1);
      expect(result.data.buckets[0]?.values[`${fixture.priceId}__sum`]).toBe(0.1);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("group paginates forward from a nulls-first group key", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data, version)
        VALUES (${uuid()}::uuid, ${shortId("R")}, ${fixture.tableId}::uuid, ${{ [fixture.quantityId]: "2.00" }}::jsonb, 1)
      `;

      const first = await group({
        tableId: fixture.tableId,
        groupBy: [{ fieldId: fixture.priceId, direction: "asc", nullsFirst: true }],
        aggregations: [{ fieldId: "*", agg: "count" }],
        limit: 1,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.data.buckets.map((bucket) => bucket.keys[0])).toEqual([null]);
      expect(first.data.nextCursor).not.toBeNull();

      const second = await group({
        tableId: fixture.tableId,
        groupBy: [{ fieldId: fixture.priceId, direction: "asc", nullsFirst: true }],
        aggregations: [{ fieldId: "*", agg: "count" }],
        cursor: first.data.nextCursor,
        limit: 1,
      });
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.data.buckets.map((bucket) => bucket.keys[0])).toEqual([0.1]);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("group pagination preserves aggregate-sort cursor values", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data, version)
        VALUES
          (${uuid()}::uuid, ${shortId("R")}, ${fixture.tableId}::uuid, ${{ [fixture.priceId]: "0.10", [fixture.quantityId]: "2.00" }}::jsonb, 1),
          (${uuid()}::uuid, ${shortId("R")}, ${fixture.tableId}::uuid, ${{ [fixture.priceId]: "2.00", [fixture.quantityId]: "1.00" }}::jsonb, 1)
      `;

      const request = {
        tableId: fixture.tableId,
        groupBy: [{ fieldId: fixture.priceId, direction: "asc" as const }],
        aggregations: [{ fieldId: "*" as const, agg: "count" as const }],
        groupSort: [{ fieldId: "*" as const, agg: "count" as const, direction: "desc" as const }],
        limit: 1,
      };
      const first = await group(request);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.data.buckets[0]?.values["*__count"]).toBe(2);
      expect(first.data.nextCursor).not.toBeNull();

      const second = await group({ ...request, cursor: first.data.nextCursor });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.data.buckets[0]?.values["*__count"]).toBe(1);
      expect(second.data.buckets[0]?.keys[0]).toBe(1);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });

  postgresTest("group aggregates SQL formula arguments and applies having to the formula alias", async () => {
    const fixture = await insertSqlFormulaFixture();
    try {
      const subtotal = parseFormula(`{${fixture.priceRef}} * {${fixture.quantityRef}}`);
      const having = parseFormula("subtotal > 1.00");
      expect(subtotal.ok).toBe(true);
      expect(having.ok).toBe(true);
      if (!subtotal.ok || !having.ok) return;

      const formulaAggregate = {
        kind: "formula" as const,
        id: "subtotal",
        expression: subtotal.ast,
        agg: "sum" as const,
      };
      const result = await group({
        tableId: fixture.tableId,
        groupBy: [{ fieldId: fixture.quantityId }],
        aggregations: [formulaAggregate],
        formulaHaving: {
          expression: having.ast,
          refs: [{ ...formulaAggregate, ref: "subtotal" }],
        },
        limit: 10,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.buckets).toHaveLength(1);
      expect(result.data.buckets[0]?.keys).toEqual([1]);
      expect(result.data.buckets[0]?.values.subtotal__sum).toBe(1.1);
    } finally {
      await cleanupFixture(fixture.baseId);
    }
  });
});
