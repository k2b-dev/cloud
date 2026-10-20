import { expect, test } from "bun:test";
import { minimalTextDiff } from "./text-diff";

test.each([
  ["", "", { index: 0, deleteCount: 0, insert: "" }],
  ["same 😀", "same 😀", { index: 7, deleteCount: 0, insert: "" }],
  ["abc", "axc", { index: 1, deleteCount: 1, insert: "x" }],
  ["abc", "abxc", { index: 2, deleteCount: 0, insert: "x" }],
  ["abxc", "abc", { index: 2, deleteCount: 1, insert: "" }],
  ["", "😀", { index: 0, deleteCount: 0, insert: "😀" }],
  ["😀", "", { index: 0, deleteCount: 2, insert: "" }],
  ["a😀z", "a😁z", { index: 1, deleteCount: 2, insert: "😁" }],
  ["a😀z", "a🨀z", { index: 1, deleteCount: 2, insert: "🨀" }],
  ["😀😀", "😀", { index: 2, deleteCount: 2, insert: "" }],
  ["a😀z", "a😀xz", { index: 3, deleteCount: 0, insert: "x" }],
] as const)("minimal replacement from %j to %j", (before, after, expected) => {
  const diff = minimalTextDiff(before, after);
  expect(diff).toEqual(expected);
  expect(before.slice(0, diff.index) + diff.insert + before.slice(diff.index + diff.deleteCount)).toBe(after);
});
