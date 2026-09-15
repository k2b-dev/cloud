import { describe, expect, test } from "bun:test";
import { parseFormula } from "../formula/parser";
import { dslQueryReferencedFieldIds } from "../query-dsl/plan-dependencies";
import type { DslResolvedSqlQueryPlan } from "../query-dsl/resolver";
import { collectDslPlanTableIds } from "../query-dsl/source-plan";
import type { Field } from "../service/types";
import { canonicalCustomAppQueryContext, customAppQueryPlanHash } from "./query-plan-hash";

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const sourceTableId = uuid(1);
test("formula-only aggregate dependencies pin configuration on root and summary sources", () => {
  const expression = parseFormula("Amount * 2");
  if (!expression.ok) throw new Error("Invalid fixture");
  const amount = field({ id: uuid(10), tableId: sourceTableId, name: "Amount", type: "number" });
  const aggregate = {
    kind: "formula" as const,
    id: "total",
    ref: "total",
    source: "Amount * 2",
    expression: expression.ast,
    agg: "sum" as const,
    sqlType: "numeric" as const,
  };
  const root = { ...plan(), query: {}, outputColumns: [], formulaAggregations: [aggregate] };
  const fields = { [sourceTableId]: [amount] };
  expect(dslQueryReferencedFieldIds(root, fields).has(amount.id)).toBe(true);
  expect(customAppQueryPlanHash(root, fields)).not.toBe(
    customAppQueryPlanHash(root, { [sourceTableId]: [{ ...amount, config: { decimalPlaces: 2 } }] }),
  );
  const childAmount = { ...amount, tableId: targetTableId };
  const summary: DslResolvedSqlQueryPlan = {
    ...plan(),
    query: {},
    outputColumns: [],
    summaryJoins: [
      {
        alias: "totals",
        tableId: targetTableId,
        parentTableId: sourceTableId,
        source: {
          kind: "view",
          id: uuid(12),
          shortId: "SUM001",
          name: "Totals",
          tableId: targetTableId,
          query: { groupBy: [{ fieldId: relationFieldId }] },
          summaryFormulaAggregations: [aggregate],
        },
        group: { kind: "group", key: "gk_0", label: "Parent", refs: [], sqlType: "json", type: "relation", fieldId: relationFieldId },
        columns: [],
      },
    ],
  };
  const childFields = { [sourceTableId]: [], [targetTableId]: [childAmount] };
  expect(dslQueryReferencedFieldIds(summary, childFields).has(childAmount.id)).toBe(true);
  expect(customAppQueryPlanHash(summary, childFields)).not.toBe(
    customAppQueryPlanHash(summary, { ...childFields, [targetTableId]: [{ ...childAmount, config: { decimalPlaces: 3 } }] }),
  );
});
const targetTableId = uuid(2);
const relationFieldId = uuid(3);
const labelFieldId = uuid(4);

const field = (input: Pick<Field, "id" | "tableId" | "name" | "type"> & Partial<Field>): Field => ({
  shortId: input.id.slice(-6),
  description: null,
  config: {},
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2000-01-01T00:00:00.000Z",
  updatedAt: "2000-01-01T00:00:00.000Z",
  ...input,
});

const plan = (): DslResolvedSqlQueryPlan => ({
  source: { kind: "table", id: sourceTableId, shortId: "SOURCE", name: "Source" },
  tableId: sourceTableId,
  query: { columns: [{ fieldId: relationFieldId }] },
  readableTableIds: [sourceTableId, targetTableId],
  outputColumns: [{ kind: "field", fieldId: relationFieldId }],
});

const fields = (overrides: { relationTargetId?: string; labelFieldId?: string } = {}): Record<string, Field[]> => ({
  [sourceTableId]: [
    field({
      id: relationFieldId,
      tableId: sourceTableId,
      name: "Category",
      type: "relation",
      config: { targetTableId: overrides.relationTargetId ?? targetTableId },
    }),
  ],
  [targetTableId]: [
    field({
      id: overrides.labelFieldId ?? labelFieldId,
      tableId: targetTableId,
      name: "Name",
      type: "text",
      presentable: true,
    }),
  ],
});

