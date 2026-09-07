import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { compileCapabilityManifest } from "@valentinkolb/cloud/capabilities/testing";
import {
  type CapabilityActionDefinition,
  type CapabilityActionReviewResult,
  CapabilityActionReviewSchema,
  type CapabilityExecutionContext,
  capabilityResultSchema,
  type User,
} from "@valentinkolb/cloud/contracts";
import { audit } from "@valentinkolb/cloud/services";
import {
  decodeNotebookCapabilityCursor,
  decodeNotebookTreeCursor,
  notebookEnvelopeBytes,
  notebooksCapabilities,
  noteEditCapabilitySummary,
} from "./capabilities";
import {
  CommentCreateInputSchema,
  CommentListInputSchema,
  CommentReadInputSchema,
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
import * as bookStore from "./service/book";
import * as commentStore from "./service/comments";
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
  expect(rememberable).toEqual(["comment.create", "note.create", "note.edit", "note.move"]);
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
  locale: "en",
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
    locale: "en",
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
  defaultPresentationMode: "write" as const,
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
  test("notebook list byte-limited pages resume at the consumed offset", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ...notebook,
      shortId: String(index).padStart(6, "0"),
      description: "a" + "\u0001".repeat(499),
      permission: "read" as const,
    }));
    const list = trackedSpy(spyOn(notebookStore, "listWithPermission")).mockImplementation(async (input) => ({
      items: rows.slice(input.pagination?.offset ?? 0, (input.pagination?.offset ?? 0) + (input.pagination?.limit ?? 25)),
      total: rows.length,
    }));
    const operation = notebooksCapabilities.queries["notebook.list"];
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await operation.run(operation.input.parse({ limit: 100, cursor }), userContext);
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(capabilityResultSchema(operation.data).safeParse(result.data).success).toBeTrue();
      expect(notebookEnvelopeBytes(result)).toBeLessThan(256 * 1024);
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ pagination: { limit: 100, offset: seen.length } }));
      seen.push(...result.data.data.map((item) => item.id));
      cursor = result.data.page.hasMore ? result.data.page.nextCursor : undefined;
    } while (cursor);
    expect(seen).toEqual(rows.map((item) => item.shortId));
    expect(list.mock.calls.length).toBeGreaterThan(1);
  });

  test("zero-block edit receipts preserve hashes, result and truncation truth", async () => {
    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("write");
    const beforeHash = noteContentHash(note.contentMd);
    const afterHash = noteContentHash(`${note.contentMd}\nUpdate`);
    const edit = trackedSpy(spyOn(noteStore, "editContent")).mockResolvedValue({
      ok: true,
      data: {
        note,
        content: `${note.contentMd}\nUpdate`,
        changed: true,
        beforeHash,
        afterHash,
        blocks: [{ name: "facts", type: "data", line: 5, startLine: 5, endLine: 8, hash: beforeHash }],
      },
    });
    trackedSpy(spyOn(audit, "recordResultAfterSideEffect")).mockImplementation(async ({ result }) => result);
    const operation = notebooksCapabilities.actions["note.edit"];
    const result = await operation.run(
      operation.input.parse({
        noteId: note.shortId,
        blockLimit: 0,
        operations: [{ kind: "append", content: "Update" }],
        ifContentHash: beforeHash,
      }),
      userContext,
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data.data).toMatchObject({
      changed: true,
      beforeHash,
      afterHash,
      blocks: [],
      blocksTruncated: true,
      note: { id: note.shortId },
    });
    expect(capabilityResultSchema(operation.data).safeParse(result.data).success).toBeTrue();
    expect(edit.mock.calls[0]![0].data).not.toHaveProperty("blockLimit");
    expect(result.data.links).toEqual([{ rel: "open", href: `/app/notebooks/${notebook.shortId}/notes/${note.shortId}` }]);
  });

  test("compact notebook selection can go directly to local navigation", async () => {
    const list = trackedSpy(spyOn(notebookStore, "listWithPermission")).mockResolvedValue({
      items: [{ ...notebook, permission: "write" }],
      total: 1,
    });
    const operation = notebooksCapabilities.queries["notebook.browse"];
    const result = await operation.run(operation.input.parse({ minimumPermission: "write" }), userContext);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data.data[0]).toEqual({
      ref: { type: "notebooks.notebook", id: notebook.shortId },
      title: notebook.name,
      preview: notebook.description,
      permission: "write",
      homepageNoteId: note.shortId,
      links: [{ rel: "open", href: `/app/notebooks/${notebook.shortId}` }],
    });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ requiredLevel: "write", pagination: { limit: 25, offset: 0 } }));
    expect(capabilityResultSchema(operation.data).safeParse(result.data).success).toBeTrue();
  });

  test("tree pages respect the full envelope ref limit and resume after the last returned row", async () => {
    trackedSpy(spyOn(notebookStore, "getByShortId")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("read");
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...note,
      id: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
      shortId: String(index).padStart(6, "0"),
    }));
    const list = trackedSpy(spyOn(noteStore, "listTreePage")).mockResolvedValue(rows);
    trackedSpy(spyOn(noteStore, "resolveIdsToShortIds")).mockResolvedValue(new Map());
    const operation = notebooksCapabilities.queries["note.tree"];
    const result = await operation.run(operation.input.parse({ notebookId: notebook.shortId, limit: 2000 }), userContext);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data.data).toHaveLength(100);
    expect(capabilityResultSchema(operation.data).safeParse(result.data).success).toBeTrue();
    expect(notebookEnvelopeBytes(result)).toBeLessThan(256 * 1024);
    if (!result.data.page.hasMore) throw new Error("Expected next tree page");
    expect(decodeNotebookTreeCursor(result.data.page.nextCursor)).toEqual({ ok: true, data: rows[99]!.id });
    list.mockResolvedValue([rows[100]!]);
    const next = await operation.run(
      operation.input.parse({ notebookId: notebook.shortId, cursor: result.data.page.nextCursor }),
      userContext,
    );
    expect(next.ok && next.data.data.map((entry) => entry.id)).toEqual([rows[100]!.shortId]);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ afterId: rows[99]!.id, limit: 101 }));
  });

  test("children browse roots without fetching the whole hierarchy and rejects a foreign parent", async () => {
    trackedSpy(spyOn(notebookStore, "getByShortId")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("read");
    const list = trackedSpy(spyOn(noteStore, "listTreePage")).mockResolvedValue([]);
    trackedSpy(spyOn(noteStore, "resolveIdsToShortIds")).mockResolvedValue(new Map());
    const operation = notebooksCapabilities.queries["note.children"];
    expect((await operation.run(operation.input.parse({ notebookId: notebook.shortId }), userContext)).ok).toBeTrue();
    expect(list).toHaveBeenCalledWith({ notebookId, parentId: null, afterId: undefined, limit: 26 });
    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue({ ...note, notebookId: otherNotebookId });
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue({ ...notebook, id: otherNotebookId });
    expect(
      (await operation.run(operation.input.parse({ notebookId: notebook.shortId, parentId: note.shortId }), userContext)).ok,
    ).toBeFalse();
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("comment pages fit escaped UTF-8 bodies and continue without dropping rows", async () => {
    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("read");
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ...commentFixture(),
      shortId: String(index).padStart(6, "0"),
      content: "\u0001".repeat(5000),
    }));
    const list = trackedSpy(spyOn(commentStore, "listPage")).mockImplementation(async (input) => {
      const offset = input.offset ?? 0;
      const items = rows.slice(offset, offset + 100);
      return { items, page: 1, perPage: 100, total: 100, hasNext: false };
    });
    const operation = notebooksCapabilities.queries["comment.list"];
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await operation.run(operation.input.parse({ noteId: note.shortId, limit: 100, cursor }), userContext);
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(capabilityResultSchema(operation.data).safeParse(result.data).success).toBeTrue();
      expect(notebookEnvelopeBytes(result)).toBeLessThan(256 * 1024);
      seen.push(...result.data.data.map((item) => item.id));
      cursor = result.data.page.hasMore ? result.data.page.nextCursor : undefined;
    } while (cursor);
    expect(seen).toEqual(rows.map((item) => item.shortId));
    expect(list.mock.calls.length).toBeGreaterThan(1);
  });

  test("comment browsing keeps previews compact and does not advertise writes with read-only access", async () => {
    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    const permission = trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("read");
    trackedSpy(spyOn(commentStore, "listPage")).mockResolvedValue({
      items: [{ ...commentFixture(), content: "x".repeat(5000) }],
      page: 1,
      perPage: 25,
      total: 1,
      hasNext: false,
    });
    const operation = notebooksCapabilities.queries["comment.browse"];
    const result = await operation.run(operation.input.parse({ noteId: note.shortId }), userContext);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data.data[0]).toMatchObject({ previewTruncated: true, canEdit: false, canDelete: false });
    expect(result.data.data[0]!.preview).toHaveLength(300);
    permission.mockResolvedValue("write");
    const writable = await operation.run(operation.input.parse({ noteId: note.shortId }), userContext);
    expect(writable.ok && writable.data.data[0]!.canEdit).toBeTrue();
  });

  test("read windows stay byte bounded and the last partial window is not a complete document", async () => {
    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("read");
    const content = "\u0001".repeat(50_000);
    trackedSpy(spyOn(noteStore, "getCurrentWithContent")).mockResolvedValue({ ...note, contentMd: content, yjsSnapshot: null });
    const operation = notebooksCapabilities.queries["note.read"];
    const first = await operation.run({ id: note.shortId, contentOffset: 0, contentLimit: 50_000 }, userContext);
    expect(first.ok).toBeTrue();
    if (!first.ok) return;
    expect(notebookEnvelopeBytes(first)).toBeLessThan(256 * 1024);
    expect(first.data.data.contentComplete).toBeFalse();
    const last = await operation.run(
      { id: note.shortId, contentOffset: first.data.data.nextContentOffset!, contentLimit: 50_000 },
      userContext,
    );
    expect(last.ok).toBeTrue();
    if (!last.ok) return;
    expect(last.data.data.contentComplete).toBeFalse();
    expect(last.data.data.nextContentOffset).toBeNull();
    expect(first.data.data.content + last.data.data.content).toBe(content);
    expect(first.data.data.contentHash).toBe(last.data.data.contentHash);
  });

  test("compiles the expanded public manifest", () => {
    expect(() => compileCapabilityManifest("notebooks", notebooksCapabilities)).not.toThrow();
  });
  const commentFixture = () => ({
    id: "66666666-6666-4666-8666-666666666666",
    shortId: "mno345",
    noteId,
    authorUserId: userId,
    authorDisplayName: user.displayName,
    authorAvatarHash: null,
    content: "An observation",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canEdit: true,
    canDelete: true,
  });
  const mockCommentAccess = () => {
    trackedSpy(spyOn(noteStore, "get")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("write");
    return trackedSpy(spyOn(commentStore, "getByShortId")).mockResolvedValue(commentFixture());
  };

  test("previews use the canonical service without returning source or HTML", async () => {
    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    const permission = trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("read");
    const preview = trackedSpy(spyOn(bookStore, "loadBookBlockPreview")).mockResolvedValue({
      kind: "ok",
      preview: {
        markdown: "# Example",
        blocks: [{ line: 1, html: "private html" }],
        headings: [{ id: "heading-example", line: 1 }],
        diagnostics: [],
      },
    });
    const operation = notebooksCapabilities.queries["note.preview"];
    const result = await operation.run({ noteId: note.shortId }, userContext);
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.data.data).toEqual({
        valid: true,
        contentHash: noteContentHash("# Example"),
        blockCount: 1,
        headingCount: 1,
        diagnostics: [],
        diagnosticsTruncated: false,
      });
      expect(capabilityResultSchema(operation.data).safeParse(result.data).success).toBeTrue();
    }
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ userId, notebookId, markdown: undefined, bypassAccess: false }));
    expect((await operation.run({ noteId: note.shortId, markdown: "" }, userContext)).ok).toBeFalse();
    expect(preview).toHaveBeenCalledTimes(1);
    permission.mockResolvedValue("write");
    await operation.run({ noteId: note.shortId, markdown: "" }, userContext);
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: "" }));
    expect((await operation.run({ noteId: note.shortId }, resourceContext(["admin"]))).ok).toBeFalse();
    expect(preview).toHaveBeenCalledTimes(2);
  });

  test("preview bounds diagnostics without reporting truncated failures as valid", async () => {
    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("write");
    const preview = trackedSpy(spyOn(bookStore, "loadBookBlockPreview")).mockResolvedValue({
      kind: "ok",
      preview: {
        markdown: "",
        blocks: [],
        headings: [],
        diagnostics: Array.from({ length: 70 }, () => ({ line: 1, message: "x".repeat(1500) })),
      },
    });
    const operation = notebooksCapabilities.queries["note.preview"];
    const result = await operation.run({ noteId: note.shortId }, userContext);
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.data.data.valid).toBeFalse();
      expect(result.data.data.diagnostics).toHaveLength(50);
      expect(result.data.data.diagnostics[0]!.message).toHaveLength(500);
      expect(result.data.data.diagnosticsTruncated).toBeTrue();
      expect(capabilityResultSchema(operation.data).safeParse(result.data).success).toBeTrue();
    }
    preview.mockResolvedValue({ kind: "denied" });
    expect((await operation.run({ noteId: note.shortId, markdown: "" }, userContext)).ok).toBeFalse();
    preview.mockResolvedValue({ kind: "not_found" });
    expect((await operation.run({ noteId: note.shortId }, userContext)).ok).toBeFalse();
    expect(operation.input.safeParse({ noteId: note.shortId, markdown: "x".repeat(200_001) }).success).toBeFalse();
  });

  test("comment update and deletion use author-scoped services and explicit reviews", async () => {
    mockCommentAccess();
    const update = trackedSpy(spyOn(commentStore, "update")).mockResolvedValue({
      ok: true,
      data: { ...commentFixture(), content: "Corrected" },
    });
    const remove = trackedSpy(spyOn(commentStore, "remove")).mockResolvedValue({ ok: true, data: undefined });
    trackedSpy(spyOn(audit, "recordResultAfterSideEffect")).mockImplementation(async ({ result }) => result);
    const input = { commentId: "mno345", content: "Corrected" };
    const edit = notebooksCapabilities.actions["comment.update"];
    const deletion = notebooksCapabilities.actions["comment.delete"];
    for (const operation of [edit, deletion]) {
      expect(operation.destructive).toBeTrue();
      expect("approval" in operation).toBeFalse();
      const review = await operation.review(input, userContext);
      expect(review.ok).toBeTrue();
      if (review.ok) expect(CapabilityActionReviewSchema.safeParse(review.data).success).toBeTrue();
    }
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    const edited = await edit.run(input, userContext);
    const deleted = await deletion.run({ commentId: input.commentId }, userContext);
    expect(edited.ok).toBeTrue();
    expect(deleted.ok).toBeTrue();
    if (edited.ok) expect(capabilityResultSchema(edit.data).safeParse(edited.data).success).toBeTrue();
    if (deleted.ok) expect(capabilityResultSchema(deletion.data).safeParse(deleted.data).success).toBeTrue();
    expect(update).toHaveBeenCalledWith({ notebookId, noteId, commentId: input.commentId, authorUserId: userId, content: input.content });
    expect(remove).toHaveBeenCalledWith({ notebookId, noteId, commentId: input.commentId, authorUserId: userId });
  });

  test("comment mutations reject foreign, expired, inaccessible and service-account actors", async () => {
    const read = mockCommentAccess();
    const update = trackedSpy(spyOn(commentStore, "update"));
    const remove = trackedSpy(spyOn(commentStore, "remove"));
    const input = { commentId: "mno345", content: "Corrected" };
    for (const operation of [notebooksCapabilities.actions["comment.update"], notebooksCapabilities.actions["comment.delete"]]) {
      expect((await operation.run(input, resourceContext(["admin"]))).ok).toBeFalse();
      for (const comment of [
        { ...commentFixture(), authorUserId: serviceAccountId },
        { ...commentFixture(), createdAt },
      ]) {
        read.mockResolvedValue(comment);
        expect((await operation.review(input, userContext)).ok).toBeFalse();
        expect((await operation.run(input, userContext)).ok).toBeFalse();
      }
      read.mockResolvedValue(null);
      expect((await operation.run(input, userContext)).ok).toBeFalse();
    }
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("comment authorization is checked again after review and store refusals stay failures", async () => {
    const read = mockCommentAccess();
    trackedSpy(spyOn(audit, "recordResult")).mockImplementation(async ({ result }) => result);
    const update = trackedSpy(spyOn(commentStore, "update")).mockResolvedValue({
      ok: false,
      error: { status: 403, code: "FORBIDDEN", message: "Window expired" },
    });
    const remove = trackedSpy(spyOn(commentStore, "remove")).mockResolvedValue({
      ok: false,
      error: { status: 403, code: "FORBIDDEN", message: "Window expired" },
    });
    const input = { commentId: "mno345", content: "Corrected" };
    for (const operation of [notebooksCapabilities.actions["comment.update"], notebooksCapabilities.actions["comment.delete"]]) {
      read.mockResolvedValue(commentFixture());
      expect((await operation.review(input, userContext)).ok).toBeTrue();
      read.mockResolvedValue({ ...commentFixture(), createdAt });
      expect((await operation.run(input, userContext)).ok).toBeFalse();
      read.mockResolvedValue(commentFixture());
      const result = await operation.run(input, { ...userContext, locale: "de" });
      expect(result.ok).toBeFalse();
      if (!result.ok) expect(result.error.message).toContain("zehn Minuten");
    }
    expect(update).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("declares the complete bounded wiki surface", () => {
    expect(Object.keys(notebooksCapabilities.types).sort()).toEqual(["comment", "note", "notebook"]);
    expect(Object.keys(notebooksCapabilities.queries).sort()).toEqual([
      "comment.browse",
      "comment.list",
      "comment.read",
      "note.children",
      "note.links",
      "note.preview",
      "note.read",
      "note.search",
      "note.tree",
      "notebook.browse",
      "notebook.list",
      "notebook.read",
      "notebook.search",
      "tag.list",
      "tag.notes",
    ]);
    expect(Object.keys(notebooksCapabilities.actions).sort()).toEqual([
      "comment.create",
      "comment.delete",
      "comment.update",
      "note.create",
      "note.edit",
      "note.move",
    ]);
    expect(
      Object.entries(notebooksCapabilities.actions)
        .filter(([, action]) => "review" in action && action.review)
        .map(([id]) => id)
        .sort(),
    ).toEqual(["comment.create", "comment.delete", "comment.update", "note.create", "note.edit", "note.move"]);
    expect(notebooksCapabilities.actions["comment.create"]).toMatchObject({
      destructive: false,
      openWorld: false,
      idempotency: "none",
    });
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
    expect(CommentCreateInputSchema.safeParse({ noteId: note.shortId, content: "A useful observation." }).success).toBeTrue();
    expect(CommentCreateInputSchema.safeParse({ noteId: note.shortId, content: "   " }).success).toBeFalse();
    expect(CommentCreateInputSchema.safeParse({ noteId: note.shortId, content: "x".repeat(5_001) }).success).toBeFalse();
    expect(CommentCreateInputSchema.safeParse({ noteId: note.shortId, content: "Comment", unexpected: true }).success).toBeFalse();
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
    expect(CommentListInputSchema.safeParse({ noteId: note.shortId }).success).toBeTrue();
    expect(CommentListInputSchema.safeParse({ noteId }).success).toBeFalse();
    expect(CommentReadInputSchema.safeParse({ id: "mno345" }).success).toBeTrue();
    expect(CommentReadInputSchema.safeParse({ id: noteId }).success).toBeFalse();
    expect(CommentCreateInputSchema.safeParse({ noteId: note.shortId, content: "Comment" }).success).toBeTrue();
    expect(CommentCreateInputSchema.safeParse({ noteId, content: "Comment" }).success).toBeFalse();
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
    const getCurrentWithContent = trackedSpy(spyOn(noteStore, "getCurrentWithContent")).mockResolvedValue({
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
    expect(getCurrentWithContent).toHaveBeenCalledWith({ id: note.id });
    expect(result.data.refs).toEqual([
      { type: "notebooks.note", id: note.shortId, title: note.title, preview: notebook.name, icon: "ti ti-file-text" },
      {
        type: "notebooks.notebook",
        id: notebook.shortId,
        title: notebook.name,
        preview: notebook.description,
        icon: "ti ti-notebook",
      },
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
    expect(read.data.refs).toEqual([
      {
        type: "notebooks.notebook",
        id: ref.id,
        title: notebook.name,
        preview: notebook.description,
        icon: "ti ti-notebook",
      },
    ]);
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
    expect(links.data.refs).toEqual([
      { type: "notebooks.note", id: note.shortId, title: note.title, preview: notebook.name, icon: "ti ti-file-text" },
    ]);
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
        { type: "notebooks.note", id: note.shortId, title: note.title, preview: notebook.name, icon: "ti ti-file-text" },
        {
          type: "notebooks.notebook",
          id: notebook.shortId,
          title: notebook.name,
          preview: notebook.description,
          icon: "ti ti-notebook",
        },
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

  test("adds comments as the user through the permission-aware service", async () => {
    trackedSpy(spyOn(noteStore, "getByShortId")).mockResolvedValue(note);
    trackedSpy(spyOn(notebookStore, "get")).mockResolvedValue(notebook);
    trackedSpy(spyOn(notebookStore, "getPermission")).mockResolvedValue("write");
    const createdComment = {
      id: "66666666-6666-4666-8666-666666666666",
      shortId: "mno345",
      noteId,
      authorUserId: userId,
      authorDisplayName: user.displayName,
      authorAvatarHash: null,
      content: "A useful observation.",
      createdAt,
      updatedAt: createdAt,
      canEdit: true,
      canDelete: true,
    };
    const create = trackedSpy(spyOn(commentStore, "create")).mockResolvedValue({ ok: true, data: createdComment });
    const record = trackedSpy(spyOn(audit, "recordResultAfterSideEffect")).mockImplementation(async ({ result }) => result);

    const result = await notebooksCapabilities.actions["comment.create"].run(
      { noteId: note.shortId, content: createdComment.content },
      userContext,
    );

    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.data.summary).toBe(`Added a comment to “${note.title}”.`);
      expect(capabilityResultSchema(notebooksCapabilities.actions["comment.create"].data).safeParse(result.data).success).toBeTrue();
      expect(result.data.data).toMatchObject({ id: createdComment.shortId, notebookId: notebook.shortId, noteId: note.shortId });
    }
    expect(create).toHaveBeenCalledWith({
      notebookId,
      noteId,
      authorUserId: userId,
      authorDisplayName: user.displayName,
      content: createdComment.content,
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "notebooks.capability.comment.create" }));
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
    expect(result.data.refs).toEqual([
      { type: "notebooks.note", id: note.shortId, title: note.title, preview: "Knowledge", icon: "ti ti-file-text" },
    ]);
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
      await notebooksCapabilities.actions["comment.create"].review!(
        { noteId: note.shortId, content: "A useful observation." },
        userContext,
      ),
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
