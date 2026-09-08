import { expect, test } from "bun:test";
import { sql } from "bun";
import type { ExpansionViewer } from "../service/relations";
import type { Field } from "../service/types";
import { parseGridsQueryDsl } from "./parser";
import { previewDslQuery } from "./preview";
import { type DslResolverContext, resolveDslQueryToQueryPlan } from "./resolver";
import type { DslResultCursor } from "./result-cursor";

export const integrationCursorSigningKey = "grids-query-dsl-integration-cursor";

export const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

export const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

type DslDbFixture = {
  baseId: string;
  orders: { kind: "table"; id: string; shortId: string; name: string };
  customers: { kind: "table"; id: string; shortId: string; name: string };
  fieldsByTableId: Record<string, Field[]>;
  amountId: string;
  costId: string;
  statusId: string;
  stageId: string;
  tagsId: string;
  orderedAtId: string;
  customerLinkId: string;
  parentOrderLinkId: string;
  customerScoreRollupId: string;
  customerNameId: string;
  customerScoreId: string;
  customerScoreFormulaId: string;
  customerFavoriteOrderLinkId: string;
  customerFavoriteOrderAmountLookupId: string;
  customerFavoriteOrderAmountRollupId: string;
  orderAId: string;
  orderBId: string;
  orderCId: string;
  orderDeletedId: string;
  customerAId: string;
  customerBId: string;
};

