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

test("a separator of one dash makes a table, and a long fence closes only on a run at least as long", () => {
  const source = [
    "| A | B |",
    "|-|-|",
    "| 1 | 2 | 3 |",
    "",
    "````md",
    "```",
    "| inside | a |",
    "| - | - |",
    "| x |",
    "```",
    "````",
    "",
    "| C | D |",
    "| - | - |",
    "| 4 |",
  ].join("\n");
  expect(findInMarkdown(source)).toEqual([
    { line: 3, message: "the row has 3 cells, its table's head 2" },
    { line: 15, message: "the row has 1 cells, its table's head 2" },
  ]);
});

test("a tilde run inside a backtick fence, and a backtick run with words after it, close nothing", () => {
  const source = [
    "```md",
    "~~~",
    "| inside | a |",
    "| - | - |",
    "| x |",
    "``` not a closing run",
    "| still | inside |",
    "| - | - |",
    "| y |",
    "```",
    "",
    "| E | F |",
    "| - | - |",
    "| 5 |",
  ].join("\n");
  expect(findInMarkdown(source)).toEqual([{ line: 14, message: "the row has 1 cells, its table's head 2" }]);
});

test("a backtick run with a backtick in its info string opens no fence, so a table after it is still checked", () => {
  const source = ["```js `inline` code```", "", "| A | B |", "| --- | --- |", "| one | two | three |"].join("\n");
  expect(findInMarkdown(source)).toEqual([{ line: 5, message: "the row has 3 cells, its table's head 2" }]);
  // a tilde run may carry backticks in its info string and still opens a fence
  expect(findInMarkdown(["~~~ `x`", "| A | B |", "| --- | --- |", "| one | two | three |", "~~~"].join("\n"))).toEqual([]);
});
