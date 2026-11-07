import type { ListItemKind } from "./list-structure";

export type ItemTuple = [
  line: number,
  depth: number,
  orderedDepth: number,
  kind: ListItemKind,
  ordinal: number | null,
  label: string | null,
  parent: number,
  subtreeEnd: number,
  contentColumn: number,
];
type Case = { name: string; markdown: string; items: ItemTuple[] };

export const listStructureCases: Case[] = [
  ...[2, 3, 4].map(
    (spaces): Case => ({
      name: `${spaces}-space bullets`,
      markdown: `- root\n${" ".repeat(spaces)}* child\n${" ".repeat(spaces * 2)}+ grandchild`,
      items: [
        [1, 0, 0, "bullet", null, null, -1, 3, 2],
        [2, 1, 0, "bullet", null, null, 0, 3, spaces + 2],
        [3, 2, 0, "bullet", null, null, 1, 3, spaces * 2 + 2],
      ],
    }),
  ),
  ...[2, 3, 4].map(
    (spaces): Case => ({
      name: `${spaces}-space tasks`,
      markdown: `- [ ] root\n${" ".repeat(spaces)}- [x] child\n${" ".repeat(spaces * 2)}- [X] grandchild`,
      items: [
        [1, 0, 0, "task", null, null, -1, 3, 6],
        [2, 1, 0, "task", null, null, 0, 3, spaces + 6],
        [3, 2, 0, "task", null, null, 1, 3, spaces * 2 + 6],
      ],
    }),
  ),
  {
    name: "two spaces do not nest ordered items",
    markdown: "1. root\n  1. next",
    items: [
      [1, 0, 0, "ordered", 1, "1.", -1, 1, 3],
      [2, 0, 0, "ordered", 2, "2.", -1, 2, 5],
    ],
  },
  ...[3, 4].map(
    (spaces): Case => ({
      name: `${spaces}-space ordered items`,
      markdown: `1. root\n${" ".repeat(spaces)}1. child\n${" ".repeat(spaces * 2)}1. grandchild`,
      items: [
        [1, 0, 0, "ordered", 1, "1.", -1, 3, 3],
        [2, 1, 1, "ordered", 1, "a.", 0, 3, spaces + 3],
        [3, 2, 2, "ordered", 1, "i.", 1, 3, spaces * 2 + 3],
      ],
    }),
  ),
  {
    name: "bullet under a wide ordered marker",
    markdown: "10. root\n    - child",
    items: [
      [1, 0, 0, "ordered", 10, "10.", -1, 2, 4],
      [2, 1, 1, "bullet", null, null, 0, 2, 6],
    ],
  },
  {
    name: "typed ones count up",
    markdown: "1. a\n1. b\n1. c",
    items: [
      [1, 0, 0, "ordered", 1, "1.", -1, 1, 3],
      [2, 0, 0, "ordered", 2, "2.", -1, 2, 3],
      [3, 0, 0, "ordered", 3, "3.", -1, 3, 3],
    ],
  },
  {
    name: "CommonMark start",
    markdown: "3. a\n7. b",
    items: [
      [1, 0, 0, "ordered", 3, "3.", -1, 1, 3],
      [2, 0, 0, "ordered", 4, "4.", -1, 2, 3],
    ],
  },
  {
    name: "four ordered levels",
    markdown: "1. root\n   1. alpha\n      1. roman\n         1. decimal\n      1. roman again\n   1. alpha again",
    items: [
      [1, 0, 0, "ordered", 1, "1.", -1, 6, 3],
      [2, 1, 1, "ordered", 1, "a.", 0, 5, 6],
      [3, 2, 2, "ordered", 1, "i.", 1, 4, 9],
      [4, 3, 3, "ordered", 1, "1.", 2, 4, 12],
      [5, 2, 2, "ordered", 2, "ii.", 1, 5, 9],
      [6, 1, 1, "ordered", 2, "b.", 0, 6, 6],
    ],
  },
  {
    name: "ordered ancestors through a bullet",
    markdown: "1. root\n   - bullet\n     1. alpha",
    items: [
      [1, 0, 0, "ordered", 1, "1.", -1, 3, 3],
      [2, 1, 1, "bullet", null, null, 0, 3, 5],
      [3, 2, 1, "ordered", 1, "a.", 1, 3, 8],
    ],
  },
  {
    name: "parenthesis and ordered tasks",
    markdown: "0) [ ] todo\n7) [X] done\n3) normal",
    items: [
      [1, 0, 0, "task", 0, "0.", -1, 1, 7],
      [2, 0, 0, "task", 1, "1.", -1, 2, 7],
      [3, 0, 0, "ordered", 2, "2.", -1, 3, 3],
    ],
  },
  { name: "extra marker spaces", markdown: "-   text", items: [[1, 0, 0, "bullet", null, null, -1, 1, 4]] },
  { name: "bare marker", markdown: "-", items: [[1, 0, 0, "bullet", null, null, -1, 1, 1]] },
  { name: "fenced code", markdown: "```md\n- a\n1. b\n```", items: [] },
  { name: "indented code", markdown: "    - code", items: [] },
  { name: "blockquote", markdown: "> - a\n>   1. b", items: [] },
  {
    name: "data with a following list",
    markdown: ":::data\nroles:\n  - ops\n:::\n\n- after",
    items: [[6, 0, 0, "bullet", null, null, -1, 1, 2]],
  },
  ...["query", "toc", "chart"].map(
    (directive): Case => ({
      name: `${directive} directive`,
      markdown: `:::${directive}\n  - hidden\n:::\n\n- after`,
      items: [[5, 0, 0, "bullet", null, null, -1, 1, 2]],
    }),
  ),
  {
    name: "same-line nested item and its subtree",
    markdown: "- - x\n    - hidden\n- after",
    items: [
      [1, 0, 0, "bullet", null, null, -1, 1, 2],
      [3, 0, 0, "bullet", null, null, -1, 2, 2],
    ],
  },
  {
    name: "loose list",
    markdown: "- a\n\n- b",
    items: [
      [1, 0, 0, "bullet", null, null, -1, 1, 2],
      [3, 0, 0, "bullet", null, null, -1, 2, 2],
    ],
  },
];