export const field = (overrides: Partial<Field> & Pick<Field, "id" | "shortId" | "tableId" | "name" | "type">): Field => ({
  id: overrides.id,
  shortId: overrides.shortId,
  tableId: overrides.tableId,
  name: overrides.name,
  description: null,
  icon: null,
  type: overrides.type,
  config: overrides.config ?? {},
  position: overrides.position ?? 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

export const cleanupFixture = async (baseId: string): Promise<void> => {
  await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
};

export const insertDslDbFixture = async (): Promise<DslDbFixture> => {
  const baseId = uuid();
  const orders = { kind: "table" as const, id: uuid(), shortId: shortId("O"), name: "Orders" };
  const customers = { kind: "table" as const, id: uuid(), shortId: shortId("C"), name: "Customers" };
  const orderAId = uuid();
  const orderBId = uuid();
  const orderCId = uuid();
  const orderDeletedId = uuid();
  const customerAId = uuid();
  const customerBId = uuid();
  const amountId = uuid();
  const costId = uuid();
  const statusId = uuid();
  const stageId = uuid();
  const tagsId = uuid();
  const orderedAtId = uuid();
  const customerLinkId = uuid();
  const parentOrderLinkId = uuid();
  const customerScoreRollupId = uuid();
  const customerNameId = uuid();
  const customerScoreId = uuid();
  const customerScoreFormulaId = uuid();
  const customerFavoriteOrderLinkId = uuid();
  const customerFavoriteOrderAmountLookupId = uuid();
  const customerFavoriteOrderAmountRollupId = uuid();
  const stageOptions = {
    options: [
      { id: "open", label: "Open" },
      { id: "closed", label: "Closed" },
      { id: "hold", label: "On hold" },
    ],
  };
  const tagOptions = {
    multiple: true,
    options: [
      { id: "priority", label: "Priority" },
      { id: "remote", label: "Remote" },
    ],
  };

  const orderFields = [
    field({ id: amountId, shortId: "AMT01x", tableId: orders.id, name: "Amount", type: "number", position: 0 }),
    field({ id: costId, shortId: "COST1x", tableId: orders.id, name: "Cost", type: "number", position: 1 }),
    field({ id: statusId, shortId: "STAT1x", tableId: orders.id, name: "Status", type: "text", position: 2 }),
    field({ id: stageId, shortId: "STAGEx", tableId: orders.id, name: "Stage", type: "select", config: stageOptions, position: 3 }),
    field({ id: tagsId, shortId: "TAGS1x", tableId: orders.id, name: "Tags", type: "select", config: tagOptions, position: 4 }),
    field({ id: orderedAtId, shortId: "DATE1x", tableId: orders.id, name: "Ordered at", type: "date", position: 5 }),
    field({
      id: customerLinkId,
      shortId: "CUSTLx",
      tableId: orders.id,
      name: "Customer",
      type: "relation",
      config: { targetTableId: customers.id },
      position: 6,
    }),
    field({
      id: parentOrderLinkId,
      shortId: "PARNTx",
      tableId: orders.id,
      name: "Parent order",
      type: "relation",
      config: { targetTableId: orders.id },
      position: 7,
    }),
    field({
      id: customerScoreRollupId,
      shortId: "CSCORx",
      tableId: orders.id,
      name: "Customer score",
      type: "rollup",
      config: { relationFieldId: customerLinkId, targetFieldId: customerScoreId, agg: "sum" },
      position: 8,
    }),
  ];
  const customerFields = [
    field({ id: customerNameId, shortId: "NAME1x", tableId: customers.id, name: "Name", type: "text", position: 0 }),
    field({ id: customerScoreId, shortId: "SCOREx", tableId: customers.id, name: "Score", type: "number", position: 1 }),
    field({
      id: customerScoreFormulaId,
      shortId: "SCOR2x",
      tableId: customers.id,
      name: "Score x2",
      type: "formula",
      config: { expression: "SCOREx * 2" },
      position: 2,
    }),
    field({
      id: customerFavoriteOrderLinkId,
      shortId: "FAVORx",
      tableId: customers.id,
      name: "Favorite order",
      type: "relation",
      config: { targetTableId: orders.id },
      position: 3,
    }),
    field({
      id: customerFavoriteOrderAmountLookupId,
      shortId: "FAMT1x",
      tableId: customers.id,
      name: "Favorite amount",
      type: "lookup",
      config: { relationFieldId: customerFavoriteOrderLinkId, targetFieldId: amountId },
      position: 4,
    }),
    field({
      id: customerFavoriteOrderAmountRollupId,
      shortId: "FSUM1x",
      tableId: customers.id,
      name: "Favorite sum",
      type: "rollup",
      config: { relationFieldId: customerFavoriteOrderLinkId, targetFieldId: amountId, agg: "sum" },
      position: 5,
    }),
  ];

  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${shortId("B")}, 'Query DSL integration')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES
      (${orders.id}::uuid, ${orders.shortId}, ${baseId}::uuid, ${orders.name}, 0),
      (${customers.id}::uuid, ${customers.shortId}, ${baseId}::uuid, ${customers.name}, 1)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
    VALUES
      (${amountId}::uuid, 'AMT01x', ${orders.id}::uuid, 'Amount', 'number', '{}'::jsonb, 0),
      (${costId}::uuid, 'COST1x', ${orders.id}::uuid, 'Cost', 'number', '{}'::jsonb, 1),
      (${statusId}::uuid, 'STAT1x', ${orders.id}::uuid, 'Status', 'text', '{}'::jsonb, 2),
      (${stageId}::uuid, 'STAGEx', ${orders.id}::uuid, 'Stage', 'select', ${stageOptions}::jsonb, 3),
      (${tagsId}::uuid, 'TAGS1x', ${orders.id}::uuid, 'Tags', 'select', ${tagOptions}::jsonb, 4),
      (${orderedAtId}::uuid, 'DATE1x', ${orders.id}::uuid, 'Ordered at', 'date', '{}'::jsonb, 5),
      (${customerLinkId}::uuid, 'CUSTLx', ${orders.id}::uuid, 'Customer', 'relation', ${{ targetTableId: customers.id }}::jsonb, 6),
      (${parentOrderLinkId}::uuid, 'PARNTx', ${orders.id}::uuid, 'Parent order', 'relation', ${{ targetTableId: orders.id }}::jsonb, 7),
      (${customerScoreRollupId}::uuid, 'CSCORx', ${orders.id}::uuid, 'Customer score', 'rollup', ${{
        relationFieldId: customerLinkId,
        targetFieldId: customerScoreId,
        agg: "sum",
      }}::jsonb, 8),
      (${customerNameId}::uuid, 'NAME1x', ${customers.id}::uuid, 'Name', 'text', '{}'::jsonb, 0),
      (${customerScoreId}::uuid, 'SCOREx', ${customers.id}::uuid, 'Score', 'number', '{}'::jsonb, 1),
      (${customerScoreFormulaId}::uuid, 'SCOR2x', ${customers.id}::uuid, 'Score x2', 'formula', ${{ expression: "SCOREx * 2" }}::jsonb, 2),
      (${customerFavoriteOrderLinkId}::uuid, 'FAVORx', ${customers.id}::uuid, 'Favorite order', 'relation', ${{
        targetTableId: orders.id,
      }}::jsonb, 3),
      (${customerFavoriteOrderAmountLookupId}::uuid, 'FAMT1x', ${customers.id}::uuid, 'Favorite amount', 'lookup', ${{
        relationFieldId: customerFavoriteOrderLinkId,
        targetFieldId: amountId,
      }}::jsonb, 4),
      (${customerFavoriteOrderAmountRollupId}::uuid, 'FSUM1x', ${customers.id}::uuid, 'Favorite sum', 'rollup', ${{
        relationFieldId: customerFavoriteOrderLinkId,
        targetFieldId: amountId,
        agg: "sum",
      }}::jsonb, 5)
  `;
  await sql`
    INSERT INTO grids.records (short_id, id, table_id, data, version, deleted_at)
    VALUES
      (${shortId("R")}, ${customerAId}::uuid, ${customers.id}::uuid, ${{ [customerNameId]: "Alice", [customerScoreId]: "8" }}::jsonb, 1, NULL),
      (${shortId("R")}, ${customerBId}::uuid, ${customers.id}::uuid, ${{ [customerNameId]: "Bob", [customerScoreId]: "3" }}::jsonb, 1, NULL),
      (${shortId("R")}, ${orderAId}::uuid, ${orders.id}::uuid, ${{
        [amountId]: "12.50",
        [costId]: "5.00",
        [statusId]: "Open",
        [stageId]: ["open"],
        [tagsId]: ["priority", "remote"],
        [orderedAtId]: "2026-01-15",
      }}::jsonb, 1, NULL),
      (${shortId("R")}, ${orderBId}::uuid, ${orders.id}::uuid, ${{
        [amountId]: "4.00",
        [costId]: "6.00",
        [statusId]: "Closed",
        [stageId]: ["closed"],
        [tagsId]: ["remote"],
        [orderedAtId]: "2026-02-03",
      }}::jsonb, 1, NULL),
      (${shortId("R")}, ${orderCId}::uuid, ${orders.id}::uuid, ${{
        [costId]: "0",
        [statusId]: "Backlog",
        [stageId]: ["hold"],
        [tagsId]: ["priority"],
        [orderedAtId]: "2026-02-20",
      }}::jsonb, 1, NULL),
      (${shortId("R")}, ${orderDeletedId}::uuid, ${orders.id}::uuid, ${{
        [amountId]: "99.00",
        [costId]: "1.00",
        [statusId]: "Deleted",
        [stageId]: ["open"],
        [tagsId]: ["priority"],
        [orderedAtId]: "2026-03-01",
      }}::jsonb, 1, now())
  `;
  await sql`
    INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
    VALUES
      (${orderAId}::uuid, ${customerLinkId}::uuid, ${customerAId}::uuid, 0),
      (${orderBId}::uuid, ${customerLinkId}::uuid, ${customerBId}::uuid, 0),
      (${orderBId}::uuid, ${parentOrderLinkId}::uuid, ${orderAId}::uuid, 0),
      (${customerAId}::uuid, ${customerFavoriteOrderLinkId}::uuid, ${orderAId}::uuid, 0),
      (${customerBId}::uuid, ${customerFavoriteOrderLinkId}::uuid, ${orderBId}::uuid, 0)
  `;

  return {
    baseId,
    orders,
    customers,
    fieldsByTableId: {
      [orders.id]: orderFields,
      [customers.id]: customerFields,
    },
    amountId,
    costId,
    statusId,
    stageId,
    tagsId,
    orderedAtId,
    customerLinkId,
    parentOrderLinkId,
    customerScoreRollupId,
    customerNameId,
    customerScoreId,
    customerScoreFormulaId,
    customerFavoriteOrderLinkId,
    customerFavoriteOrderAmountLookupId,
    customerFavoriteOrderAmountRollupId,
    orderAId,
    orderBId,
    orderCId,
    orderDeletedId,
    customerAId,
    customerBId,
  };
};

export const ctx = (fixture: DslDbFixture): DslResolverContext => ({
  currentTable: fixture.orders,
  tables: [fixture.orders, fixture.customers],
  views: [],
  fieldsByTableId: fixture.fieldsByTableId,
});

export const preview = async (
  fixture: DslDbFixture,
  source: string,
  context: DslResolverContext = ctx(fixture),
  limit = 10,
  viewer?: ExpansionViewer,
) => {
  const parsed = parseGridsQueryDsl(source);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  expect(parsed.ok).toBe(true);

  const resolved = resolveDslQueryToQueryPlan(parsed.ast, context);
  if (!resolved.ok) throw new Error(resolved.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  expect(resolved.ok).toBe(true);

  const result = await previewDslQuery(resolved.plan, { fieldsByTableId: context.fieldsByTableId, limit, viewer });
  if (!result.ok) throw new Error(result.error.message);
  expect(result.ok).toBe(true);
  return result.data;
};

export const previewPage = async (
  fixture: DslDbFixture,
  source: string,
  options: { pageSize: number; cursor?: DslResultCursor | null; fingerprint?: string; context?: DslResolverContext },
) => {
  const context = options.context ?? ctx(fixture);
  const parsed = parseGridsQueryDsl(source);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  const resolved = resolveDslQueryToQueryPlan(parsed.ast, context);
  if (!resolved.ok) throw new Error(resolved.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
  const result = await previewDslQuery(resolved.plan, {
    fieldsByTableId: context.fieldsByTableId,
    pageSize: options.pageSize,
    cursor: options.cursor,
    cursorFingerprint: options.fingerprint ?? "integration-query",
    cursorSigningKey: integrationCursorSigningKey,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
