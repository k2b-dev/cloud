import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  type CapabilityActionDefinition,
  type CapabilityActionReviewResult,
  CapabilityActionReviewSchema,
  type CapabilityExecutionContext,
  capabilityResultSchema,
  type User,
} from "@valentinkolb/cloud/contracts";
import { audit } from "@valentinkolb/cloud/services";
import { decodeNotebookCapabilityCursor, decodeNotebookTreeCursor, notebooksCapabilities, noteEditCapabilitySummary } from "./capabilities";
import {
  NotebookReadInputSchema,
  NoteCreateInputSchema,
  NoteDetailDataSchema,
  NoteEditInputSchema,
  NoteLinksInputSchema,
  NoteMoveInputSchema,
  NoteReadInputSchema,
  NoteTreeDataSchema,
  NoteTreeInputSchema,
  TagListInputSchema,
  TagNotesDataSchema,
  TagNotesInputSchema,
} from "./capability-contracts";
import { noteContentHash } from "./lib/note-edit";
import * as noteLinks from "./service/links";
import * as notebookStore from "./service/notebooks";
import * as noteStore from "./service/notes";
import * as noteSearch from "./service/search";
import * as noteTags from "./service/tags";

const userId = "11111111-1111-4111-8111-111111111111";
const serviceAccountId = "22222222-2222-4222-8222-222222222222";
const notebookId = "33333333-3333-4333-8333-333333333333";
const otherNotebookId = "44444444-4444-4444-8444-444444444444";
const otherNotebookShortId = "ghi789";
const noteId = "55555555-5555-4555-8555-555555555555";
const createdAt = "2026-08-02T08:00:00.000Z";
const activeSpies: Array<{ mockRestore(): void }> = [];

test("only exposes remembered approval for bounded notebook-local note changes", () => {
  const rememberable = (Object.entries(notebooksCapabilities.actions) as Array<[string, CapabilityActionDefinition]>)
    .filter(([, action]) => action.approval === "rememberable")
    .map(([localId]) => localId)
    .sort();
  expect(rememberable).toEqual(["note.create", "note.edit", "note.move"]);
});

const trackedSpy = <T extends { mockRestore(): void }>(spy: T): T => {
  activeSpies.push(spy);
  return spy;
};

const user = {
  id: userId,
  uid: "notebooks-user",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Notebook",
  sn: "User",
  displayName: "Notebook User",
  mail: "notebooks@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const userContext = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId },
  user,
  signal: new AbortController().signal,
} satisfies CapabilityExecutionContext;

const resourceContext = (scopes: string[]) =>
  ({
    actor: {
      kind: "service_account",
      serviceAccount: {
        id: serviceAccountId,
        name: "Notebook resource account",
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId: "notebooks",
        resourceType: "notebook",
        resourceId: notebookId,
        createdBy: null,
        createdAt,
      },
      delegatedUser: null,
      scopes,
    },
    accessSubject: { type: "service_account", serviceAccountId },
    user: null,
    signal: new AbortController().signal,
  }) satisfies CapabilityExecutionContext;

const notebook = {
  id: notebookId,
  shortId: "abc123",
  name: "Knowledge",
  description: "Team knowledge",
  icon: null,
  homepageNoteId: noteId,
  homepageNoteShortId: "def456",
  scriptsEnabled: false,
  defaultNoteTitleTemplate: "Untitled",
  createdBy: userId,
  createdAt,
  updatedAt: createdAt,
};

const note = {
  id: noteId,
  shortId: "def456",
  notebookId,
  parentId: null,
  title: "Knowledge index",
  position: 0,
  hasChildren: false,
  yjsSnapshotAt: createdAt,
  contentMd: '# Knowledge index\n\n#docs\n\n@facts\n:::data\n{"ready":true}\n:::',
  createdBy: userId,
  createdAt,
  updatedAt: createdAt,
  lockedAt: null,
};

afterEach(() => {
  for (const spy of activeSpies.splice(0)) spy.mockRestore();
});

