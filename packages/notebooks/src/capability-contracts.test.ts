import { expect, test } from "bun:test";
import {
  CommentDataSchema,
  NotebookDataSchema,
  NotebookListInputSchema,
  NoteChildrenInputSchema,
  NoteDetailDataSchema,
  NoteEditInputSchema,
  NoteTreeInputSchema,
} from "./capability-contracts";

test("existing reader fields and accepted tree requests survive compact additions", () => {
  expect(Object.keys(NotebookDataSchema.shape)).toEqual([
    "id",
    "name",
    "description",
    "icon",
    "homepageNoteId",
    "permission",
    "createdAt",
    "updatedAt",
    "links",
  ]);
  for (const key of ["id", "notebookId", "noteId", "authorUserId", "authorDisplayName", "content", "createdAt", "updatedAt"]) {
    expect(CommentDataSchema.shape).toHaveProperty(key);
  }
  for (const key of [
    "content",
    "contentOffset",
    "contentLength",
    "contentHash",
    "contentComplete",
    "nextContentOffset",
    "blocks",
    "blocksTruncated",
  ]) {
    expect(NoteDetailDataSchema.shape).toHaveProperty(key);
  }
  expect(NoteTreeInputSchema.parse({ notebookId: "abc123", limit: 2000 }).limit).toBe(2000);
  expect(NotebookListInputSchema.parse({}).minimumPermission).toBe("read");
});

test("compact paths keep local bounds without requiring new inputs on existing edits", () => {
  expect(NoteChildrenInputSchema.parse({ notebookId: "abc123" })).toEqual({ notebookId: "abc123", limit: 25 });
  expect(NoteChildrenInputSchema.safeParse({ notebookId: "abc123", parentId: "not-an-id" }).success).toBeFalse();
  const edit = { noteId: "def456", operations: [{ kind: "append", content: "Useful text" }] };
  expect(NoteEditInputSchema.safeParse(edit).success).toBeTrue();
  expect(NoteEditInputSchema.parse({ ...edit, blockLimit: 0 }).blockLimit).toBe(0);
  expect(NoteEditInputSchema.safeParse({ ...edit, blockLimit: 501 }).success).toBeFalse();
});
