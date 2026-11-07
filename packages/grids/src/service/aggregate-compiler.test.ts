import { describe, expect, test } from "bun:test";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { compileAggregates } from "./aggregate-compiler";
import type { Field } from "./types";

useUnitClients();

const mkField = (id: string, type: string): Field => ({
  id,
  shortId: id,
  tableId: "t1",
  name: id,
  description: null,
  type,
  config: {},
  presentable: false,
  hideInTable: false,
  position: 0,
  required: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const fields: Field[] = [
  mkField("fld_text", "text"),
  mkField("fld_amount", "number"),
  mkField("fld_date", "date"),
  mkField("fld_done", "boolean"),
];

describe("compileAggregates — type compatibility", () => {
  test("count works on any type", () => {
    const r = compileAggregates(
      [
        { fieldId: "fld_text", agg: "count" },
        { fieldId: "fld_amount", agg: "count" },
        { fieldId: "fld_done", agg: "count" },
      ],
      fields,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.columns).toHaveLength(3);
  });

  test("sum/avg/median only on numeric types", () => {
    const r1 = compileAggregates([{ fieldId: "fld_amount", agg: "sum" }], fields);
    expect(r1.ok).toBe(true);

    const r2 = compileAggregates([{ fieldId: "fld_text", agg: "sum" }], fields);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/not compatible/);

    const r3 = compileAggregates([{ fieldId: "fld_amount", agg: "median" }], fields);
    expect(r3.ok).toBe(true);
  });

  test("earliest/latest only on date", () => {
    const r1 = compileAggregates([{ fieldId: "fld_date", agg: "earliest" }], fields);
    expect(r1.ok).toBe(true);

    const r2 = compileAggregates([{ fieldId: "fld_amount", agg: "earliest" }], fields);
    expect(r2.ok).toBe(false);
  });

  test("min/max work on numeric, date, and text", () => {
    for (const fieldId of ["fld_amount", "fld_date", "fld_text"]) {
      const r = compileAggregates([{ fieldId, agg: "min" }], fields);
      expect(r.ok).toBe(true);
    }
  });

  test("min/max reject boolean", () => {
    const r = compileAggregates([{ fieldId: "fld_done", agg: "min" }], fields);
    expect(r.ok).toBe(false);
  });
});

describe("compileAggregates — error paths", () => {
  test("rejects unknown field", () => {
    const r = compileAggregates([{ fieldId: "fld_missing", agg: "count" }], fields);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown field/);
  });

  test("rejects deleted field", () => {
    const dead = { ...mkField("fld_x", "text"), deletedAt: "2026-01-01T00:00:00Z" };
    const r = compileAggregates([{ fieldId: "fld_x", agg: "count" }], [...fields, dead]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/deleted/);
  });
});

describe("compileAggregates — keys", () => {
  test("each request gets a stable key based on fieldId+agg", () => {
    const r = compileAggregates(
      [
        { fieldId: "fld_amount", agg: "sum" },
        { fieldId: "fld_amount", agg: "avg" },
      ],
      fields,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns.map((c) => c.key)).toEqual(["fld_amount__sum", "fld_amount__avg"]);
    }
  });
});

describe("compileAggregates — `*` virtual field (row count)", () => {
  test("`*` count compiles with the *__count key", () => {
    const r = compileAggregates([{ fieldId: "*", agg: "count" }], fields);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns).toHaveLength(1);
      expect(r.columns[0]!.key).toBe("*__count");
    }
  });

  test("`*` mixed with field-scoped aggregations preserves order", () => {
    const r = compileAggregates(
      [
        { fieldId: "*", agg: "count" },
        { fieldId: "fld_amount", agg: "sum" },
      ],
      fields,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns.map((c) => c.key)).toEqual(["*__count", "fld_amount__sum"]);
    }
  });

  test("`*` rejects non-count aggregations", () => {
    for (const agg of ["sum", "avg", "min", "max", "median"] as const) {
      const r = compileAggregates([{ fieldId: "*", agg }], fields);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/only count works on "\*"/);
    }
  });
});
