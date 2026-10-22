import { describe, expect, spyOn, test } from "bun:test";
import { notebooksService } from "./index";
import { loadEditableNoteRouteData } from "./route-state";

const base = {
  notebookId: "11111111-1111-4111-8111-111111111111",
  notebookShortId: "book01",
  origin: "https://cloud.example.test",
  canWrite: true,
  defaultPresentationMode: "write" as const,
  userId: "22222222-2222-4222-8222-222222222222",
  bypassAccess: false,
};

describe("notebook route state public IDs", () => {
  test("does not serve editable state for Book defaults, explicit read views, or read grants", async () => {
    const href = "/app/notebooks/book01/notes/note01";
    for (const args of [
      { ...base, href, defaultPresentationMode: "book" as const },
      { ...base, href, defaultPresentationMode: "readonly" as const },
      { ...base, href: `${href}?mode=book` },
      { ...base, href: `${href}?mode=readonly` },
      { ...base, href: `${href}?mode=write`, canWrite: false },
    ])
      expect(await loadEditableNoteRouteData(args)).toEqual({ kind: "fallback", reason: "readonly" });
  });
  test("rejects legacy UUID note URLs before resolving data", async () => {
    const result = await loadEditableNoteRouteData({
      ...base,
      href: "/app/notebooks/book01/notes/33333333-3333-4333-8333-333333333333",
    });

    expect(result).toEqual({ kind: "fallback", reason: "invalid-target" });
  });

  test("rejects non-canonical notebook IDs", async () => {
    const result = await loadEditableNoteRouteData({
      ...base,
      href: "/app/notebooks/11111111-1111-4111-8111-111111111111/notes/note01",
    });

    expect(result).toEqual({ kind: "fallback", reason: "invalid-target" });
  });
});

test("the authorized route snapshot carries authors into soft-navigation detail", async () => {
  const timestamp = "2026-10-01T10:00:00.000Z";
  const author = { kind: "user" as const, id: base.userId, displayName: "Jana Berger", avatarHash: "avatar" };
  const authors = { createdBy: author, lastEditedBy: author };
  const noteId = "33333333-3333-4333-8333-333333333333";
  const note = spyOn(notebooksService.note, "getWithContentByShortId").mockResolvedValue({
    id: noteId,
    shortId: "note01",
    notebookId: base.notebookId,
    title: "Test",
    contentMd: "# Test",
    yjsSnapshot: null,
    yjsRestoreRevision: "0",
    historyIncomplete: false,
    lockedAt: null,
    parentId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: base.userId,
    position: 0,
    hasChildren: false,
    yjsSnapshotAt: null,
  });
  const backlinks = spyOn(notebooksService.note.backlinks, "list").mockResolvedValue([]);
  const authorsRead = spyOn(notebooksService.activity, "noteAuthors").mockResolvedValue(authors);
  try {
    const result = await loadEditableNoteRouteData({ ...base, href: "/app/notebooks/book01/notes/note01" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected editable route state");
    expect(result.state.detail.noteAuthors).toEqual(authors);
    expect(authorsRead).toHaveBeenCalledWith({ noteId });
  } finally {
    note.mockRestore();
    backlinks.mockRestore();
    authorsRead.mockRestore();
  }
});
