import { describe, expect, test } from "bun:test";
import { levelWindow, sortLevel, type TreeEntry } from "./tree-levels";

const entry = (shortId: string, title: string, extra: Partial<TreeEntry> = {}): TreeEntry => ({
  id: `id-${shortId}`,
  shortId,
  parentId: null,
  title,
  position: 0,
  hasChildren: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lockedAt: null,
  ...extra,
});

describe("one level of the sidebar tree", () => {
  const level = [
    entry("Zeta01", "Zeta", { updatedAt: "2026-03-01T00:00:00.000Z", createdAt: "2026-01-03T00:00:00.000Z" }),
    entry("Proj01", "Projects", { createdAt: "2026-01-02T00:00:00.000Z" }),
    entry("Home01", "Overview"),
    entry("Alpha1", "Alpha", { updatedAt: "2026-02-01T00:00:00.000Z" }),
    entry("Chap10", "Chapter 10"),
    entry("Chap02", "Chapter 2"),
  ];

  test("reads in the notebook order: titles in the reader's language with numbers as numbers", () => {
    expect(sortLevel(level, "title", "en", null).map((note) => note.shortId)).toEqual([
      "Alpha1",
      "Chap02",
      "Chap10",
      "Home01",
      "Proj01",
      "Zeta01",
    ]);
  });

  test("the homepage leads its own level whatever the order", () => {
    for (const sort of ["title", "updated", "created"] as const)
      expect(sortLevel(level, sort, "en", "id-Home01")[0]?.shortId).toBe("Home01");
  });

  test("a hand order wins over titles, and date orders show the newest first", () => {
    const hand = level.map((note, index) => ({ ...note, position: level.length - index }));
    expect(sortLevel(hand, "title", "en", null).map((note) => note.shortId)).toEqual([
      "Chap02",
      "Chap10",
      "Alpha1",
      "Home01",
      "Proj01",
      "Zeta01",
    ]);
    expect(
      sortLevel(level, "updated", "en", null)
        .slice(0, 2)
        .map((note) => note.shortId),
    ).toEqual(["Zeta01", "Alpha1"]);
    expect(
      sortLevel(level, "created", "en", null)
        .slice(0, 2)
        .map((note) => note.shortId),
    ).toEqual(["Zeta01", "Proj01"]);
  });

  test("a window starts at its offset or at the page that holds a note, and never exceeds its cap", () => {
    const many = Array.from({ length: 5000 }, (_, index) => entry(`N${String(index).padStart(5, "0")}`, `Note ${index}`));
    expect(levelWindow(null, many, {})).toMatchObject({ total: 5000, offset: 0 });
    expect(levelWindow(null, many, {}).items).toHaveLength(100);
    const around = levelWindow("parent", many, { around: "id-N04321" });
    expect(around).toMatchObject({ parentId: "parent", offset: 4300 });
    expect(around.items.some((note) => note.shortId === "N04321")).toBe(true);
    // A smaller window holds the note in a page of its own size.
    expect(levelWindow("parent", many, { around: "id-N04321", limit: 20 })).toMatchObject({ offset: 4320 });
    expect(levelWindow("parent", many, { around: "id-N04321", limit: 20 }).items).toHaveLength(20);
    expect(levelWindow(null, many, { offset: 4950, limit: 100 }).items).toHaveLength(50);
    expect(levelWindow(null, many, { offset: 0, limit: 100_000 }).items).toHaveLength(1000);
  });
});
