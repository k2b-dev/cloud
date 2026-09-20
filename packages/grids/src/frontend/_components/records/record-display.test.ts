import { describe, expect, test } from "bun:test";
import type { Field, GridRecord } from "../../../service";
import { recordDisplayTitle } from "./record-display";

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

const record = (data: Record<string, unknown>, id = "12345678-abcd-4000-8000-000000000000"): GridRecord =>
  ({
    id,
    tableId: "table",
    data,
    version: 1,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as GridRecord;

describe("record display title", () => {
  test("uses the same configured select label across record surfaces", () => {
    const status = field({
      id: "status",
      name: "Status",
      type: "select",
      presentable: true,
      config: { options: [{ id: "ready", label: "Ready" }] },
    });

    expect(recordDisplayTitle({ fields: [status], record: record({ status: "ready" }) })).toBe("Ready");
  });

  test("uses lookup target metadata and view format overrides", () => {
    const relation = field({ id: "product", name: "Product", type: "relation", config: { targetTableId: "products" } });
    const lookup = field({
      id: "price",
      name: "Price",
      type: "lookup",
      presentable: true,
      config: { relationFieldId: relation.id, targetFieldId: "amount" },
    });
    const amount = field({ id: "amount", tableId: "products", name: "Amount", type: "number", config: { unit: "EUR" } });

    expect(
      recordDisplayTitle({
        fields: [relation, lookup],
        record: record({ price: "1200" }),
        fieldsByTable: { table: [relation, lookup], products: [amount] },
        viewColumns: [{ fieldId: lookup.id, format: { kind: "decimal", precision: 2, thousandsSeparator: true } }],
      }),
    ).toBe("1,200.00 EUR");
  });

  test("falls back to a stable short record id", () => {
    expect(recordDisplayTitle({ fields: [], record: record({}) })).toBe("12345678");
  });
});