describe("notebooks capabilities", () => {
  test("declares the complete bounded wiki surface", () => {
    expect(Object.keys(notebooksCapabilities.types).sort()).toEqual(["note", "notebook"]);
    expect(Object.keys(notebooksCapabilities.queries).sort()).toEqual([
      "note.links",
      "note.read",
      "note.search",
      "note.tree",
      "notebook.list",
      "notebook.read",
      "notebook.search",
      "tag.list",
      "tag.notes",
    ]);
    expect(Object.keys(notebooksCapabilities.actions).sort()).toEqual(["note.create", "note.edit", "note.move"]);
    expect(
      Object.entries(notebooksCapabilities.actions)
        .filter(([, action]) => "review" in action && action.review)
        .map(([id]) => id)
        .sort(),
    ).toEqual(["note.create", "note.edit", "note.move"]);
    expect(notebooksCapabilities.actions["note.edit"]).toMatchObject({
      destructive: true,
      openWorld: false,
      idempotency: "none",
    });
    expect(
      Object.entries(notebooksCapabilities.queries)
        .filter(([, query]) => "universalSearch" in query && query.universalSearch)
        .map(([id]) => id)
        .sort(),
    ).toEqual(["note.search", "notebook.search"]);
    expect(notebooksCapabilities.queries["notebook.list"].description).toContain("Normal entry for notebook-scoped work");
    expect(notebooksCapabilities.queries["note.search"].description).toContain("Direct cross-notebook entry");
    expect(notebooksCapabilities.queries["note.tree"].description).toContain("use returned notebooks.note refs with note.read");
  });

  test("keeps write schemas strict and bounded", () => {
    expect(NoteCreateInputSchema.safeParse({ notebookId: notebook.shortId, content: "# Note", unexpected: true }).success).toBeFalse();
    expect(NoteEditInputSchema.safeParse({ noteId: note.shortId, operations: [] }).success).toBeFalse();
    expect(
      NoteEditInputSchema.safeParse({
        noteId: note.shortId,
        operations: [{ kind: "append", content: "x" }],
        ifContentHash: "not-a-hash",
      }).success,
    ).toBeFalse();
    const fragment = "x".repeat(10_000);
    const structuralEdit = {
      noteId: note.shortId,
      operations: Array.from({ length: 20 }, () => ({ kind: "append" as const, content: fragment })),
    };
    expect(NoteEditInputSchema.safeParse(structuralEdit).success).toBeTrue();
    expect(Buffer.byteLength(JSON.stringify({ input: structuralEdit }))).toBeLessThan(220_000);
    const fullReplacement = {
      noteId: note.shortId,
      operations: [{ kind: "set-content" as const, content: "x".repeat(200_000) }],
    };
    expect(NoteEditInputSchema.safeParse(fullReplacement).success).toBeTrue();
    expect(Buffer.byteLength(JSON.stringify({ input: fullReplacement }))).toBeLessThan(220_000);
    expect(
      NoteEditInputSchema.safeParse({ noteId: note.shortId, operations: [{ kind: "append", content: `${fragment}x` }] }).success,
    ).toBeFalse();
    expect(
      NoteEditInputSchema.safeParse({
        noteId: note.shortId,
        operations: [
          { kind: "set-content", content: "First" },
          { kind: "set-content", content: "Second" },
        ],
      }).success,
    ).toBeFalse();
    expect(
      NoteTreeDataSchema.safeParse([
        { id: note.shortId, parentId: null, title: "Note", position: 0, hasChildren: false, content: "hidden" },
      ]).success,
    ).toBeFalse();
  });

  test("accepts only short IDs at every capability boundary", () => {
    expect(NotebookReadInputSchema.safeParse({ id: notebook.shortId }).success).toBeTrue();
    expect(NoteReadInputSchema.safeParse({ id: note.shortId }).success).toBeTrue();
    expect(NotebookReadInputSchema.safeParse({ id: notebookId }).success).toBeFalse();
    expect(NoteReadInputSchema.safeParse({ id: noteId }).success).toBeFalse();
    expect(NoteTreeInputSchema.safeParse({ notebookId: notebook.shortId }).success).toBeTrue();
    expect(NoteTreeInputSchema.safeParse({ notebookId }).success).toBeFalse();
    expect(NoteLinksInputSchema.safeParse({ noteId: note.shortId }).success).toBeTrue();
    expect(NoteLinksInputSchema.safeParse({ noteId }).success).toBeFalse();
    expect(TagListInputSchema.safeParse({ notebookId: notebook.shortId }).success).toBeTrue();
    expect(TagListInputSchema.safeParse({ notebookId }).success).toBeFalse();
    expect(TagNotesInputSchema.safeParse({ notebookId: notebook.shortId, tag: "docs" }).success).toBeTrue();
    expect(TagNotesInputSchema.safeParse({ notebookId, tag: "docs" }).success).toBeFalse();
    expect(NoteCreateInputSchema.safeParse({ notebookId: notebook.shortId, parentId: note.shortId }).success).toBeTrue();
    expect(NoteCreateInputSchema.safeParse({ notebookId, parentId: noteId }).success).toBeFalse();
    expect(NoteEditInputSchema.safeParse({ noteId: note.shortId, operations: [{ kind: "append", content: "x" }] }).success).toBeTrue();
    expect(NoteEditInputSchema.safeParse({ noteId, operations: [{ kind: "append", content: "x" }] }).success).toBeFalse();
    expect(NoteMoveInputSchema.safeParse({ noteId: note.shortId, parentId: null, position: 0 }).success).toBeTrue();
    expect(NoteMoveInputSchema.safeParse({ noteId, parentId: null, position: 0 }).success).toBeFalse();
  });

  test("accepts only opaque page and stable tree cursors", () => {
    const pageCursor = Buffer.from(JSON.stringify({ v: 1, page: 4 }), "utf8").toString("base64url");
    const treeCursor = Buffer.from(JSON.stringify({ v: 1, afterId: noteId }), "utf8").toString("base64url");
    expect(decodeNotebookCapabilityCursor(pageCursor)).toEqual({ ok: true, data: 4 });
    expect(decodeNotebookTreeCursor(treeCursor)).toEqual({ ok: true, data: noteId });
    expect(decodeNotebookCapabilityCursor("broken").ok).toBeFalse();
    expect(decodeNotebookTreeCursor(pageCursor).ok).toBeFalse();
    const unsafe = Buffer.from(JSON.stringify({ v: 1, page: 1e308 }), "utf8").toString("base64url");
    expect(decodeNotebookCapabilityCursor(unsafe).ok).toBeFalse();
  });

  test("reads bounded Markdown without exposing Yjs state", async () => {
    const getByShortId = trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("read");
    trackedSpy(spyOn(noteStore, "getWithContent")).mockResolvedValue({
      ...note,
      yjsSnapshot: "private-snapshot",
    });

    const result = await notebooksCapabilities.queries["note.read"].run(
      { id: note.shortId, contentOffset: 0, contentLimit: 12 },
      userContext,
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(getByShortId).toHaveBeenCalledWith({ shortId: note.shortId });
    expect(result.data.refs).toEqual([
      { type: "notebooks.note", id: note.shortId },
      { type: "notebooks.notebook", id: notebook.shortId },
    ]);
    expect(result.data.links).toEqual([{ rel: "open", href: `/app/notebooks/${notebook.shortId}/notes/${note.shortId}` }]);
    expect(result.data.data.content).toBe("# Knowledge ");
    expect(result.data.data.contentComplete).toBeFalse();
    expect(result.data.data.nextContentOffset).toBe(12);
    expect(result.data.data.contentHash).toBe(noteContentHash(note.contentMd));
    expect(result.data.data.tags).toEqual(["docs"]);
    expect(result.data.summary).toBe("Read note “Knowledge index”.");
    expect(result.data.data).not.toHaveProperty("yjsSnapshot");
    expect(NoteDetailDataSchema.safeParse(result.data.data).success).toBeTrue();
  });

  test("confines resource accounts and caps writes by scope", async () => {
    const getPermission = trackedSpy(spyOn(notebookStore, "getPermission"));
    trackedSpy(spyOn(notebookStore, "getByShortId")).mockResolvedValue({
      ...notebook,
      id: otherNotebookId,
      shortId: otherNotebookShortId,
    });
    const outside = await notebooksCapabilities.queries["notebook.read"].run({ id: otherNotebookShortId }, resourceContext(["read"]));
    expect(outside.ok).toBeFalse();
    expect(getPermission).not.toHaveBeenCalled();

    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    getPermission.mockResolvedValue("admin");
    const editContent = trackedSpy(spyOn(noteStore, "editContent"));
    trackedSpy(spyOn(audit, "recordResult")).mockImplementation(async ({ result }) => result);
    const edit = await notebooksCapabilities.actions["note.edit"].run(
      { noteId: note.shortId, operations: [{ kind: "append", content: "Update" }] },
      resourceContext(["read"]),
    );
    expect(edit.ok).toBeFalse();
    expect(editContent).not.toHaveBeenCalled();
  });

  test("keeps universal-search refs readable without changing their short IDs", async () => {
    trackedSpy(spyOn(notebookStore, "listWithPermission")).mockResolvedValue({
      items: [{ ...notebook, permission: "read" }],
      total: 1,
    });
    const getByShortId = trackedSpy(spyOn(notebookStore, "getByShortId")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("read");

    const search = await notebooksCapabilities.queries["notebook.search"].run({ query: "Knowledge", limit: 10, tags: [] }, userContext);
    expect(search.ok).toBeTrue();
    if (!search.ok) return;
    const ref = search.data.data[0]?.ref;
    expect(ref).toEqual({ type: "notebooks.notebook", id: notebook.shortId });
    if (!ref) return;

    const read = await notebooksCapabilities.queries["notebook.read"].run({ id: ref.id }, userContext);
    expect(read.ok).toBeTrue();
    expect(getByShortId).toHaveBeenCalledWith({ shortId: ref.id });
    if (!read.ok) return;
    expect(read.data.summary).toBe("Read notebook “Knowledge”.");
    expect(read.data.refs).toEqual([ref]);
    expect(read.data.links).toEqual([{ rel: "open", href: `/app/notebooks/${notebook.shortId}` }]);
  });

  test("publishes note short IDs from search and link results", async () => {
    trackedSpy(spyOn(noteSearch, "searchAcross")).mockResolvedValue({
      hits: [
        {
          note,
          notebook: { id: notebook.id, shortId: notebook.shortId, name: notebook.name, icon: notebook.icon },
          snippet: "Knowledge",
        },
      ],
      total: 1,
    });
    const search = await notebooksCapabilities.queries["note.search"].run({ query: "Knowledge", limit: 10, tags: [] }, userContext);
    expect(search.ok).toBeTrue();
    if (!search.ok) return;
    expect(search.data.data[0]?.ref).toEqual({ type: "notebooks.note", id: note.shortId });
    expect(search.data.data[0]?.links).toEqual([{ rel: "open", href: `/app/notebooks/${notebook.shortId}/notes/${note.shortId}` }]);

    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("read");
    trackedSpy(spyOn(noteLinks, "listNoteRelations")).mockResolvedValue([
      {
        direction: "outgoing",
        noteId: note.shortId,
        title: note.title,
        notebookId: notebook.shortId,
        notebookName: notebook.name,
        updatedAt: createdAt,
      },
    ]);
    const links = await notebooksCapabilities.queries["note.links"].run({ noteId: note.shortId, direction: "all", limit: 25 }, userContext);
    expect(links.ok).toBeTrue();
    if (!links.ok) return;
    expect(links.data.refs).toEqual([{ type: "notebooks.note", id: note.shortId }]);
    expect(links.data.data[0]?.ref).toEqual({ type: "notebooks.note", id: note.shortId });
    expect(links.data.data[0]?.links).toEqual([{ rel: "open", href: `/app/notebooks/${notebook.shortId}/notes/${note.shortId}` }]);
  });

  test("routes edits through the conflict-aware service and audits success", async () => {
    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("write");
    const afterHash = noteContentHash(`${note.contentMd}\nUpdate`);
    const editContent = trackedSpy(spyOn(noteStore, "editContent")).mockResolvedValue({
      ok: true,
      data: {
        note: { ...note, updatedAt: "2026-08-02T09:00:00.000Z" },
        content: `${note.contentMd}\nUpdate`,
        changed: true,
        beforeHash: noteContentHash(note.contentMd),
        afterHash,
        blocks: [],
      },
    });
    const record = trackedSpy(spyOn(audit, "recordResultAfterSideEffect")).mockImplementation(async ({ result }) => result);

    const result = await notebooksCapabilities.actions["note.edit"].run(
      { noteId: note.shortId, operations: [{ kind: "append", content: "Update" }], ifContentHash: noteContentHash(note.contentMd) },
      userContext,
    );
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.data.summary).toBe(`Added 1 line to “${note.title}”.`);
      expect(capabilityResultSchema(notebooksCapabilities.actions["note.edit"].data).safeParse(result.data).success).toBeTrue();
      expect(result.data.refs).toEqual([
        { type: "notebooks.note", id: note.shortId },
        { type: "notebooks.notebook", id: notebook.shortId },
      ]);
    }
    expect(editContent).toHaveBeenCalledWith({
      noteId,
      data: {
        operations: [{ kind: "append", content: "Update" }],
        ifContentHash: noteContentHash(note.contentMd),
      },
      createdBy: userId,
      actor: { kind: "user", id: userId },
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "notebooks.capability.note.edit" }));
  });

  test("summarizes note edits by their visible effect", () => {
    expect(noteEditCapabilitySummary([{ kind: "insert-after-line", line: 2, content: "First\nSecond" }], note.title, true)).toBe(
      `Inserted 2 lines in “${note.title}”.`,
    );
    expect(noteEditCapabilitySummary([{ kind: "append-block", name: "facts", content: "Updated" }], note.title, true)).toBe(
      `Updated @facts in “${note.title}”.`,
    );
    expect(noteEditCapabilitySummary([{ kind: "set-content", content: note.contentMd }], note.title, false)).toBe(
      `“${note.title}” was already up to date.`,
    );
  });

  test("normalizes tagged-note timestamps before validating the capability result", async () => {
    trackedSpy(spyOn(notebookStore, "getByShortId")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("read");
    trackedSpy(spyOn(noteTags, "listNotesForTag")).mockResolvedValue({
      items: [
        {
          id: noteId,
          shortId: note.shortId,
          title: note.title,
          preview: "Knowledge",
          updatedAt: new Date(createdAt) as unknown as string,
        },
      ],
      total: 1,
    });

    const result = await notebooksCapabilities.queries["tag.notes"].run(
      { notebookId: notebook.shortId, tag: "docs", limit: 25 },
      userContext,
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data.data[0]?.updatedAt).toBe(createdAt);
    expect(result.data.data[0]?.ref).toEqual({ type: "notebooks.note", id: note.shortId });
    expect(result.data.refs).toEqual([{ type: "notebooks.note", id: note.shortId }]);
    expect(result.data.data[0]?.links).toEqual([{ rel: "open", href: `/app/notebooks/${notebook.shortId}/notes/${note.shortId}` }]);
    expect(TagNotesDataSchema.safeParse(result.data.data).success).toBeTrue();
  });

  test("reviews note edits with bounded targets and content previews", async () => {
    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("write");
    const review = notebooksCapabilities.actions["note.edit"].review;
    if (!review) throw new Error("Note edit review missing");

    const result = await review(
      {
        noteId: note.shortId,
        operations: [{ kind: "replace-block", name: "facts", type: "data", content: '{"ready":false}' }],
      },
      userContext,
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data.details).toEqual([
      {
        label: "Operation 1",
        value: 'Replace block @facts (data) with 15 characters.\n\n{"ready":false}',
        display: "block",
      },
    ]);
    expect(result.data.approvalScope).toBe(`notebook:${notebook.shortId}`);
  });

  test("returns a valid notebook scope from every rememberable action review", async () => {
    trackedSpy(spyOn(notebookStore, "getByShortId")).mockResolvedValue(notebook);
    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("write");

    const results: CapabilityActionReviewResult[] = [
      await notebooksCapabilities.actions["note.create"].review!(
        { notebookId: notebook.shortId, parentId: note.shortId, content: "# New note" },
        userContext,
      ),
      await notebooksCapabilities.actions["note.edit"].review!(
        { noteId: note.shortId, operations: [{ kind: "append", content: "Update" }] },
        userContext,
      ),
      await notebooksCapabilities.actions["note.move"].review!({ noteId: note.shortId, parentId: null, position: 1 }, userContext),
    ];

    expect(results).toHaveLength(
      (Object.values(notebooksCapabilities.actions) as CapabilityActionDefinition[]).filter((action) => action.approval === "rememberable")
        .length,
    );
    for (const [index, result] of results.entries()) {
      expect(result.ok).toBeTrue();
      if (!result.ok) continue;
      expect(result.data.approvalScope).toBe(`notebook:${notebook.shortId}`);
      const parsed = CapabilityActionReviewSchema.safeParse(result.data);
      if (!parsed.success) throw new Error(`Review ${index} is invalid: ${JSON.stringify(parsed.error.issues)}`);
    }
  });
});
