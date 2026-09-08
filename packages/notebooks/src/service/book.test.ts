import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { renderNotebookBook } from "../lib/book-renderer";
import { loadBookBlockPreview, loadBookNote } from "./book";
import * as query from "./note-query";
import * as notebooks from "./notebooks";
import * as notes from "./notes";

const params = {
  notebookId: "11111111-1111-4111-8111-111111111111",
  notebookShortId: "book01",
  noteShortId: "note01",
  userId: "22222222-2222-4222-8222-222222222222",
  locale: "en",
};
const note = {
  id: "33333333-3333-4333-8333-333333333333",
  shortId: params.noteShortId,
  notebookId: params.notebookId,
  parentId: null,
  title: "Saved heading",
  position: 0,
  hasChildren: false,
  historyIncomplete: false,
  yjsSnapshotAt: "2026-09-03T10:00:00Z",
  contentMd: "# Saved heading\n\n:::toc\n:::\n\n## Next page",
  yjsSnapshot: "private-collaboration-state",
  createdBy: params.userId,
  createdAt: "2026-09-03T10:00:00Z",
  updatedAt: "2026-09-03T10:00:00Z",
  lockedAt: null,
} satisfies notes.NoteWithContent;
const active: Array<{ mockRestore(): void }> = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
  active.push(spy);
  return spy;
};
afterEach(() => {
  for (const spy of active.splice(0)) spy.mockRestore();
});

function fixture(allowed = true, currentNote: notes.NoteWithContent | null = note) {
  const access = track(spyOn(notebooks, "canAccess")).mockResolvedValue(allowed);
  const content = track(spyOn(notes, "getWithContentByShortId")).mockResolvedValue(currentNote);
  const queries = track(spyOn(query, "resolveNoteQuery")).mockResolvedValue({
    columns: ["$title"],
    items: [],
    total: 0,
    limit: 25,
    truncated: false,
    diagnostics: [],
  });
  const unexpectedWrite = async (): Promise<never> => {
    throw new Error("Book rendering must not persist a draft");
  };
  const save = track(spyOn(notes, "save")).mockImplementation(unexpectedWrite);
  const edit = track(spyOn(notes, "editContent")).mockImplementation(unexpectedWrite);
  const update = track(spyOn(notes, "update")).mockImplementation(unexpectedWrite);
  return { access, content, queries, save, edit, update };
}

