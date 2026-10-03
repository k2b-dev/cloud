import { expect, test } from "bun:test";
import { notebookWorkspaceMessages } from "../../messages";
import { noteActionItems, type useNoteActions } from "./NoteTree";
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
const actions = {
  handleCreateNote: async () => undefined,
  handleMove: async () => undefined,
  handleCopy: async () => undefined,
  handleDelete: async (target: NoteTreeNode) => {
    deleted.push(target.id);
  },
  handleLock: async (target: NoteTreeNode) => {
    locked.push(target.id);
  },
  loading: () => false,
} satisfies ReturnType<typeof useNoteActions>;

const actionItem = (icon: string, canDeleteOrLock: boolean, locale: string, target = node) => {
  const { t } = notebookWorkspaceMessages.resolve([locale]);
  return noteActionItems(target, actions, t, canDeleteOrLock)
    .flatMap((item) => ("items" in item ? item.items : [item]))
    .find((item) => item.icon === icon);
};
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
