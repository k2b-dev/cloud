import { describe, expect, test } from "bun:test";
import { planLocalCalculations } from "./local-calculations";
import type { Field } from "./types";

const field = (name: string, type: Field["type"], config: Field["config"] = {}): Field => ({
  id: `${name}-id`,
  shortId: name,
  tableId: "table-id",
  name,
  description: null,
  icon: null,
  type,
  config,
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
const formula = (name: string, expression: string) => field(name, "formula", { expression });
const positions = () =>
  field("Positions", "object_list", {
    fields: [
      { id: "Amount", name: "Amount", type: "number", config: { integerOnly: true }, required: true },
      { id: "Price1", name: "Price", type: "number", config: { decimalPlaces: 2 }, required: true },
      { id: "Net001", name: "Net", type: "number", config: { decimalPlaces: 2 }, formula: { expression: "Amount * Price1" } },
    ],
  });

describe("local calculation plans", () => {
  test("orders transitive invoice dependencies and reuses prepared list/formula types", () => {
    const fields = [
      formula("Gross1", "Net001 + Tax001"),
      formula("Tax001", "ROUND(Net001 * 0.19, 2)"),
      formula("Net001", "LIST_SUM(Positions, 'Net001')"),
      positions(),
    ];
    const plan = planLocalCalculations(fields);
    expect(plan.steps.map((step) => step.field.shortId)).toEqual(["Net001", "Tax001", "Gross1"]);
    expect([...plan.objectListIds]).toEqual(["Positions-id"]);
    expect(plan.types).toEqual({ "Positions-id": "json", "Net001-id": "numeric", "Tax001-id": "numeric", "Gross1-id": "numeric" });
  });

  test("excludes relation, principal, system and volatile dependencies transitively", () => {
    const fields = [
      field("Lookup", "lookup"),
      field("Rollup", "rollup"),
      field("Linked", "relation"),
      field("Person", "principal"),
      field("Created", "created_at"),
      field("Updated", "updated_at"),
      field("Author", "created_by"),
      formula("Now001", "NOW()"),
      formula("Today1", "TODAY()"),
      formula("Year01", "YEAR('2026-01-01')"),
      ...["Lookup", "Rollup", "Linked", "Person", "Created", "Updated", "Author", "Now001", "Today1", "Year01"].map((name) =>
        formula(`${name}Copy`, name),
      ),
      field("Ident1", "id"),
      formula("CopyId", "Ident1"),
      formula("Local1", "2 + 3"),
    ];
    expect([...planLocalCalculations(fields).formulaIds].sort()).toEqual(["CopyId-id", "Local1-id"]);
  });

  test("keeps reader-time-zone-sensitive text/date comparisons live while numeric comparisons are local", () => {
    const plan = planLocalCalculations([
      field("Text01", "text"),
      field("Date01", "date"),
      field("Amount", "number"),
      formula("TextEq", "Text01 = '2026-01-01T00:00:00Z'"),
      formula("DateEq", "Date01 = Text01"),
      formula("Number", "Amount > 0"),
      formula("DateCp", "Date01"),
      formula("TextCp", "CONCAT(Text01, '!')"),
    ]);
    expect([...plan.formulaIds].sort()).toEqual(["DateCp-id", "Number-id", "TextCp-id"]);
    expect(plan.types["DateCp-id"]).toBe("date");
  });

  test("binds select membership before classifying comparisons", () => {
    const plan = planLocalCalculations([
      field("Status", "select", { options: [{ id: "active", label: "Active" }] }),
      formula("Active", "Status = 'Active'"),
      formula("Count1", "IF(Active, 1, 0)"),
    ]);
    expect([...plan.formulaIds]).toEqual(["Active-id", "Count1-id"]);
    expect(plan.steps[0]!.ast).toMatchObject({ kind: "call", fn: "HAS_OPTION", args: [{ kind: "field" }, { value: "active" }] });
    expect(plan.types).toEqual({ "Active-id": "boolean", "Count1-id": "numeric" });
  });

  test("volatile or time-zone-dependent list cells keep their parent and reductions live", () => {
    const today = field("LiveList", "object_list", {
      fields: [{ id: "Today1", name: "Today", type: "date", formula: { expression: "TODAY()" } }],
    });
    const temporal = field("TextList", "object_list", {
      fields: [
        { id: "Text01", name: "Text", type: "text" },
        { id: "Check1", name: "Check", type: "boolean", formula: { expression: "Text01 = '2026-01-01'" } },
      ],
    });
    const plan = planLocalCalculations([
      today,
      temporal,
      formula("Count1", "LIST_COUNT(LiveList)"),
      formula("Count2", "LIST_COUNT(TextList)"),
    ]);
    expect(plan.objectListIds.size).toBe(0);
    expect(plan.formulaIds.size).toBe(0);
  });

  test("rejects invalid, cyclic, ambiguous and deleted dependencies without poisoning independent fields", () => {
    const gone = { ...field("Gone01", "number"), deletedAt: "2026-01-02T00:00:00.000Z" };
    const ambiguous = { ...field("Other1", "number"), name: "Amount" };
    const plan = planLocalCalculations([
      formula("CycleA", "CycleB"),
      formula("CycleB", "CycleA"),
      formula("Child1", "CycleA + 1"),
      formula("Empty1", ""),
      formula("Bad001", "1 +"),
      formula("Bad002", "UNKNOWN(1)"),
      gone,
      formula("GoneCp", "Gone01"),
      field("Amount", "number"),
      ambiguous,
      formula("Ambig1", "Amount + 1"),
      formula("Safe01", "IF(false, 1 / 0, 2)"),
      formula("Safe02", "IFERROR(1 / 0, 3)"),
    ]);
    expect([...plan.formulaIds]).toEqual(["Safe01-id", "Safe02-id"]);
  });

  test("supports dependency chains beyond the old live inlining depth", () => {
    const fields = Array.from({ length: 12 }, (_, i) => formula(`Step${i}`, i ? `Step${i - 1} + 1` : "1"));
    const plan = planLocalCalculations(fields.toReversed());
    expect(plan.steps.map((step) => step.field.shortId)).toEqual(fields.map((item) => item.shortId));
    expect(Object.values(plan.types).every((type) => type === "numeric")).toBe(true);
  });

  test("signatures are independent of field order, UI metadata and unrelated fields", () => {
    const fields = [positions(), formula("Total1", "LIST_SUM(Positions, 'Net001')")];
    const original = planLocalCalculations(fields);
    const restyled = structuredClone(fields);
    restyled[0]!.position = 99;
    restyled[0]!.description = "A new description";
    restyled[0]!.config = {
      ...restyled[0]!.config,
      fields: [
        { id: "Amount", name: "Amount", type: "number", config: { integerOnly: true, unit: "items" }, required: true, width: "compact" },
        { id: "Price1", name: "Price", type: "number", config: { decimalPlaces: 2, unit: "EUR" }, required: true },
        {
          id: "Net001",
          name: "Net",
          type: "number",
          config: { decimalPlaces: 2 },
          formula: { expression: "Amount * Price1" },
          detailsOnly: true,
        },
      ],
    };
    restyled[1]!.config.format = { kind: "number", decimalPlaces: 2 };
    expect(planLocalCalculations([...restyled.toReversed(), field("Unused", "text")]).signature).toBe(original.signature);
  });

  test("signatures change with formulas, dependency types and list calculation constraints", () => {
    const fields = [field("Amount", "number"), formula("Total1", "Amount + 1")];
    const original = planLocalCalculations(fields).signature;
    expect(planLocalCalculations([fields[0]!, formula("Total1", "Amount + 2")]).signature).not.toBe(original);
    expect(planLocalCalculations([field("Amount", "text"), fields[1]!]).signature).not.toBe(original);
    expect(planLocalCalculations([formula("Const1", "1")]).signature).not.toBe(planLocalCalculations([formula("Const1", "'1'")]).signature);
    const list = positions();
    const first = planLocalCalculations([list]).signature;
    list.config = { ...list.config, maxItems: 20 };
    expect(planLocalCalculations([list]).signature).not.toBe(first);
  });

  test("signatures include list column names used by reductions", () => {
    const total = formula("Total1", "LIST_SUM(Items1, 'Amount')");
    const list = field("Items1", "object_list", {
      fields: [
        { id: "First1", name: "Amount", type: "number" },
        { id: "Second", name: "Other", type: "number" },
      ],
    });
    const original = planLocalCalculations([list, total]);
    const renamed = field("Items1", "object_list", {
      fields: [
        { id: "First1", name: "Other", type: "number" },
        { id: "Second", name: "Amount", type: "number" },
      ],
    });
    const changed = planLocalCalculations([renamed, total]);
    expect(changed.formulaIds.has(total.id)).toBe(true);
    expect(changed.signature).not.toBe(original.signature);
  });
});
