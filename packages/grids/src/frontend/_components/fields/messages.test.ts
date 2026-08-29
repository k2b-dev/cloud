import { describe, expect, test } from "bun:test";
import { GRID_FORMULA_FUNCTIONS } from "../../../formula/function-catalog";
import { gridsFieldMessages } from "./messages";

describe("gridsFieldMessages", () => {
  test("keeps English as the base locale", () => {
    const { t } = gridsFieldMessages.resolve(["en"]);
    expect(t.typeLabel({ type: "longtext" })).toBe("Long text");
    expect(t.formulaFunctionDescription({ name: "SUM", fallback: "Add numeric values." })).toBe("Add numeric values.");
  });

  test("resolves regional German locales", () => {
    const { t } = gridsFieldMessages.resolve(["de-CH"]);
    expect(t.typeLabel({ type: "longtext" })).toBe("Langtext");
    expect(t.formulaFunctionDescription({ name: "SUM", fallback: "Add numeric values." })).toBe("Addiert numerische Werte.");
    expect(t.deleteField).toBe("Feld löschen");
  });

  test("localizes every formula description by its stable function name", () => {
    const { t } = gridsFieldMessages.resolve(["de-CH"]);
    for (const fn of GRID_FORMULA_FUNCTIONS) {
      expect(t.formulaFunctionDescription({ name: fn.name, fallback: fn.description })).not.toBe(fn.description);
    }
  });
});
