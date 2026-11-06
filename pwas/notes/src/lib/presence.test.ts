import { expect, test } from "bun:test";
import type { NoteRecord } from "./model";
import { presenceBatches } from "./presence";

const record = (index: number, shared: boolean): NoteRecord => ({
  id: `note${index}`,
  createdAt: 0,
  updatedAt: index,
  openedAt: 0,
  pendingDelete: false,
  share: shared ? { kind: "own", readId: `read${index}`, editId: `edit${index}`, sharedAt: 0 } : null,
  meta: { title: "", tags: [], headings: [], excerpt: "", tasks: [], chart: null, image: null, length: 0 },
});

test("presence asks for shared notes only, newest first, in batches of 200 up to 1000", () => {
  const records = Array.from({ length: 1300 }, (_, index) => record(index, index !== 1299));
  const batches = presenceBatches(records);
  expect(batches.map((batch) => batch.length)).toEqual([200, 200, 200, 200, 200]);
  expect(batches[0]?.[0]).toEqual({ id: "note1298", readId: "read1298" });
  expect(batches.flat().some((entry) => entry.id === "note1299")).toBe(false);
  expect(presenceBatches([record(1, false)])).toEqual([]);
});
