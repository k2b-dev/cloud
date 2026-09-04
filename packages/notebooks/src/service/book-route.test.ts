import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as notebooks from "./notebooks";
import * as notes from "./notes";
import * as tags from "./tags";
import * as workspaceEvents from "./workspace-events";

await import("../frontend/[id]/_components/detail/ssr-test-plugin");
const { loadBookRoute } = await import("./book-route");

const params = {
  notebookId: "11111111-1111-4111-8111-111111111111",
  notebookShortId: "book01",
  userId: "22222222-2222-4222-8222-222222222222",
  locale: "en",
  origin: "https://cloud.example.test",
  href: "/app/notebooks/book01/notes/note01?mode=book",
};
const timestamp = "2026-09-03T10:00:00Z";
const notebook: notebooks.Notebook = {
  id: params.notebookId,
  shortId: params.notebookShortId,
  name: "Handbook",
  description: null,
  icon: null,
  homepageNoteId: null,
  homepageNoteShortId: null,
  defaultPresentationMode: "write",
  defaultNoteTitleTemplate: "Untitled",
  createdBy: params.userId,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const note: notes.NoteWithContent = {
  id: "33333333-3333-4333-8333-333333333333",
  shortId: "note01",
  notebookId: notebook.id,
  parentId: null,
  title: "Welcome",
  position: 0,
  hasChildren: false,
  yjsSnapshotAt: timestamp,
  contentMd: "# Welcome\n\nOur **handbook**.",
  yjsSnapshot: "private-collaboration-state",
  createdBy: params.userId,
  createdAt: timestamp,
  updatedAt: timestamp,
  lockedAt: null,
};
const active: Array<{ mockRestore(): void }> = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
  active.push(spy);
  return spy;
};
afterEach(() => {
  for (const spy of active.splice(0)) spy.mockRestore();
});
function fixture() {
  const permission = track(spyOn(notebooks, "getPermission")).mockResolvedValue("read");
  track(spyOn(notebooks, "canAccess")).mockResolvedValue(true);
  const cursor = track(spyOn(workspaceEvents, "latestCursor")).mockResolvedValue("100-0");
  const get = track(spyOn(notebooks, "get")).mockResolvedValue(notebook);
  const tree = track(spyOn(notes, "getTree")).mockResolvedValue([{ ...note, children: [] }]);
  const content = track(spyOn(notes, "getWithContentByShortId")).mockResolvedValue(note);
  const tagList = track(spyOn(tags, "listForNotebook")).mockResolvedValue([{ tag: "team", count: 101 }]);
  const tagNotes = track(spyOn(tags, "listNotesForTag")).mockResolvedValue({
    items: [{ id: note.id, shortId: note.shortId, title: note.title, preview: "Start here", updatedAt: timestamp }],
    total: 101,
  });
  const tagCount = track(spyOn(tags, "countNotesForTag")).mockResolvedValue(101);
  return { permission, cursor, get, tree, content, tagList, tagNotes, tagCount };
}

