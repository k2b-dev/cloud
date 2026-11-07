import { expect, test } from "bun:test";
import { deriveMeta } from "./derive";
import type { NoteRecord } from "./model";
import { search } from "./search";

const text = "# Reise\n#reise\n## Reiseplanung\n" + "Vorher ".repeat(20) + "REISE finden und weiter";
const record: NoteRecord = {
  id: "A".repeat(22),
  meta: deriveMeta(text),
  createdAt: 1000,
  updatedAt: 1000,
  openedAt: 1000,
  pendingDelete: false,
  share: null,
};
test("groups, fuzzy ranges, tag counts and result limits", () => {
  const notes = Array.from({ length: 8 }, (_, index) => ({ record: { ...record, id: String(index).repeat(22) }, text }));
  const result = search("reis", notes);
  expect(result.notes).toHaveLength(4);
  expect(result.notes[0]?.ranges).toEqual([[0, 4]]);
  expect(result.headings).toHaveLength(4);
  expect(result.tags).toEqual([{ tag: "reise", count: 8, ranges: [[0, 4]] }]);
  expect(result.text).toHaveLength(4);
  expect(search("  ", notes)).toEqual({ notes: [], text: [], headings: [], tags: [] });
});
test("word search truncates around a case insensitive match and retains highlight offsets", () => {
  const result = search("finden", [{ record, text }]);
  const hit = result.text[0];
  expect(hit).toBeDefined();
  const range = hit?.ranges[0];
  expect(hit?.line.slice(range?.[0], range?.[1])).toBe("finden");
  expect(hit?.line.length).toBeLessThanOrEqual(92);
  expect(hit?.line.startsWith("…")).toBe(true);
});
test("diffuse tag and heading matches are excluded", () => {
  const diffuse = { ...record, meta: { ...record.meta, tags: ["a123456789z"], headings: ["a123456789z"] } };
  expect(search("az", [{ record: diffuse, text: "" }]).tags).toEqual([]);
  expect(search("az", [{ record: diffuse, text: "" }]).headings).toEqual([]);
});

test("Unicode case folding preserves offsets and query punctuation stays literal", () => {
  const text = "# Title\nİstanbul [x]";
  const hit = search("stanbul", [{ record, text }]).text[0];
  expect(hit?.ranges).toEqual([[1, 8]]);
  expect(hit?.line.slice(1, 8)).toBe("stanbul");
  expect(search(".", [{ record, text }]).text).toEqual([]);
});
