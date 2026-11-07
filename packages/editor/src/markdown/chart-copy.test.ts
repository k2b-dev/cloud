import { describe, expect, test } from "bun:test";
import { chartTableText } from "./chart-copy";

const table = (cells: string[]) => ({
  columns: [{ id: "value", label: "Wert", numeric: true }],
  rows: cells.map((cell, index) => ({ key: String(index), cells: { value: cell }, values: { value: index } })),
});

describe("chart Copy data", () => {
  test("keeps formatted numbers as values and guards every cell that could run as a formula", () => {
    const formatted = ["-1.200,00 €", "-$18.00", "-5 %", "+3", "1.234,5"];
    expect(chartTableText(table(formatted))).toBe(["Wert", ...formatted].join("\n"));
    // A numeric column's formatted text can still start a formula through its unit or label.
    expect(chartTableText(table(["-1 +1", "=SUM(A1)", "@team", "-1,5 kWh"]))).toBe(
      ["Wert", "'-1 +1", "'=SUM(A1)", "'@team", "'-1,5 kWh"].join("\n"),
    );
  });

  test("quotes cells with tabs, line breaks or quotes", () => {
    expect(chartTableText(table(['Er sagte "ja"', "a\tb"]))).toBe(["Wert", '"Er sagte ""ja"""', '"a\tb"'].join("\n"));
  });
});
