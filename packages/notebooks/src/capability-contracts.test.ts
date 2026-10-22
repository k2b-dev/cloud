import { expect, test } from "bun:test";
import {
  CommentDataSchema,
  NotebookDataSchema,
  NotebookListInputSchema,
  NoteChildrenInputSchema,
  NoteDetailDataSchema,
  NoteEditInputSchema,
  NoteMoveInputSchema,
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

test("move supports an optional parent and mutually exclusive placements", () => {
  for (const placement of [{}, { position: 0 }, { position: 99 }, { before: "abc123" }, { after: "abc123" }]) {
    expect(NoteMoveInputSchema.safeParse({ noteId: "def456", ...placement }).success).toBeTrue();
    expect(NoteMoveInputSchema.safeParse({ noteId: "def456", parentId: null, ...placement }).success).toBeTrue();
  }
  for (const placement of [
    { position: -1 },
    { position: 0.5 },
    { position: "first" },
    { position: "last" },
    { before: "abc123", after: "ghi789" },
    { position: 0, before: "abc123" },
    { position: 99, after: "abc123" },
  ]) {
    expect(NoteMoveInputSchema.safeParse({ noteId: "def456", ...placement }).success).toBeFalse();
  }
  const ambiguous = NoteMoveInputSchema.safeParse({ noteId: "def456", before: "abc123", after: "ghi789" });
  if (!ambiguous.success) expect(ambiguous.error.issues[0]?.message).toContain("at most one placement");
});

test("only append accepts the explicit exact separator and existing bounds still apply", () => {
  const operation = { kind: "append", content: "fragment", separator: "none" };
  expect(NoteEditInputSchema.parse({ noteId: "abc123", operations: [operation] }).operations).toEqual([operation]);
  for (const kind of ["prepend", "set-content", "append-block"]) {
    expect(NoteEditInputSchema.safeParse({ noteId: "abc123", operations: [{ ...operation, kind, name: "block" }] }).success).toBeFalse();
  }
  expect(NoteEditInputSchema.safeParse({ noteId: "abc123", operations: [{ ...operation, separator: "paragraph" }] }).success).toBeFalse();
  expect(NoteEditInputSchema.safeParse({ noteId: "abc123", operations: Array(21).fill(operation) }).success).toBeFalse();
  expect(
    NoteEditInputSchema.safeParse({ noteId: "abc123", operations: [{ ...operation, content: "x".repeat(10_001) }] }).success,
  ).toBeFalse();
});
