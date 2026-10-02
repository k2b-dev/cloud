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
const actions = {
  handleCreateNote: async () => undefined,
  handleMove: async () => undefined,
  handleCopy: async () => undefined,
  handleDelete: async (target: NoteTreeNode) => {
    deleted.push(target.id);
  },
  handleLock: async () => undefined,
  loading: () => false,
} satisfies ReturnType<typeof useNoteActions>;

const deleteItem = (canDelete: boolean, locale: string) => {
  const { t } = notebookWorkspaceMessages.resolve([locale]);
  return noteActionItems(node, actions, t, canDelete)
    .flatMap((item) => ("items" in item ? item.items : [item]))
    .find((item) => item.icon === "ti ti-trash");
};

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
