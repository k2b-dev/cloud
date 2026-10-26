import { expect, test } from "bun:test";
import { minimalTextDiff, textDiffHunks } from "./text-diff";

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

const applyHunks = (before: string, after: string, budget = 128 * 1024) => {
  const hunks = textDiffHunks(before, after, budget);
  let result = before;
  const splitsPair = (text: string, index: number) =>
    /[\uD800-\uDBFF]/.test(text[index - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[index] ?? "");
  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = hunks[i]!;
    expect(splitsPair(before, hunk.index)).toBe(false);
    expect(splitsPair(before, hunk.index + hunk.deleteCount)).toBe(false);
    expect(hunk.index + hunk.deleteCount).toBeLessThanOrEqual(i + 1 < hunks.length ? hunks[i + 1]!.index : before.length);
    result = result.slice(0, hunk.index) + hunk.insert + result.slice(hunk.index + hunk.deleteCount);
  }
  expect(result).toBe(after);
  return hunks;
};

test("distant edits keep unchanged lines and same-line passages outside the hunks", () => {
  const before = "first old paragraph\r\n\r\nunchanged 😀 middle\r\n\r\nthird old paragraph\r\n";
  const after = before.replaceAll("old", "NEW WORDS");
  expect(applyHunks(before, after)).toEqual([
    { index: before.indexOf("old"), deleteCount: 3, insert: "NEW WORDS" },
    { index: before.lastIndexOf("old"), deleteCount: 3, insert: "NEW WORDS" },
  ]);
  expect(applyHunks("a😀 long unchanged passage 😁z", "b😀 long unchanged passage 😁y")).toHaveLength(2);
});

test("an expensive changed block falls back without touching lines matched in the first pass", () => {
  const before = `${"a".repeat(80)}\nkeep\nold\n`;
  const after = `${"b".repeat(80)}\nkeep\nnew\n`;
  const hunks = applyHunks(before, after, 512);
  expect(hunks).toEqual([
    { index: 0, deleteCount: 80, insert: "b".repeat(80) },
    { index: before.indexOf("old"), deleteCount: 3, insert: "new" },
  ]);
});

test("budget exhaustion still produces exact text at Unicode boundaries", () => {
  for (const budget of [0, 1, 16]) applyHunks("first 😀 old\r\nstable\r\nlast 😁 old", "first 😁 new\r\nstable\r\nlast 😀 new", budget);
});

test("seeded random edits round-trip exactly, including emoji, CRLF, empty and replaced documents", () => {
  let seed = 0x51a;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const tokens = ["a", "b", " ", "\n", "\r\n", "😀", "😁", "🨀", "é", "中"];
  const text = () => Array.from({ length: random(80) }, () => tokens[random(tokens.length)]!).join("");
  for (let run = 0; run < 500; run++) {
    const before = text();
    const edited = Array.from(before);
    for (let edit = 0; edit < 5; edit++) edited.splice(random(edited.length + 1), random(8), ...Array.from(text()));
    const after = run % 5 === 0 ? "" : run % 5 === 1 ? text() : edited.join("");
    applyHunks(before, after, [0, 64, 128 * 1024][run % 3]);
  }
  applyHunks("", "😀\r\n");
  expect(applyHunks("same 😀", "same 😀")).toEqual([]);
});

test("a large note with two distant edits keeps the unchanged text between them", () => {
  const paragraph = (index: number) => `Paragraph ${index}: ${"steady words ".repeat(20)}\n\n`;
  const before = Array.from({ length: 2_000 }, (_, index) => paragraph(index)).join("");
  expect(before.length).toBeGreaterThan(128 * 1024);
  const after = before.replace("Paragraph 3:", "Paragraph three:").replace("Paragraph 1996:", "Paragraph last:");
  expect(applyHunks(before, after)).toHaveLength(2);
});