describe("authorized Book refresh routes", () => {
  test("trusted platform admins load Book pages without a direct notebook grant", async () => {
    const calls = fixture();
    calls.permission.mockResolvedValue("none");
    const result = await loadBookRoute({ ...params, bypassAccess: true });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.snapshot.canWrite).toBe(true);
    expect(result.snapshot.html).toContain("handbook");
    expect(calls.permission).not.toHaveBeenCalled();
  });

  test("denied requests read no notebook, note, tags, or cursor", async () => {
    const { permission, ...reads } = fixture();
    permission.mockResolvedValue("none");
    expect(await loadBookRoute(params)).toEqual({ kind: "denied" });
    for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled();
  });

  test("rejects external, cross-notebook, non-Book and malformed targets before reading a snapshot", async () => {
    const { permission: _permission, ...reads } = fixture();
    for (const href of [
      "https://evil.example/app/notebooks/book01/notes/note01",
      "https://name:password@cloud.example.test/app/notebooks/book01/notes/note01",
      "/app/notebooks/other1/notes/note01",
      "/app/notebooks/book010/notes/note01",
      "/app/notebooks/book01/notes/not-a-short-id",
      "/app/notebooks/book01/tags/%XX",
      "/app/notebooks/book01/notes/note01?mode=write",
      "/app/notebooks/book01/notes/note01?mode=graph",
      "/app/notebooks/book01/settings",
      "/app/notebooks/book01/tags/team/extra",
    ])
      expect(await loadBookRoute({ ...params, href })).toEqual({ kind: "invalid" });
    for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled();
  });

  test("malformed pagination falls back to the first page just like direct SSR", async () => {
    fixture();
    for (const page of ["abc", "-1", "9007199254740991"]) {
      const result = await loadBookRoute({ ...params, href: `/app/notebooks/book01/tags/team?page=${page}` });
      expect(result.kind).toBe("ok");
    }
  });

  test("returns rendered public-only note snapshots and captures the cursor before content", async () => {
    const calls = fixture();
    const order: string[] = [];
    calls.cursor.mockImplementation(async () => {
      order.push("cursor");
      return "100-0";
    });
    calls.get.mockImplementation(async () => {
      order.push("notebook");
      return notebook;
    });
    calls.content.mockImplementation(async () => {
      order.push("content");
      return note;
    });
    const result = await loadBookRoute({ ...params, href: "/app/notebooks/book01/notes/note01#heading-welcome" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(order).toEqual(["cursor", "notebook", "content"]);
    expect(result.snapshot).toMatchObject({
      href: "/app/notebooks/book01/notes/note01?mode=book#heading-welcome",
      selectedNoteId: "note01",
      canWrite: false,
      cursor: "100-0",
      locked: false,
    });
    expect(result.snapshot.html).toContain("<strong>handbook</strong>");
    expect(result.snapshot.tree).toEqual([{ id: "note01", title: "Welcome", children: [] }]);
    const encoded = JSON.stringify(result.snapshot);
    for (const secret of ["contentMd", "yjsSnapshot", "private-collaboration-state", note.id, notebook.id, params.userId])
      expect(encoded).not.toContain(secret);
  });

  test("a valid note URL cannot render a note from another notebook", async () => {
    const calls = fixture();
    calls.content.mockResolvedValue({ ...note, notebookId: "44444444-4444-4444-8444-444444444444" });
    expect(await loadBookRoute(params)).toEqual({ kind: "not_found" });
  });

  test("tag refreshes retain localized content, search, pagination and Book links", async () => {
    const calls = fixture();
    const result = await loadBookRoute({
      ...params,
      locale: "de",
      href: "/app/notebooks/book01/tags/TEAM?search=%20join%20&page=2&mode=book",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.snapshot).toMatchObject({ activeTag: "team", selectedNoteId: null, title: "#team" });
    expect(result.snapshot.html).toContain("Suchen");
    expect(result.snapshot.html).toContain("/app/notebooks/book01/notes/note01?mode=book");
    expect(result.snapshot.html).toContain("mode=book&amp;search=join&amp;page=3");
    expect(calls.tagNotes).toHaveBeenCalledWith({
      notebookId: notebook.id,
      tag: "team",
      search: "join",
      pagination: { limit: 50, offset: 50 },
    });
    expect(calls.content).not.toHaveBeenCalled();
    expect(JSON.stringify(result.snapshot)).not.toContain(note.id);
  });

  test("refreshes update author controls and lock metadata from current state", async () => {
    const calls = fixture();
    calls.permission.mockResolvedValue("admin");
    calls.content.mockResolvedValue({ ...note, lockedAt: timestamp });
    const result = await loadBookRoute(params);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.snapshot).toMatchObject({ canWrite: true, locked: true });
  });

  test("root refreshes render an empty state and expose newly added navigation without loading a note", async () => {
    const calls = fixture();
    calls.tree.mockResolvedValue([]);
    const empty = await loadBookRoute({ ...params, href: "/app/notebooks/book01?mode=book", locale: "de" });
    expect(empty.kind).toBe("ok");
    if (empty.kind !== "ok") throw new Error(empty.kind);
    expect(empty.snapshot).toMatchObject({ tree: [], selectedNoteId: null, title: null, locked: false });
    expect(empty.snapshot.html).toContain("Noch keine Seiten");

    calls.tree.mockResolvedValue([{ ...note, children: [] }]);
    const populated = await loadBookRoute({ ...params, href: "/app/notebooks/book01/", locale: "de" });
    expect(populated.kind).toBe("ok");
    if (populated.kind !== "ok") throw new Error(populated.kind);
    expect(populated.snapshot.tree).toEqual([{ id: "note01", title: "Welcome", children: [] }]);
    expect(populated.snapshot.html).toContain("Wähle eine Seite");
    expect(calls.content).not.toHaveBeenCalled();
    expect(calls.tagNotes).not.toHaveBeenCalled();
  });
});
