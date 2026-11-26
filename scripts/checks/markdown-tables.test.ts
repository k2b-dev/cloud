import { expect, test } from "bun:test";
import { findInMarkdown } from "./markdown-tables";

test("a row with more or fewer cells than its head is found; escaped pipes, code fences and other tables are not", () => {
  const source = [
    "| Name | Kind | Use |",
    "| --- | --- | --- |",
    "| `a` | Preview | One |",
    "| `b` | Preview | Two | [Link](/x) |",
    "| `c` \\| `d` | Preview | Three |",
    "| `e` | Preview |",
    "",
    "```md",
    "| not | a | table |",
    "| --- | --- |",
    "| x |",
    "```",
    "",
    "| A | B |",
    "|:--|--:|",
    "| 1 | 2 |",
  ].join("\n");
  expect(findInMarkdown(source)).toEqual([
    { line: 4, message: "the row has 4 cells, its table's head 3" },
    { line: 6, message: "the row has 2 cells, its table's head 3" },
  ]);
});
