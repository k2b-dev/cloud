import { describe, expect, test } from "bun:test";
import type { ColumnSpec, FieldColumnSpec } from "../../../contracts";
import type { Field } from "../../../service";
import { recordsViewMessages } from "./messages";
import { isComputedColumn, isFieldColumn, mergeGroupedColumnOrder, moveColumn, resolveDefaultViewColumns } from "./records-view-columns";

const field = (id: string, position: number, options: { deleted?: boolean; hidden?: boolean } = {}): Field =>
  ({
    id,
    position,
    deletedAt: options.deleted ? "2026-01-01T00:00:00.000Z" : null,
    hideInTable: options.hidden ?? false,
  }) as Field;

describe("records view columns", () => {
  test("uses persisted table columns before field defaults", () => {
    const columns: FieldColumnSpec[] = [{ fieldId: "b" }, { fieldId: "a" }];
    expect(resolveDefaultViewColumns(columns, [field("a", 0), field("b", 1)])).toEqual(columns);
  });

  test("builds field defaults in position order and omits hidden or deleted fields", () => {
    expect(
      resolveDefaultViewColumns(
        [],
        [field("late", 3), field("hidden", 1, { hidden: true }), field("first", 0), field("deleted", 2, { deleted: true })],
      ),
    ).toEqual([{ fieldId: "first" }, { fieldId: "late" }]);
  });

  test("keeps saved grouped order, drops stale ids, and appends new columns", () => {
    expect(mergeGroupedColumnOrder(["group:a", "agg:count", "agg:sum"], ["agg:sum", "stale", "group:a"])).toEqual([
      "agg:sum",
      "group:a",
      "agg:count",
    ]);
  });

  test("moves columns only within bounds", () => {
    expect(moveColumn(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveColumn(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveColumn(["a", "b"], 0, -1)).toBeNull();
    expect(moveColumn(["a", "b"], 1, 1)).toBeNull();
  });

  test("distinguishes persisted fields from computed columns", () => {
    const computed: ColumnSpec = { kind: "computed", id: "total", label: "Total", expression: "Price * Quantity" };
    const persisted: ColumnSpec = { fieldId: "name" };
    expect(isComputedColumn(computed)).toBe(true);
    expect(isFieldColumn(computed)).toBe(false);
    expect(isComputedColumn(persisted)).toBe(false);
    expect(isFieldColumn(persisted)).toBe(true);
  });

  test("resolves column controller feedback for German regional locales", () => {
    const german = recordsViewMessages.resolve(["de"]).t;
    const swissGerman = recordsViewMessages.resolve(["de-CH"]).t;
    expect(german.noActiveView).toBe("Keine aktive Ansicht");
    expect(swissGerman.allColumnsVisible).toBe("Alle Spalten sind bereits sichtbar.");
    expect(swissGerman.noHiddenColumns).toBe("Keine ausgeblendeten Spalten");
  });
});
