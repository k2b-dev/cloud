import { describe, expect, test } from "bun:test";
import {
  ResourceShortIdSchema,
  toPublicAttachment,
  toPublicNote,
  toPublicNoteComment,
  toPublicNotebook,
  toPublicSnapshotLog,
} from "./public-resources";

const createdAt = "2026-08-11T08:00:00.000Z";

describe("notebooks public resource projection", () => {
  test("accepts public short IDs and rejects UUIDs", () => {
    expect(ResourceShortIdSchema.safeParse("abc123").success).toBeTrue();
    expect(ResourceShortIdSchema.safeParse("11111111-1111-4111-8111-111111111111").success).toBeFalse();
  });

  test("uses short IDs for notebooks, notes, comments, parents, and attachments", () => {
    const notebook = toPublicNotebook({
      id: "11111111-1111-4111-8111-111111111111",
      shortId: "abc123",
      name: "Knowledge",
      description: null,
      icon: null,
      homepageNoteId: "22222222-2222-4222-8222-222222222222",
      homepageNoteShortId: "def456",
      scriptsEnabled: false,
      defaultPresentationMode: "book",
      defaultNoteTitleTemplate: "Untitled",
      createdBy: null,
      createdAt,
      updatedAt: createdAt,
    });
    expect(notebook).toMatchObject({ id: "abc123", homepageNoteId: "def456", defaultPresentationMode: "book" });
    expect(notebook).not.toHaveProperty("shortId");

    const note = toPublicNote(
      {
        id: "22222222-2222-4222-8222-222222222222",
        shortId: "def456",
        notebookId: "11111111-1111-4111-8111-111111111111",
        parentId: "33333333-3333-4333-8333-333333333333",
        title: "Note",
        position: 0,
        hasChildren: false,
        yjsSnapshotAt: null,
        contentMd: null,
        createdBy: null,
        createdAt,
        updatedAt: createdAt,
        lockedAt: null,
      },
      "abc123",
      "ghi789",
    );
    expect(note).toMatchObject({ id: "def456", notebookId: "abc123", parentId: "ghi789" });
    expect(note).not.toHaveProperty("shortId");

    const attachment = toPublicAttachment(
      {
        id: "44444444-4444-4444-8444-444444444444",
        shortId: "jkl012",
        notebookId: "11111111-1111-4111-8111-111111111111",
        filename: "file.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        kind: "file",
        createdBy: null,
        createdAt,
      },
      "abc123",
    );
    expect(attachment).toMatchObject({ id: "jkl012", notebookId: "abc123" });
    expect(attachment).not.toHaveProperty("shortId");

    const comment = toPublicNoteComment(
      {
        id: "55555555-5555-4555-8555-555555555555",
        shortId: "mno345",
        noteId: "22222222-2222-4222-8222-222222222222",
        authorUserId: "66666666-6666-4666-8666-666666666666",
        authorDisplayName: "Ada Example",
        authorAvatarHash: null,
        content: "Useful context",
        createdAt,
        updatedAt: createdAt,
        canEdit: true,
        canDelete: true,
      },
      "abc123",
      "def456",
    );
    expect(comment).toMatchObject({ id: "mno345", notebookId: "abc123", noteId: "def456" });
    expect(comment).not.toHaveProperty("shortId");
  });

  test("keeps internal notebook UUIDs out of public snapshot logs", () => {
    const entry = toPublicSnapshotLog(
      {
        metadata: {
          notebookId: "11111111-1111-4111-8111-111111111111",
          notebookShortId: "abc123",
          trigger: "manual",
        },
      },
      "abc123",
    );

    expect(entry.metadata).toEqual({ notebookId: "abc123", trigger: "manual" });
  });
});
