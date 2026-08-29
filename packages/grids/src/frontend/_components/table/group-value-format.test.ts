import { describe, expect, test } from "bun:test";
import type { AggregationSpec, GroupBySpec } from "../../../contracts";
import type { Field } from "../../../service";
import { formatAggregationValue, formatGroupValue } from "./group-value-format";

const field = (overrides: Partial<Field> & Pick<Field, "id" | "name" | "type">): Field => ({
  shortId: overrides.id.slice(0, 6),
  tableId: "table",
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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("group value formatting", () => {
  test("uses relation labels and date bucket semantics for group keys", () => {
    const relation = field({ id: "relation", name: "Owner", type: "relation" });
    const date = field({ id: "date", name: "Created", type: "date", config: { includeTime: true } });

    expect(
      formatGroupValue({
        field: relation,
        spec: { fieldId: relation.id } as GroupBySpec,
        value: "owner-1",
        relationLabels: { "owner-1": "Ada" },
      }),
    ).toBe("Ada");
    expect(
      formatGroupValue({
        field: date,
        spec: { fieldId: date.id, granularity: "month" } as GroupBySpec,
        value: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe("2026-07-01");
  });

  test("keeps default aggregate rounding consistent across both surfaces", () => {
    const spec = { fieldId: "amount", agg: "avg" } as AggregationSpec;

    expect(formatAggregationValue({ value: 12.345, spec })).toBe("12.35");
    expect(formatAggregationValue({ value: 12, spec })).toBe("12");
    expect(formatAggregationValue({ value: null, spec })).toBe("—");
    expect(formatAggregationValue({ value: 12.345, spec, locale: "de-CH" })).toBe("12.35");
    expect(formatAggregationValue({ value: 12.345, spec, locale: "de" })).toBe("12,35");
  });

  test("applies aggregate format overrides with source field metadata", () => {
    const amount = field({ id: "amount", name: "Amount", type: "number" });
    const spec = {
      fieldId: amount.id,
      agg: "sum",
      format: { kind: "decimal", precision: 2, thousandsSeparator: true },
    } as AggregationSpec;

    expect(formatAggregationValue({ value: "1200", spec, field: amount })).toBe("1,200.00");
    expect(formatAggregationValue({ value: "1200", spec, field: amount, locale: "de" })).toBe("1.200,00");
  });

  test("localizes unknown group labels", () => {
    expect(formatGroupValue({ value: null, spec: { fieldId: "missing" } as GroupBySpec, locale: "de-CH" })).toBe("Unbekannt");
  });
});
