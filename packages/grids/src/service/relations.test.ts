import { describe, expect, test } from "bun:test";
import { collectHydratedRelationTargetIds } from "./relation-targets";
import { enrichRecordsWithComputedColumns, enrichRecordsWithFormulas, relationLabelFields } from "./relations";
import type { Field, GridRecord } from "./types";

// =============================================================================
// enrichRecordsWithFormulas — pure in-memory function. Tests the dependency
// ordering, cycle detection, public-ID resolution, and currency-precision
// integration that powers every records read.
// =============================================================================

const mkField = (overrides: Partial<Field> & Pick<Field, "id" | "type">): Field => ({
  shortId: overrides.id.slice(0, 6),
  tableId: "00000000-0000-0000-0000-000000000000",
  name: overrides.id,
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
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

const mkFormula = (id: string, shortId: string, expression: string): Field =>
  mkField({
    id,
    shortId,
    type: "formula",
    config: { expression },
  });

const mkRecord = (id: string, data: Record<string, unknown>): GridRecord => ({
  id,
  shortId: id.slice(0, 6).padEnd(6, "0"),
  tableId: "00000000-0000-0000-0000-000000000000",
  data,
  version: 1,
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

describe("relationLabelFields", () => {
  test("uses presentable fields in position order", () => {
    const a = mkField({ id: "a", type: "text", position: 2, presentable: true });
    const b = mkField({ id: "b", type: "text", position: 1, presentable: true });
    const fallback = mkField({ id: "fallback", type: "text", position: 0 });
    expect(relationLabelFields([a, b, fallback]).map((f) => f.id)).toEqual(["b", "a"]);
  });

  test("falls back to the first single-line text field", () => {
    const n = mkField({ id: "n", type: "number", position: 0 });
    const title = mkField({ id: "title", type: "text", position: 1 });
    const notes = mkField({ id: "notes", type: "longtext", position: 2 });
    expect(relationLabelFields([notes, n, title]).map((f) => f.id)).toEqual(["title"]);
  });

  test("does not use longtext as implicit label fallback", () => {
    const notes = mkField({ id: "notes", type: "longtext", position: 0 });
    expect(relationLabelFields([notes])).toEqual([]);
  });
});

describe("collectHydratedRelationTargetIds", () => {
  test("collects hydrated relation ids without duplicating targets", () => {
    const relation = mkField({
      id: "relation",
      type: "relation",
      config: { targetTableId: "target-table" },
    });
    const first = mkRecord("record-1", { relation: ["target-1", "target-2"] });
    const second = mkRecord("record-2", { relation: "target-1" });

    expect([...collectHydratedRelationTargetIds([first, second], [relation]).entries()]).toEqual([
      ["target-table", new Set(["target-1", "target-2"])],
    ]);
  });
});

describe("enrichRecordsWithFormulas — basic evaluation", () => {
  test("virtual formulas calculate without changing frozen list cells or stored formula snapshots", () => {
    const list = mkField({
      id: "items",
      shortId: "Items1",
      type: "object_list",
      config: {
        fields: [
          { id: "Amount", name: "Amount", type: "number", config: {}, required: false },
          { id: "Total1", name: "Total", type: "number", config: {}, required: false, formula: { expression: "Amount * 3" } },
        ],
      },
    });
    const total = mkFormula("total", "Total2", "LIST_SUM(Items1, 'Total')");
    const record = { ...mkRecord("record", { items: [{ Amount: "2", Total1: "4" }], total: "99" }), finalizedAt: "2026-09-11T00:00:00Z" };
    enrichRecordsWithFormulas([record], [list, total]);
    expect(record.data.total).toBe("99");
    enrichRecordsWithFormulas([record], [list, total], { useFinalizedFormulaValues: false });
    expect(record.data.total).toBe("4");
    expect(record.data.items).toEqual([{ Amount: "2", Total1: "4" }]);
  });

  test("computes a single formula referencing a public field id", () => {
    const price = mkField({ id: "fld-price", shortId: "PRICE1", type: "number" });
    const total = mkFormula("fld-total", "TOTAL1", "{PRICE1} * 1.19");
    const rec = mkRecord("rec-1", {
      "fld-price": "24.50",
    });
    enrichRecordsWithFormulas([rec], [price, total]);
    // Decimal-safe number arithmetic preserves precision via decimal.js.
    expect(rec.data["fld-total"]).toBe("29.155");
  });

  test("no formula fields → records pass through unchanged", () => {
    const rec = mkRecord("rec-1", { x: 1 });
    const recs = [rec];
    const out = enrichRecordsWithFormulas(recs, []);
    expect(out).toBe(recs); // identity (early return)
    expect(rec.data).toEqual({ x: 1 });
  });

  test("formula with bad expression renders nothing (silent skip)", () => {
    const broken = mkFormula("fld-broken", "BROKE1", "1 + ");
    const rec = mkRecord("rec-1", {});
    enrichRecordsWithFormulas([rec], [broken]);
    // Bad parse → orderFormulasByDeps drops the field; nothing written.
    expect(rec.data["fld-broken"]).toBeUndefined();
  });

  test("formula with empty expression skipped silently", () => {
    const empty = mkFormula("fld-empty", "EMPTY1", "");
    const rec = mkRecord("rec-1", {});
    enrichRecordsWithFormulas([rec], [empty]);
    expect(rec.data["fld-empty"]).toBeUndefined();
  });

  test("formula date functions use the provided timezone context", () => {
    const today = mkFormula("fld-today", "TODAY1", "TODAY()");
    const rec = mkRecord("rec-1", {});
    enrichRecordsWithFormulas([rec], [today], {
      dateConfig: { timeZone: "Europe/Berlin" },
      now: new Date("2026-05-01T22:30:00.000Z"),
    });
    expect(rec.data["fld-today"]).toBe("2026-05-02");
  });

  test("deleted formula fields are ignored", () => {
    const f = { ...mkFormula("fld-1", "FORM01", "1 + 1"), deletedAt: "2026-01-02T00:00:00Z" };
    const rec = mkRecord("rec-1", {});
    enrichRecordsWithFormulas([rec], [f]);
    expect(rec.data["fld-1"]).toBeUndefined();
  });
});

describe("enrichRecordsWithFormulas — dependency ordering", () => {
  test("formula referencing another formula evaluates after it", () => {
    // base = 10, doubled = base * 2, plusOne = doubled + 1
    // Declaration order is intentionally reversed from dep order so the
    // test fails if the topo sort regresses.
    const base = mkField({ id: "fld-base", shortId: "BASE01", type: "number" });
    const plusOne = mkFormula("fld-plus", "PLUS01", "{DBLED1} + 1");
    const doubled = mkFormula("fld-dbl", "DBLED1", "{BASE01} * 2");
    const rec = mkRecord("rec-1", { "fld-base": 10 });
    enrichRecordsWithFormulas([rec], [base, plusOne, doubled]);
    expect(rec.data["fld-dbl"]).toBe(20);
    expect(rec.data["fld-plus"]).toBe(21);
  });

  test("chain of three formulas evaluates in correct order", () => {
    // a = 1, b = a + 1, c = b + 1, d = c + 1 — produces 2, 3, 4.
    const a = mkField({ id: "fld-a", shortId: "ALPHA1", type: "number" });
    const b = mkFormula("fld-b", "BRAVO1", "{ALPHA1} + 1");
    const c = mkFormula("fld-c", "CHARL1", "{BRAVO1} + 1");
    const d = mkFormula("fld-d", "DELTA1", "{CHARL1} + 1");
    const rec = mkRecord("rec-1", { "fld-a": 1 });
    // Shuffle declaration: d first, then b, then c. Topo sort must still
    // pick the right order.
    enrichRecordsWithFormulas([rec], [a, d, b, c]);
    expect(rec.data["fld-b"]).toBe(2);
    expect(rec.data["fld-c"]).toBe(3);
    expect(rec.data["fld-d"]).toBe(4);
  });
});

describe("enrichRecordsWithFormulas — cycle detection", () => {
  test("self-reference renders #CYCLE", () => {
    const self = mkFormula("fld-self", "SELF01", "{SELF01} + 1");
    const rec = mkRecord("rec-1", {});
    enrichRecordsWithFormulas([rec], [self]);
    expect(rec.data["fld-self"]).toBe("#CYCLE");
  });

  test("two-node cycle marks BOTH members with #CYCLE", () => {
    // a → b → a
    const a = mkFormula("fld-a", "AAAAA1", "{BBBBB1} + 1");
    const b = mkFormula("fld-b", "BBBBB1", "{AAAAA1} + 1");
    const rec = mkRecord("rec-1", {});
    enrichRecordsWithFormulas([rec], [a, b]);
    expect(rec.data["fld-a"]).toBe("#CYCLE");
    expect(rec.data["fld-b"]).toBe("#CYCLE");
  });

  test("three-node cycle marks all three", () => {
    // a → b → c → a
    const a = mkFormula("fld-a", "AAAAA1", "{BBBBB1}");
    const b = mkFormula("fld-b", "BBBBB1", "{CCCCC1}");
    const c = mkFormula("fld-c", "CCCCC1", "{AAAAA1}");
    const rec = mkRecord("rec-1", {});
    enrichRecordsWithFormulas([rec], [a, b, c]);
    expect(rec.data["fld-a"]).toBe("#CYCLE");
    expect(rec.data["fld-b"]).toBe("#CYCLE");
    expect(rec.data["fld-c"]).toBe("#CYCLE");
  });

  test("non-cycle formula adjacent to a cycle still evaluates", () => {
    // a ↔ b cycle; clean = 2 + 2 (independent).
    const a = mkFormula("fld-a", "AAAAA1", "{BBBBB1}");
    const b = mkFormula("fld-b", "BBBBB1", "{AAAAA1}");
    const clean = mkFormula("fld-c", "CLEAN1", "2 + 2");
    const rec = mkRecord("rec-1", {});
    enrichRecordsWithFormulas([rec], [a, b, clean]);
    expect(rec.data["fld-a"]).toBe("#CYCLE");
    expect(rec.data["fld-b"]).toBe("#CYCLE");
    expect(rec.data["fld-c"]).toBe(4);
  });
});

describe("enrichRecordsWithFormulas — public id map", () => {
  test("public id map is built across all alive non-formula fields, not just formulas", () => {
    // The formula references a non-formula field by public ID. If the ID map
    // skipped non-formulas, this would fail to resolve and return null.
    const price = mkField({ id: "fld-price", shortId: "PR1CE1", type: "number" });
    const total = mkFormula("fld-total", "TOTAL1", "{PR1CE1} * 2");
    const rec = mkRecord("rec-1", { "fld-price": "5" });
    enrichRecordsWithFormulas([rec], [price, total]);
    expect(rec.data["fld-total"]).toBe("10");
  });

  test("deleted fields are excluded from the shortId map", () => {
    const live = mkField({ id: "fld-live", shortId: "ALIVE1", type: "number" });
    const dead = {
      ...mkField({ id: "fld-dead", shortId: "DEADX1", type: "number" }),
      deletedAt: "2026-01-02T00:00:00Z",
    };
    // Formula references the deleted field's public ID — should resolve to null
    // (ID not in the map), not to the deleted field's record value.
    const f = mkFormula("fld-f", "FFFFF1", "{DEADX1} + 1");
    const rec = mkRecord("rec-1", { "fld-live": 10, "fld-dead": 99 });
    enrichRecordsWithFormulas([rec], [live, dead, f]);
    expect(rec.data["fld-f"]).toBeNull();
  });

  test("resolves multiple canonical public field ids", () => {
    const a = mkField({ id: "fld-a", shortId: "AAAAA1", type: "number" });
    const b = mkField({ id: "fld-b", shortId: "BBBBB1", type: "number" });
    const f = mkFormula("fld-f", "FFFFF1", "{AAAAA1} + {BBBBB1}");
    const rec = mkRecord("rec-1", { "fld-a": 3, "fld-b": 7 });
    enrichRecordsWithFormulas([rec], [a, b, f]);
    expect(rec.data["fld-f"]).toBe(10);
  });
});

describe("enrichRecordsWithFormulas — multiple records", () => {
  test("evaluates per-record without leaking state between rows", () => {
    const x = mkField({ id: "fld-x", shortId: "XXXXX1", type: "number" });
    const f = mkFormula("fld-f", "FFFFF1", "{XXXXX1} * 2");
    const r1 = mkRecord("r-1", { "fld-x": 1 });
    const r2 = mkRecord("r-2", { "fld-x": 5 });
    const r3 = mkRecord("r-3", { "fld-x": null });
    enrichRecordsWithFormulas([r1, r2, r3], [x, f]);
    expect(r1.data["fld-f"]).toBe(2);
    expect(r2.data["fld-f"]).toBe(10);
    expect(r3.data["fld-f"]).toBeNull();
  });
});

describe("enrichRecordsWithFormulas — SQL-projected formula compatibility", () => {
  test("skips SQL-projected formulas while remaining formulas can reference them", () => {
    const net = mkField({ id: "fld-net", shortId: "NET001", type: "number" });
    const subtotal = mkFormula("fld-sub", "SUB001", "{NET001} * 2");
    const gross = mkFormula("fld-gross", "GROSS1", "{SUB001} + 1");
    const rec = mkRecord("rec-1", { "fld-net": "12.10", "fld-sub": "24.2" });

    enrichRecordsWithFormulas([rec], [net, subtotal, gross], {
      skipFormulaFieldIds: new Set(["fld-sub"]),
    });

    expect(rec.data["fld-sub"]).toBe("24.2");
    expect(rec.data["fld-gross"]).toBe("25.2");
  });
});

describe("enrichRecordsWithComputedColumns", () => {
  test("evaluates view-only formulas without persisting field metadata", () => {
    const price = mkField({ id: "fld-price", shortId: "PRICE1", type: "number" });
    const rec = mkRecord("rec-1", { "fld-price": "24.50" });

    enrichRecordsWithComputedColumns(
      [rec],
      [price],
      [
        {
          kind: "computed",
          id: "computed_total",
          label: "Total with VAT",
          expression: "{PRICE1} * 1.19",
        },
      ],
    );

    expect(rec.data.computed_total).toBe("29.155");
    expect(price.type).toBe("number");
  });

  test("can reference formula field values evaluated earlier in the read pipeline", () => {
    const net = mkField({ id: "fld-net", shortId: "NET001", type: "number" });
    const subtotal = mkFormula("fld-sub", "SUB001", "{NET001} * 2");
    const rec = mkRecord("rec-1", { "fld-net": "12.10" });

    enrichRecordsWithFormulas([rec], [net, subtotal]);
    enrichRecordsWithComputedColumns(
      [rec],
      [net, subtotal],
      [
        {
          kind: "computed",
          id: "computed_gross",
          label: "Gross",
          expression: "{SUB001} + 1",
        },
      ],
    );

    expect(rec.data["fld-sub"]).toBe("24.2");
    expect(rec.data.computed_gross).toBe("25.2");
  });
});