describe("authorized Book documents and server block previews", () => {
  test("trusted platform admins retain Book and preview access without a notebook ACL", async () => {
    const calls = fixture(false, { ...note, contentMd: ":::query\nsource: notes\n:::" });
    expect(await loadBookNote({ ...params, bypassAccess: true })).not.toBeNull();
    expect((await loadBookBlockPreview({ ...params, bypassAccess: true, markdown: ":::query\nsource: notes\n:::" })).kind).toBe("ok");
    expect(calls.access).not.toHaveBeenCalled();
    expect(calls.queries.mock.calls.every(([args]) => args.bypassAccess === true)).toBe(true);
  });

  test("platform admins still cannot preview a draft of a locked note", async () => {
    fixture(false, { ...note, lockedAt: note.updatedAt });
    expect(await loadBookBlockPreview({ ...params, bypassAccess: true, markdown: "Draft" })).toEqual({ kind: "denied" });
  });

  test("platform admins still cannot address a note through another notebook", async () => {
    fixture(false, { ...note, notebookId: "44444444-4444-4444-8444-444444444444" });
    expect(await loadBookNote({ ...params, bypassAccess: true })).toBeNull();
    expect(await loadBookBlockPreview({ ...params, bypassAccess: true, markdown: "Draft" })).toEqual({ kind: "not_found" });
  });

  test("denied reads and drafts do not load content or resolve queries", async () => {
    const calls = fixture(false);
    expect(await loadBookNote(params)).toBeNull();
    expect(await loadBookBlockPreview(params)).toEqual({ kind: "denied" });
    expect(await loadBookBlockPreview({ ...params, markdown: ":::query\nsource: notes\n:::" })).toEqual({ kind: "denied" });
    expect(calls.content).not.toHaveBeenCalled();
    expect(calls.queries).not.toHaveBeenCalled();
    expect(calls.access.mock.calls.map(([args]) => args.requiredLevel)).toEqual(["read", "read", "write"]);
  });

  test("another notebook's note is not rendered or queried", async () => {
    const calls = fixture(true, { ...note, notebookId: "44444444-4444-4444-8444-444444444444" });
    expect(await loadBookNote(params)).toBeNull();
    expect(await loadBookBlockPreview(params)).toEqual({ kind: "not_found" });
    expect(await loadBookBlockPreview({ ...params, markdown: ":::query\nsource: notes\n:::" })).toEqual({ kind: "not_found" });
    expect(calls.queries).not.toHaveBeenCalled();
  });

  test("missing notes are a not-found result", async () => {
    fixture(true, null);
    expect(await loadBookNote(params)).toBeNull();
    expect(await loadBookBlockPreview(params)).toEqual({ kind: "not_found" });
  });

  test("saved previews require only read access and use the canonical renderer", async () => {
    const calls = fixture(true, { ...note, lockedAt: note.updatedAt });
    const result = await loadBookBlockPreview(params);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.kind);
    const canonical = renderNotebookBook({
      markdown: note.contentMd,
      notebookId: params.notebookShortId,
      locale: "en",
      linkMode: "readonly",
    });
    expect(result.preview.markdown).toBe(note.contentMd);
    expect(result.preview.blocks).toEqual(canonical.blocks);
    expect(result.preview.headings).toEqual([
      { id: "heading-saved-heading", line: 1 },
      { id: "heading-next-page", line: 6 },
    ]);
    expect(result.preview.diagnostics).toEqual([]);
    expect(calls.access).toHaveBeenCalledWith({ notebookId: params.notebookId, userId: params.userId, requiredLevel: "read" });
    expect(JSON.stringify(result)).not.toContain("yjsSnapshot");
  });

  test("draft previews require Write, normalize newlines, and never persist", async () => {
    const calls = fixture();
    const markdown = "# Draft\r\n\r\n:::toc\r\n:::\r\n\r\n## Changed";
    const result = await loadBookBlockPreview({ ...params, markdown });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.preview.markdown).toBe(markdown.replace(/\r\n/g, "\n"));
    expect(result.preview.headings.map(({ id }) => id)).toEqual(["heading-draft", "heading-changed"]);
    expect(result.preview.blocks).toEqual(
      renderNotebookBook({ markdown, notebookId: params.notebookShortId, locale: "en", linkMode: "write" }).blocks,
    );
    expect(calls.access).toHaveBeenCalledWith({ notebookId: params.notebookId, userId: params.userId, requiredLevel: "write" });
    for (const call of [calls.save, calls.edit, calls.update]) expect(call).not.toHaveBeenCalled();
    expect(note.contentMd).toContain("Saved heading");
  });

  test("an empty draft is a Write operation, not a fallback to saved content", async () => {
    const calls = fixture();
    const result = await loadBookBlockPreview({ ...params, markdown: "" });
    expect(result).toEqual({ kind: "ok", preview: { markdown: "", blocks: [], headings: [], diagnostics: [] } });
    expect(calls.access.mock.calls[0]?.[0].requiredLevel).toBe("write");
  });

  test("locked notes deny draft previews before resolving queries", async () => {
    const calls = fixture(true, { ...note, lockedAt: note.updatedAt });
    expect(await loadBookBlockPreview({ ...params, markdown: ":::query\nsource: notes\n:::" })).toEqual({ kind: "denied" });
    expect(calls.queries).not.toHaveBeenCalled();
  });

  test("queries use the current note context and localized canonical result HTML", async () => {
    const calls = fixture();
    const markdown = ":::query\nsource: notes\n:::";
    const result = await loadBookBlockPreview({ ...params, locale: "de", markdown });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(calls.queries).toHaveBeenCalledWith(
      expect.objectContaining({ notebookId: params.notebookId, noteId: note.id, userId: params.userId }),
    );
    expect(result.preview.blocks[0]?.html).toContain("Keine passenden Notizen");
    expect(result.preview.blocks[0]?.line).toBe(1);
  });

  test("invalid directives return localized diagnostics without running a query", async () => {
    const calls = fixture();
    const result = await loadBookBlockPreview({
      ...params,
      locale: "de",
      markdown: ":::query\nsource: secrets\n:::\n\n:::toc\nmax-depth: 9\n:::",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.preview.diagnostics.map(({ line }) => line)).toEqual([2, 6]);
    expect(result.preview.diagnostics.every(({ message }) => message.includes("Ungültiger Block"))).toBe(true);
    expect(calls.queries).not.toHaveBeenCalled();
  });

  test("query execution failures appear in diagnostics, not just rendered HTML", async () => {
    const calls = fixture();
    calls.queries.mockResolvedValue({
      columns: [],
      items: [],
      total: 0,
      limit: 25,
      truncated: false,
      diagnostics: [{ code: "unavailable" }],
    });
    const result = await loadBookBlockPreview({ ...params, locale: "de", markdown: ":::query\nsource: notes\n:::" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.preview.diagnostics).toEqual([{ line: 1, message: "Diese Abfrage ist nicht verfügbar." }]);
  });
});
