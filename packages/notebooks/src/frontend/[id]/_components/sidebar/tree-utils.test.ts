import { describe, expect, test } from "bun:test";
import { filterNotes, homepageFirst, type NoteTreeSort, RECENT_NOTE_LIMIT, sortNoteTree } from "./tree-utils";
import type { NoteTreeNode } from "./types";

const note = (
  id: string,
  title: string,
  createdAt: string,
  updatedAt: string,
  children: NoteTreeNode[] = [],
  position = 0,
): NoteTreeNode => ({
  id,
  notebookId: "Book01",
  parentId: null,
  title,
  position,
  hasChildren: children.length > 0,
  yjsSnapshotAt: null,
  contentMd: null,
  createdBy: null,
  createdAt,
  updatedAt,
  lockedAt: null,
  children,
});

const ids = (nodes: NoteTreeNode[]) => nodes.map((item) => item.id);

describe("sortNoteTree", () => {
  const source = [
    note("Bravo1", "Bravo", "2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", [
      note("Delta1", "Delta", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
      note("Alpha1", "Alpha", "2026-02-02T00:00:00.000Z", "2026-04-02T00:00:00.000Z"),
    ]),
    note("Alpha2", "Alpha", "2026-03-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"),
  ];

  test.each<[NoteTreeSort, string[], string[]]>([
    ["title", ["Alpha2", "Bravo1"], ["Alpha1", "Delta1"]],
    ["created", ["Alpha2", "Bravo1"], ["Alpha1", "Delta1"]],
    ["updated", ["Bravo1", "Alpha2"], ["Alpha1", "Delta1"]],
  ])("sorts %s recursively without flattening the hierarchy", (mode, roots, children) => {
    const sorted = sortNoteTree(source, mode, "en");

    expect(ids(sorted)).toEqual(roots);
    expect(ids(sorted.find((item) => item.id === "Bravo1")?.children ?? [])).toEqual(children);
    expect(ids(source)).toEqual(["Bravo1", "Alpha2"]);
    expect(ids(source[0]!.children)).toEqual(["Delta1", "Alpha1"]);
  });
});

describe("notebook order in the sidebar", () => {
  const day = "2026-01-01T00:00:00.000Z";
  test("a level arranged by hand keeps that order, the others read by title with numbers as numbers", () => {
    const source = [
      note("Chap10", "Chapter 10", day, day),
      note("Guide1", "Guides", day, day, [note("Setup1", "Setup", day, day, [], 1), note("Intro1", "Intro", day, day, [], 2)]),
      note("Chap02", "Chapter 2", day, day),
    ];
    const sorted = sortNoteTree(source, "title", "de");
    expect(ids(sorted)).toEqual(["Chap02", "Chap10", "Guide1"]);
    expect(ids(sorted[2]!.children)).toEqual(["Setup1", "Intro1"]);
  });
});

describe("homepageFirst", () => {
  const source = [
    note("Bravo1", "Bravo", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", [
      note("Delta1", "Delta", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      note("Home01", "Overview", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      note("Alpha1", "Alpha", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    ]),
    note("Charl1", "Charlie", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
  ];

  test("moves the homepage to the front of its own level and keeps the other notes in order", () => {
    const ordered = homepageFirst(source, "Home01");

    expect(ids(ordered)).toEqual(["Bravo1", "Charl1"]);
    expect(ids(ordered[0]!.children)).toEqual(["Home01", "Delta1", "Alpha1"]);
    expect(ids(source[0]!.children)).toEqual(["Delta1", "Home01", "Alpha1"]);
  });

  test("leads the top level when the homepage is a top-level note", () => {
    expect(ids(homepageFirst(source, "Charl1"))).toEqual(["Charl1", "Bravo1"]);
  });

  test("keeps the tree as it is without a homepage", () => {
    expect(homepageFirst(source, null)).toBe(source);
  });
});

describe("filterNotes", () => {
  const tagged = (node: NoteTreeNode, contentMd: string): NoteTreeNode => ({ ...node, contentMd });
  const tree = [
    tagged(note("Old001", "Old", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"), "#garden notes"),
    note("Branch", "Branch", "2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z", [
      tagged(note("Child1", "Child", "2026-01-01T00:00:00.000Z", "2026-01-05T00:00:00.000Z"), "Plant #Garden/roses soon"),
      tagged(note("Code01", "Code", "2026-01-01T00:00:00.000Z", "2026-01-04T00:00:00.000Z"), "`#garden` is only an example"),
    ]),
  ];

  test("lists the most recently changed notes first for the recent list, sub-notes included", () => {
    expect(ids(filterNotes(tree, { view: "recents" }, new Set()))).toEqual(["Child1", "Code01", "Branch", "Old001"]);
  });

  test("lists only favorites, newest first", () => {
    expect(ids(filterNotes(tree, { view: "favorites" }, new Set(["Old001", "Child1"])))).toEqual(["Child1", "Old001"]);
  });

  test("matches tags as the tag index does: case-insensitive, nested tags apart, and nothing inside code", () => {
    expect(ids(filterNotes(tree, { view: "tag", tag: "garden" }, new Set()))).toEqual(["Old001"]);
    expect(ids(filterNotes(tree, { view: "tag", tag: "garden/roses" }, new Set()))).toEqual(["Child1"]);
  });

  test("lists nothing without a filter, because the sidebar shows the tree", () => {
    expect(filterNotes(tree, {}, new Set(["Old001"]))).toEqual([]);
  });

  test("keeps the rows on screen in place: a changed note stays, a new match joins at the end, a lost one leaves", () => {
    const favorites = new Set(["Old001", "Child1", "Code01"]);
    const shown = ids(filterNotes(tree, { view: "favorites" }, favorites));
    expect(shown).toEqual(["Child1", "Code01", "Old001"]);
    // Someone saves Old001; Branch becomes a favorite; Code01 stops being one.
    const saved = [{ ...tree[0]!, updatedAt: "2026-02-01T00:00:00.000Z" }, tree[1]!];
    const next = new Set(["Old001", "Child1", "Branch"]);
    expect(ids(filterNotes(saved, { view: "favorites" }, next, shown))).toEqual(["Child1", "Old001", "Branch"]);
    // Without the list on screen, as when the filter opens again, the newest comes first.
    expect(ids(filterNotes(saved, { view: "favorites" }, next))).toEqual(["Old001", "Child1", "Branch"]);
  });

  test("Recent lists the twelve most recently changed notes and keeps them while it stays open", () => {
    const many = Array.from({ length: 14 }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      return note(`Note${day}`, `Note ${day}`, "2026-01-01T00:00:00.000Z", `2026-02-${day}T00:00:00.000Z`);
    });
    const shown = ids(filterNotes(many, { view: "recents" }, new Set()));
    expect(shown).toHaveLength(RECENT_NOTE_LIMIT);
    expect(shown.slice(0, 2)).toEqual(["Note14", "Note13"]);
    expect(shown.at(-1)).toBe("Note03");
    // Note01 changes now: the open list keeps its notes in their places.
    const changed = many.map((item) => (item.id === "Note01" ? { ...item, updatedAt: "2026-03-01T00:00:00.000Z" } : item));
    expect(ids(filterNotes(changed, { view: "recents" }, new Set(), shown))).toEqual(shown);
    expect(ids(filterNotes(changed, { view: "recents" }, new Set()))[0]).toBe("Note01");
  });
});