describe("Grids App query plan capabilities", () => {
  test("object-list layout changes are not query schema changes", () => {
    const data = fields();
    const item = data[sourceTableId]![0]!;
    item.type = "object_list";
    item.config = { fields: [{ id: "Count1", name: "Count", type: "number" }] };
    const before = customAppQueryPlanHash(plan(), data);
    item.config = { fields: [{ id: "Count1", name: "Count", type: "number", width: "compact" }] };
    expect(customAppQueryPlanHash(plan(), data)).toBe(before);
    item.config = { fields: [{ id: "Count1", name: "Count", type: "number", width: "compact", required: true }] };
    expect(customAppQueryPlanHash(plan(), data)).not.toBe(before);
  });
  test("count rollups do not authorize or pin an unused computed target", () => {
    const thirdTableId = uuid(50);
    const countId = uuid(51);
    const lookupId = uuid(52);
    const nestedRelationId = uuid(53);
    const amountId = uuid(54);
    const countFields: Record<string, Field[]> = {
      [sourceTableId]: [
        field({ id: relationFieldId, tableId: sourceTableId, name: "Entries", type: "relation", config: { targetTableId } }),
        field({
          id: countId,
          tableId: sourceTableId,
          name: "Count",
          type: "rollup",
          config: { relationFieldId, targetFieldId: lookupId, agg: "count" },
        }),
      ],
      [targetTableId]: [
        field({
          id: lookupId,
          tableId: targetTableId,
          name: "Unused amount",
          type: "lookup",
          config: { relationFieldId: nestedRelationId, targetFieldId: amountId },
        }),
        field({
          id: nestedRelationId,
          tableId: targetTableId,
          name: "Private account",
          type: "relation",
          config: { targetTableId: thirdTableId },
        }),
      ],
      [thirdTableId]: [field({ id: amountId, tableId: thirdTableId, name: "Amount", type: "number" })],
    };
    const selected: DslResolvedSqlQueryPlan = {
      ...plan(),
      query: { columns: [{ fieldId: countId }] },
      outputColumns: [{ kind: "field", fieldId: countId }],
    };
    expect(new Set(collectDslPlanTableIds(selected, countFields))).toEqual(new Set([sourceTableId, targetTableId]));
    const initialHash = customAppQueryPlanHash(selected, countFields);
    const changed = structuredClone(countFields);
    changed[thirdTableId]![0]!.config = { decimalPlaces: 3 };
    changed[targetTableId]![0]!.config = { relationFieldId: nestedRelationId, targetFieldId: uuid(55) };
    expect(customAppQueryPlanHash(selected, changed)).toBe(initialHash);
  });
  test("pins only reachable computed tables and transitive formula metadata", () => {
    const thirdTableId = uuid(10);
    const unrelatedTableId = uuid(11);
    const lookupId = uuid(12);
    const formulaId = uuid(13);
    const nestedLookupId = uuid(14);
    const nestedRelationId = uuid(15);
    const amountId = uuid(16);
    const computedFields: Record<string, Field[]> = {
      [sourceTableId]: [
        field({ id: relationFieldId, tableId: sourceTableId, name: "Customer", type: "relation", config: { targetTableId } }),
        field({
          id: lookupId,
          tableId: sourceTableId,
          name: "Customer total",
          type: "lookup",
          config: { relationFieldId, targetFieldId: formulaId },
        }),
        field({ id: uuid(17), tableId: sourceTableId, name: "Unused", type: "relation", config: { targetTableId: unrelatedTableId } }),
      ],
      [targetTableId]: [
        field({ id: formulaId, tableId: targetTableId, name: "Total", type: "formula", config: { expression: '"Nested amount" * 2' } }),
        field({
          id: nestedLookupId,
          tableId: targetTableId,
          name: "Nested amount",
          type: "lookup",
          config: { relationFieldId: nestedRelationId, targetFieldId: amountId },
        }),
        field({ id: nestedRelationId, tableId: targetTableId, name: "Account", type: "relation", config: { targetTableId: thirdTableId } }),
      ],
      [thirdTableId]: [field({ id: amountId, tableId: thirdTableId, name: "Amount", type: "number", config: { decimalPlaces: 2 } })],
      [unrelatedTableId]: [field({ id: uuid(18), tableId: unrelatedTableId, name: "Secret", type: "text" })],
    };
    const selected: DslResolvedSqlQueryPlan = {
      ...plan(),
      query: { columns: [{ fieldId: lookupId }] },
      outputColumns: [{ kind: "field", fieldId: lookupId }],
      readableTableIds: [sourceTableId, targetTableId, thirdTableId, unrelatedTableId],
    };
    expect(new Set(collectDslPlanTableIds(selected, computedFields))).toEqual(new Set([sourceTableId, targetTableId, thirdTableId]));
    const original = customAppQueryPlanHash(selected, computedFields);
    const changed = structuredClone(computedFields);
    changed[thirdTableId]![0]!.config = { decimalPlaces: 3 };
    expect(customAppQueryPlanHash(selected, changed)).not.toBe(original);
    const unrelated = structuredClone(computedFields);
    unrelated[unrelatedTableId]![0]!.config = { maxLength: 5 };
    expect(customAppQueryPlanHash(selected, unrelated)).toBe(original);
    const implicit = { ...selected, query: {}, outputColumns: undefined };
    expect(new Set(collectDslPlanTableIds(implicit, computedFields))).toEqual(new Set([sourceTableId, targetTableId, thirdTableId]));
    const rawRelation = {
      ...selected,
      query: { columns: [{ fieldId: relationFieldId }] },
      outputColumns: [{ kind: "field" as const, fieldId: relationFieldId }],
    };
    expect(collectDslPlanTableIds(rawRelation, computedFields)).toEqual([sourceTableId]);
  });
  test("uses public record ids for canonical page parameters", () => {
    expect(canonicalCustomAppQueryContext({ "params.record_id": "actual" })["params.record_id"]).toBe("REC001");
  });

  test("hashes a resolved plan deterministically", () => {
    expect(customAppQueryPlanHash(plan(), fields())).toBe(customAppQueryPlanHash(structuredClone(plan()), structuredClone(fields())));
  });

  test("changes when a resolved field, relation target, or relation label field drifts", () => {
    const initial = customAppQueryPlanHash(plan(), fields());
    const recreatedPlan = plan();
    recreatedPlan.query.columns = [{ fieldId: uuid(30) }];
    recreatedPlan.outputColumns = [{ kind: "field", fieldId: uuid(30) }];

    expect(customAppQueryPlanHash(recreatedPlan, fields())).not.toBe(initial);
    expect(customAppQueryPlanHash(plan(), fields({ relationTargetId: uuid(20) }))).not.toBe(initial);
    expect(customAppQueryPlanHash(plan(), fields({ labelFieldId: uuid(40) }))).not.toBe(initial);
  });
});
