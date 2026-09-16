import { describe, expect, spyOn, test } from "bun:test";
import { normalizedSql } from "../sql-test-utils";
import {
  applyComputedProjections,
  buildComputedColumnSqlProjections,
  buildComputedFieldSqlMap,
  buildComputedProjections,
  buildFormulaSqlProjections,
} from "./computed-projections";
import * as fieldReads from "./field-read";
import { enrichRecordsWithFormulas } from "./relation-formulas";
import type { Field, GridRecord } from "./types";

const field = (overrides: Partial<Field> & Pick<Field, "id" | "shortId" | "name" | "type">): Field => ({
  id: overrides.id,
  shortId: overrides.shortId,
  tableId: "table_1",
  name: overrides.name,
  description: null,
  icon: null,
  type: overrides.type,
  config: overrides.config ?? {},
  position: 0,
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

describe("buildFormulaSqlProjections", () => {
  test("emits a SQL projection for scalar formula fields", () => {
    const price = field({ id: "price_id", shortId: "PRICE1", name: "Price", type: "number" });
    const total = field({
      id: "total_id",
      shortId: "TOTAL1",
      name: "Total",
      type: "formula",
      config: { expression: "{PRICE1} * 1.19" },
    });

    const projections = buildFormulaSqlProjections([price, total]);

    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      fieldId: "total_id",
      outputType: "decimal",
    });
  });

  test("skips formula fields that need non-SQL projections", () => {
    const relation = field({ id: "relation_id", shortId: "RELAT1", name: "Relation", type: "relation" });
    const formula = field({
      id: "formula_id",
      shortId: "FORMU1",
      name: "Formula",
      type: "formula",
      config: { expression: "{RELAT1}" },
    });

    expect(buildFormulaSqlProjections([relation, formula])).toEqual([]);
  });

  test("keeps decimal formula values as canonical strings when merging result rows", () => {
    const formula = field({
      id: "total_id",
      shortId: "TOTAL1",
      name: "Total",
      type: "formula",
      config: { expression: "0.1 + 0.2" },
    });
    const [projection] = buildFormulaSqlProjections([formula]);
    expect(projection).toBeDefined();

    const record = { data: {} as Record<string, unknown> };
    applyComputedProjections([{ id: "record_1", [projection!.alias]: "0.300" }], new Map([["record_1", record]]), [projection!]);

    expect(record.data.total_id).toBe("0.3");
  });
});

describe("buildComputedColumnSqlProjections", () => {
  test("uses postgres-stable aliases for mixed-case computed column ids", () => {
    const name = field({ id: "name_id", shortId: "NAME01", name: "Name", type: "text" });

    const { projections, sqlColumnIds } = buildComputedColumnSqlProjections(
      [{ kind: "computed", id: "computed_j3rz0Y3fwW", label: "Name length", expression: "LEN(Name)" }],
      [name],
    );

    expect(sqlColumnIds.has("computed_j3rz0Y3fwW")).toBe(true);
    expect(projections).toHaveLength(1);
    expect(projections[0]!.alias).toBe(projections[0]!.alias.toLowerCase());

    const record = { data: {} as Record<string, unknown> };
    applyComputedProjections([{ id: "record_1", [projections[0]!.alias]: "12" }], new Map([["record_1", record]]), projections);

    expect(record.data.computed_j3rz0Y3fwW).toBe("12");
  });
});

describe("buildComputedProjections", () => {
  test("reuses loaded target fields and formula dependencies without metadata queries", async () => {
    const amount = { ...field({ id: "amount_id", shortId: "AMOUNT", name: "Amount", type: "number" }), tableId: "target_table" };
    const total = {
      ...field({ id: "total_id", shortId: "TOTAL1", name: "Total", type: "formula", config: { expression: "Amount * 2" } }),
      tableId: "target_table",
    };
    const relation = field({
      id: "relation_id",
      shortId: "RELAT1",
      name: "Relation",
      type: "relation",
      config: { targetTableId: "target_table" },
    });
    const lookup = field({
      id: "lookup_id",
      shortId: "LOOKUP",
      name: "Total lookup",
      type: "lookup",
      config: { relationFieldId: relation.id, targetFieldId: total.id },
    });
    const get = spyOn(fieldReads, "get").mockImplementation(async () => {
      throw new Error("Unexpected target field query");
    });
    const list = spyOn(fieldReads, "listByTable").mockImplementation(async () => {
      throw new Error("Unexpected target schema query");
    });
    try {
      const source = [relation, lookup];
      const options = {
        fieldsByTableId: { table_1: source, target_table: [amount, total] },
        authorizedTableIds: new Set(["target_table"]),
      };
      const result = await buildComputedProjections(source, options);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ fieldId: lookup.id, outputType: "decimal" });
      expect(await buildComputedProjections(source, { ...options, authorizedTableIds: new Set() })).toEqual([]);
      expect(get).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      list.mockRestore();
    }
  });

  test("omits lookup and rollup values whose relation target is not readable", async () => {
    const relation = field({
      id: "relation_id",
      shortId: "RELAT1",
      name: "Relation",
      type: "relation",
      config: { targetTableId: "target_table" },
    });
    const count = field({
      id: "count_id",
      shortId: "COUNT1",
      name: "Count",
      type: "rollup",
      config: { relationFieldId: relation.id, agg: "count" },
    });

    expect(await buildComputedProjections([relation, count], { authorizedTableIds: new Set() })).toEqual([]);
    expect(await buildComputedProjections([relation, count], { authorizedTableIds: new Set(["target_table"]) })).toHaveLength(1);
  });
});

