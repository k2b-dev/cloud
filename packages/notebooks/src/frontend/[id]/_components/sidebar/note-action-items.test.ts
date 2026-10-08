import { expect, test } from "bun:test";
import { notebookWorkspaceMessages } from "../../messages";
import { type NoteOrderContext, type NotePlacement, noteActionItems, type useNoteActions } from "./NoteTree";
import type { NoteTreeNode } from "./types";

const node: NoteTreeNode = {
  id: "Note01",
  notebookId: "Book01",
  parentId: null,
  title: "Plan",
  position: 0,
  hasChildren: false,
  yjsSnapshotAt: null,
  contentMd: null,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lockedAt: null,
  children: [],
};

const deleted: string[] = [];
const locked: string[] = [];
const placed: [string, NotePlacement | null][] = [];
const sorted: (string | null)[] = [];
const actions = {
  handleCreateNote: async () => undefined,
  handleMove: async () => undefined,
  handlePlace: (noteId: string, placement: NotePlacement | null) => {
    placed.push([noteId, placement]);
  },
  handleSortAlphabetically: (parentId: string | null) => {
    sorted.push(parentId);
  },
  handleCopy: async () => undefined,
  handleDelete: async (target: NoteTreeNode) => {
    deleted.push(target.id);
  },
  handleLock: async (target: NoteTreeNode) => {
    locked.push(target.id);
  },
  loading: () => false,
} satisfies ReturnType<typeof useNoteActions>;

const menu = (target: NoteTreeNode, canDeleteOrLock: boolean, locale: string, order?: NoteOrderContext) => {
  const { t } = notebookWorkspaceMessages.resolve([locale]);
  return noteActionItems(target, actions, t, canDeleteOrLock, order).flatMap((item) => ("items" in item ? item.items : [item]));
};
const actionItem = (icon: string, canDeleteOrLock: boolean, locale: string, target = node) =>
  menu(target, canDeleteOrLock, locale).find((item) => item.icon === icon);
const deleteItem = (canDelete: boolean, locale: string) => actionItem("ti ti-trash", canDelete, locale);
const lockItem = (canLock: boolean, locale: string) => actionItem("ti ti-lock", canLock, locale);

test("a notebook that reserves deleting for admins keeps the delete action visible but disabled, with the reason", () => {
  expect(deleteItem(false, "en")).toMatchObject({
    disabled: true,
    description: "Deleting is reserved for admins in this notebook.",
  });
  expect(deleteItem(false, "de")?.description).toBe("Löschen ist in diesem Notizbuch Admins vorbehalten.");
  expect(deleteItem(false, "en")?.action).toBeUndefined();
});

test("people who may delete keep the delete action", () => {
  const item = deleteItem(true, "en");
  expect(item).toMatchObject({ variant: "danger" });
  expect(item?.disabled).toBeUndefined();
  item?.action?.();
  expect(deleted).toEqual(["Note01"]);
});

test("a notebook that reserves deleting for admins also keeps the lock action visible but disabled, with the reason", () => {
  expect(lockItem(false, "en")).toMatchObject({
    disabled: true,
    description: "Locking is reserved for admins in this notebook.",
  });
  expect(lockItem(false, "de")?.description).toBe("Sperren ist in diesem Notizbuch Admins vorbehalten.");
  expect(lockItem(false, "en")?.action).toBeUndefined();
});

test("people who may lock keep the lock action; a locked note offers none", () => {
  const item = lockItem(true, "en");
  expect(item).toMatchObject({ variant: "danger" });
  expect(item?.disabled).toBeUndefined();
  item?.action?.();
  expect(locked).toEqual(["Note01"]);
  expect(actionItem("ti ti-lock", false, "en", { ...node, lockedAt: "2026-01-02T00:00:00.000Z" })).toBeUndefined();
});

const sibling = (id: string, position = 0, children: NoteTreeNode[] = []): NoteTreeNode => ({
  ...node,
  id,
  title: id,
  position,
  children,
  hasChildren: children.length > 0,
});

test("move up and down name the new neighbour and stop at the ends and below the homepage", () => {
  const level = [sibling("Home01"), sibling("Alpha1"), sibling("Bravo1"), sibling("Charl1")];
  const order = { level, homepageId: "Home01" };
  const item = (target: string, label: string) =>
    menu(level.find((note) => note.id === target)!, true, "en", order).find((entry) => entry.label === label);

  expect(item("Alpha1", "Move up")?.disabled).toBe(true);
  expect(item("Home01", "Move up")?.disabled).toBe(true);
  expect(item("Home01", "Move down")?.disabled).toBe(true);
  expect(item("Charl1", "Move down")?.disabled).toBe(true);
  item("Charl1", "Move up")?.action?.();
  item("Alpha1", "Move down")?.action?.();
  item("Bravo1", "Move down")?.action?.();
  expect(placed).toEqual([
    ["Charl1", { before: "Bravo1" }],
    ["Alpha1", { before: "Charl1" }],
    ["Bravo1", { after: "Charl1" }],
  ]);
  expect(menu(level[1]!, true, "de", order).map((entry) => entry.label)).toContain("Nach oben verschieben");
  // Without the notebook order on screen, nothing offers to change it.
  expect(menu(level[1]!, true, "en").some((entry) => entry.label === "Move up")).toBe(false);
});

test("a level arranged by hand offers the way back to the title order", () => {
  const folder = sibling("Folder", 1, [
    { ...sibling("Child1", 2), parentId: "Folder" },
    { ...sibling("Child2", 1), parentId: "Folder" },
  ]);
  const level = [folder, sibling("Other1", 2)];
  const labels = (target: NoteTreeNode, context: NoteOrderContext) => menu(target, true, "en", context).map((entry) => entry.label);

  expect(labels(folder, { level, homepageId: null })).toEqual(
    expect.arrayContaining(["Sort subnotes alphabetically", "Sort top level alphabetically"]),
  );
  expect(labels(folder.children[0]!, { level: folder.children, homepageId: null })).not.toContain("Sort top level alphabetically");
  const alphabetical = [sibling("Plain1", 0, [sibling("Child3")]), sibling("Plain2")];
  expect(labels(alphabetical[0]!, { level: alphabetical, homepageId: null }).filter((label) => label.startsWith("Sort"))).toEqual([]);

  menu(folder, true, "en", { level, homepageId: null })
    .filter((entry) => entry.label.startsWith("Sort"))
    .forEach((entry) => entry.action?.());
  expect(sorted).toEqual(["Folder", null]);
});
