import { describe, expect, test } from "bun:test";
import { cellTextBeforeCursor, isTableRow, splitTableLineCells, tableCellText } from "./table-cell";

describe("Markdown table source cells", () => {
  test.each([
    ["| Ada \\| Grace | =LEN(Name) |", ["Ada | Grace", "=LEN(Name)"]],
    ["  | a | | b |  ", ["a", "", "b"]],
    ["a | b", ["a", "b"]],
    ["| a | b", ["a", "b"]],
    ["a | b |", ["a", "b"]],
    ["| `a\\|b` | c |", ["`a|b`", "c"]],
    ["| a\\\\| b |", ["a\\\\", "b"]],
    ["| a\\\\\\|b | c |", ["a\\\\|b", "c"]],
  ])("keeps delimiters and escaped content distinct: %s", (line, expected) => {
    const cells = splitTableLineCells(line);
    expect(cells.map((cell) => tableCellText(cell.text))).toEqual(expected);
    for (const cell of cells) expect(line.slice(cell.fromInLine, cell.toInLine)).toBe(cell.text);
  });

  test("completion reads the whole formula cell across escaped pipes", () => {
    const line = '| a | =CONCAT("a\\|b", Na |';
    const cursor = line.indexOf("Na") + 2;
    const cell = cellTextBeforeCursor(line, cursor);
    expect(cell).toEqual({ from: 5, text: ' =CONCAT("a\\|b", Na' });
    expect(cellTextBeforeCursor(line, 0)).toBeNull();
    expect(isTableRow("| a \\|")).toBe(false);
    expect(isTableRow("| a \\| b |")).toBe(true);
    expect(isTableRow("|")).toBe(false);
    expect(isTableRow("||")).toBe(false);
  });
});