describe("applyComputedProjections", () => {
  test("keeps a SQL calculation error separate from the typed value", () => {
    const record: Pick<GridRecord, "data" | "fieldErrors"> = { data: {} };
    applyComputedProjections(
      [{ id: "record_1", total: "0", e_total: true }],
      new Map([["record_1", record]]),
      [{ fieldId: "Total1", alias: "total", outputType: "numeric", fragment: null, errorSql: true }],
      "de",
    );
    expect(record.data.Total1).toBeNull();
    expect(record.fieldErrors?.Total1).toBe("Dieser Wert konnte nicht berechnet werden. Prüfe die Formel und ihre Eingabewerte.");
  });

  test("normalizes database scalar values for the record JSON contract", () => {
    const record = { data: {} as Record<string, unknown> };
    const projections = [
      { fieldId: "numeric", alias: "n", outputType: "numeric", fragment: null },
      { fieldId: "date", alias: "d", outputType: "date", fragment: null },
      { fieldId: "datetime", alias: "dt", outputType: "timestamptz", fragment: null },
      { fieldId: "boolean_true", alias: "bt", outputType: "boolean", fragment: null },
      { fieldId: "boolean_invalid", alias: "bi", outputType: "boolean", fragment: null },
    ] as const;

    applyComputedProjections(
      [
        {
          id: "record_1",
          n: "42.5",
          d: new Date("2026-07-12T14:30:00.000Z"),
          dt: new Date("2026-07-12T14:30:00.000Z"),
          bt: "true",
          bi: "not-a-boolean",
        },
      ],
      new Map([["record_1", record]]),
      [...projections],
    );

    expect(record.data).toEqual({
      numeric: "42.5",
      date: "2026-07-12",
      datetime: "2026-07-12T14:30:00.000Z",
      boolean_true: true,
      boolean_invalid: null,
    });
  });
});

describe("materialized local read projections", () => {
  const amount = field({ id: "amount_id", shortId: "Amount", name: "Amount", type: "number" });
  const total = field({ id: "total_id", shortId: "Total1", name: "Total", type: "formula", config: { expression: "Amount * 2" } });

  test("opts in only stored sources and reuses stored dependencies in dynamic roots", async () => {
    const dynamic = field({
      id: "dynamic_id",
      shortId: "Dyn001",
      name: "Dynamic",
      type: "formula",
      config: { expression: "IF(TODAY() = TODAY(), Total1, 0)" },
    });
    const fields = [amount, total, dynamic];
    const stored = await buildComputedFieldSqlMap(fields, { useStoredLocalValues: true, fieldIds: new Set([dynamic.id]) });
    expect([...stored.keys()]).toEqual([dynamic.id]);
    expect(normalizedSql(stored.get(dynamic.id)!.sql)).toContain("current_local_calculations");
    const virtual = await buildComputedFieldSqlMap(fields, { useFinalizedFormulaValues: false });
    expect(normalizedSql(virtual.get(total.id)!.sql)).not.toContain("current_local_calculations");
  });

  test("uses prepared formula and list values with their error projections", async () => {
    const list = field({
      id: "list_id",
      shortId: "List01",
      name: "Positions",
      type: "object_list",
      config: {
        fields: [
          { id: "Amount", name: "Amount", type: "number", config: {} },
          { id: "Double", name: "Double", type: "number", config: {}, formula: { expression: "Amount * 2" } },
        ],
      },
    });
    const fields = [amount, total, list];
    const map = await buildComputedFieldSqlMap(fields, { useStoredLocalValues: true });
    const projections = buildFormulaSqlProjections(fields, { computedFieldSql: map });
    expect(projections).toHaveLength(2);
    for (const projection of projections) {
      expect(projection.expr).toBe(map.get(projection.fieldId)!.sql);
      expect(projection.errorSql).toBe(map.get(projection.fieldId)!.errorSql);
    }
    expect(projections.find((item) => item.fieldId === list.id)!.outputType).toBe("json");
    const record = { data: { [list.id]: [{ Amount: "3", Double: "6" }] }, fieldErrors: { [list.id]: "stored error" } };
    const listProjection = projections.find((item) => item.fieldId === list.id)!;
    applyComputedProjections([{ id: "record", [`e_${listProjection.alias}`]: true }], new Map([["record", record]]), [listProjection]);
    const storedError = record.fieldErrors[list.id];
    expect(storedError).not.toBe("stored error");
    enrichRecordsWithFormulas([record], [list], { skipObjectListFieldIds: new Set([list.id]) });
    expect(record.fieldErrors[list.id]).toBe(storedError);
    expect(record.data[list.id]).toEqual([{ Amount: "3", Double: "6" }]);
  });
});
