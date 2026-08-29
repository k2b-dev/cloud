import { describe, expect, test } from "bun:test";
import { type NoteTreeSort, sortNoteTree } from "./tree-utils";
import type { NoteTreeNode } from "./types";

const note = (id: string, title: string, createdAt: string, updatedAt: string, children: NoteTreeNode[] = []): NoteTreeNode => ({
  id,
  notebookId: "Book01",
  parentId: null,
  title,
  position: 0,
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
    const sorted = sortNoteTree(source, mode);

    expect(ids(sorted)).toEqual(roots);
    expect(ids(sorted.find((item) => item.id === "Bravo1")?.children ?? [])).toEqual(children);
    expect(ids(source)).toEqual(["Bravo1", "Alpha2"]);
    expect(ids(source[0]!.children)).toEqual(["Delta1", "Alpha1"]);
  });
});
