import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CloudRuntime, PermissionLevel, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as cloudServices from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import type { PresentationMode } from "../../lib/presentation-mode";
import { notebooksService } from "../../service";
import * as notebookStore from "../../service/notebooks";
import * as noteStore from "../../service/notes";
import { loadNotebookPageData } from "./page-data";
import { mockNoteTree } from "./page-tree.test-fixture";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Book",
  sn: "Reader",
  displayName: "Book Reader",
  mail: "reader@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
const timestamp = "2026-09-03T08:00:00.000Z";
const notebook = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "book01",
  name: "Handbook",
  description: null,
  icon: null,
  homepageNoteId: null,
  homepageNoteShortId: null,
  defaultPresentationMode: "write" as PresentationMode,
  noteDeletePermission: "write" as const,
  defaultNoteTitleTemplate: "Untitled",
  createdBy: user.id,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const note = {
  id: "33333333-3333-4333-8333-333333333333",
  shortId: "note01",
  notebookId: notebook.id,
  parentId: null,
  title: "Welcome",
  position: 0,
  hasChildren: false,
  historyIncomplete: false,
  yjsSnapshotAt: timestamp,
  contentMd: "# Welcome\n\nOur **handbook**.\n\n#team",
  yjsSnapshot: "collaboration-state-not-for-book",
  createdBy: user.id,
  createdAt: timestamp,
  updatedAt: timestamp,
  lockedAt: null as string | null,
};
const activeSpies: Array<{ mockRestore(): void }> = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
  activeSpies.push(spy);
  return spy;
};
afterEach(() => {
  for (const spy of activeSpies.splice(0)) spy.mockRestore();
});

function fixtures(permission: PermissionLevel, defaultPresentationMode: PresentationMode = "write", locked = false) {
  const currentNotebook = { ...notebook, defaultPresentationMode };
  const currentNote = { ...note, lockedAt: locked ? timestamp : null };
  track(spyOn(cloudServices, "get")).mockResolvedValue("https://cloud.example.test");
  track(spyOn(notebooksService.notebook, "getByShortId")).mockResolvedValue(currentNotebook);
  track(spyOn(notebooksService.notebook, "get")).mockResolvedValue(currentNotebook);
  track(spyOn(notebooksService.notebook.permission, "get")).mockResolvedValue(permission);
  track(spyOn(notebookStore, "canAccess")).mockResolvedValue(permission !== "none");
  track(spyOn(notebooksService.workspaceEvents, "latestCursor")).mockResolvedValue("1-0");
  for (const spy of mockNoteTree([{ ...currentNote, children: [] }])) track(spy);
  track(spyOn(notebooksService.note, "getByShortId")).mockResolvedValue(currentNote);
  track(spyOn(noteStore, "getWithContentByShortId")).mockResolvedValue(currentNote);
  track(spyOn(notebooksService.note, "getWithContentByShortId")).mockResolvedValue(currentNote);
  track(spyOn(notebooksService.activity, "noteAuthors")).mockResolvedValue({ createdBy: null, lastEditedBy: null });
  track(spyOn(notebooksService.attachment, "count")).mockResolvedValue(0);
  track(spyOn(notebooksService.tag, "listForNotebook")).mockResolvedValue([{ tag: "team", count: 1 }]);
  track(spyOn(notebooksService.note.favorites, "listIds")).mockResolvedValue([]);
  const backlinks = track(spyOn(notebooksService.note.backlinks, "list")).mockResolvedValue([]);
  const comments = track(spyOn(notebooksService.note.comments, "listPage")).mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    perPage: 30,
    hasNext: false,
  });
  const graph = track(spyOn(notebooksService.notebook, "graphView")).mockResolvedValue({ nodes: [], edges: [] });
  const versions = track(spyOn(notebooksService.note.versions, "list"));
  return { backlinks, comments, graph, versions };
}

async function requestPageData(
  mode?: string,
  path = "/app/notebooks/book01/notes/note01",
  actorUser: User = user,
  preferences: Record<string, unknown> = {},
) {
  const app = new Hono<AuthContext & { Variables: { page: { title?: string } } }>();
  let result: Awaited<ReturnType<typeof loadNotebookPageData>> | undefined;
  for (const route of ["/app/notebooks/:id", "/app/notebooks/:id/notes/:noteId"]) {
    app.get(route, async (c) => {
      c.set("actor", { kind: "user", user: actorUser });
      result = await loadNotebookPageData(c);
      return c.body(null, 204);
    });
  }
  const response = await app.request(`https://cloud.example.test${path}${mode ? `?mode=${mode}` : ""}`, {
    headers: { "Accept-Language": "de", cookie: `settings-app-notebooks=${encodeURIComponent(JSON.stringify(preferences))}` },
  });
  expect(response.status).toBe(204);
  if (!result) throw new Error("Expected page data");
  return result;
}

async function load(mode?: string, path?: string) {
  const result = await requestPageData(mode, path);
  if (result.kind !== "ok") throw new Error(`Expected page data, got ${result.kind}`);
  return result;
}

describe("notebook page presentation authorization", () => {
  test("the initial context reads the personal full-width cookie", async () => {
    fixtures("write");
    for (const preferences of [{}, { fullWidth: true }]) {
      const data = await requestPageData("write", undefined, user, preferences);
      if (data.kind !== "ok") throw new Error("Expected page data");
      expect(data.ctx.fullWidth).toBe(preferences.fullWidth === true);
    }
  });
  test("Book notes render inside the normal Cloud workspace shell", async () => {
    fixtures("read");
    track(stubRailSnapshot());
    await import("./_components/detail/ssr-test-plugin");
    const { default: handler } = await import("./page");
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("runtime", { apps: [] });
      await next();
    });
    app.get("/app/notebooks/:id/notes/:noteId", ...handler);
    const response = await app.request("https://cloud.example.test/app/notebooks/book01/notes/note01?mode=book");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-layout-authenticated="true"');
    expect(html).toContain("ShellRuntime");
    expect(html).toContain("layout-content-main");
    expect(html).toContain("notebook-book-workspace");
    expect(html).toContain("<strong>handbook</strong>");
    expect(html).not.toMatch(/NoteEditor|NotebookDetailPanel|collaboration-state-not-for-book/);
  });

  test("global administrators can render Book without a separate notebook grant", async () => {
    fixtures("none");
    const data = await requestPageData("book", undefined, { ...user, roles: ["admin"] });
    expect(data.kind).toBe("ok");
    if (data.kind !== "ok") throw new Error("Expected Book data");
    expect(data.permission).toBe("admin");
    expect(data.bookHtml).toContain("<strong>handbook</strong>");
    expect(data.ctx.presentationMode).toBe("book");
  });

  test("an explicit missing or cross-notebook link never falls back to another note", async () => {
    fixtures("read");
    track(spyOn(notebooksService.note, "getByShortId")).mockImplementation(async ({ shortId }) =>
      shortId === "note01" ? note : { ...note, shortId, notebookId: "44444444-4444-4444-8444-444444444444" },
    );
    expect(await requestPageData("book", "/app/notebooks/book01/notes/other1")).toEqual({ kind: "not_found" });
    track(spyOn(notebooksService.note, "getByShortId")).mockResolvedValue(null);
    expect(await requestPageData("book", "/app/notebooks/book01/notes/gone01")).toEqual({ kind: "not_found" });
  });

  for (const mode of ["book", "write"]) {
    test(`an explicit note removed after ID resolution returns not-found in ${mode}`, async () => {
      fixtures("write");
      track(spyOn(noteStore, "getWithContentByShortId")).mockResolvedValue(null);
      track(spyOn(notebooksService.note, "getWithContentByShortId")).mockResolvedValue(null);
      expect(await requestPageData(mode)).toEqual({ kind: "not_found" });
    });
  }

  for (const mode of [undefined, "write", "readonly", "versions", "book"]) {
    test(`read grants always load Book instead of ${mode ?? "the Write default"}`, async () => {
      const calls = fixtures("read");
      const data = await load(mode);
      expect(data.presentationMode).toBe("book");
      expect(data.isBookMode).toBe(true);
      expect(data.readonlyMode).toBe(true);
      expect(data.isGraphMode).toBe(false);
      expect(data.isVersionsMode).toBe(false);
      expect(data.showDetailPanel).toBe(false);
      expect(data.selectedRouteState).toBeNull();
      expect(data.selectedNote?.contentMd).toBeNull();
      expect(data.selectedNote?.yjsSnapshot).toBeNull();
      expect(data.bookHtml).toContain("<strong>handbook</strong>");
      expect(data.ctx.tags).toEqual([{ tag: "team", count: 1 }]);
      expect(data.initialCommentsPage).toBeNull();
      expect(calls.backlinks).not.toHaveBeenCalled();
      expect(calls.comments).not.toHaveBeenCalled();
      expect(calls.graph).not.toHaveBeenCalled();
      expect(calls.versions).not.toHaveBeenCalled();
    });
  }

  for (const permission of ["write", "admin"] as const) {
    for (const mode of ["book", "write", "readonly"] as const) {
      test(`${permission} honors the ${mode} notebook default`, async () => {
        fixtures(permission, mode);
        const data = await load();
        expect(data.presentationMode).toBe(mode);
        expect(data.isBookMode).toBe(mode === "book");
        expect(data.readonlyMode).toBe(mode !== "write");
        expect(data.showDetailPanel).toBe(mode !== "book");
        expect(data.selectedRouteState !== null).toBe(mode !== "book");
      });
    }
  }

  for (const mode of ["write", "readonly"] as const) {
    test(`an author's explicit ${mode} view overrides the Book default`, async () => {
      fixtures("write", "book");
      const data = await load(mode);
      expect(data.presentationMode).toBe(mode);
      expect(data.bookHtml).toBeNull();
      expect(data.showDetailPanel).toBe(true);
    });
  }

  test("an explicit Book view overrides the Write default", async () => {
    fixtures("admin", "write");
    const data = await load("book");
    expect(data.presentationMode).toBe("book");
    expect(data.selectedRouteState).toBeNull();
  });

  for (const [permission, opened] of [
    ["read", "note02"],
    ["write", "note02"],
  ] as const) {
    test(`without a start page, ${permission} access opens ${permission === "read" ? "Book at its first sidebar page" : "Write at the first workspace page"}`, async () => {
      fixtures(permission);
      // Both orders compare numbers in titles as numbers, so "Kapitel 2" comes before "Kapitel 10".
      const pages = [
        { ...note, id: "uuid-note01", shortId: "note01", title: "Kapitel 10" },
        { ...note, id: "uuid-note02", shortId: "note02", title: "Kapitel 2" },
      ];
      const byShortId = async ({ shortId }: { shortId: string }) => pages.find((page) => page.shortId === shortId) ?? null;
      for (const spy of mockNoteTree(pages.map((page) => ({ ...page, children: [] })))) track(spy);
      track(spyOn(noteStore, "getWithContentByShortId")).mockImplementation(byShortId);
      track(spyOn(notebooksService.note, "getWithContentByShortId")).mockImplementation(byShortId);
      expect(await requestPageData(undefined, "/app/notebooks/book01")).toEqual({
        kind: "redirect",
        href: `/app/notebooks/book01/notes/${opened}`,
      });
    });
  }

  test("a locked note downgrades explicit Write to the existing Read-only view", async () => {
    fixtures("admin", "book", true);
    const data = await load("write");
    expect(data.presentationMode).toBe("readonly");
    expect(data.readonlyMode).toBe(true);
    expect(data.isBookMode).toBe(false);
    expect(data.showDetailPanel).toBe(true);
  });
});

for (const [permission, query, shell, from] of [
  ["read", "graph", "book", "book"],
  ["read", "graph&from=write", "book", "book"],
  ["write", "graph", "workspace", undefined],
  ["write", "graph&from=book", "book", "book"],
  ["write", "graph&from=write", "workspace", "write"],
  ["write", "graph&from=readonly", "workspace", "readonly"],
  ["admin", "graph&from=other", "workspace", undefined],
] as const) {
  test(`${permission} graph (${query}) uses ${shell} with metadata only`, async () => {
    const calls = fixtures(permission);
    const content = track(spyOn(notebooksService.note, "getWithContentByShortId"));
    const bookContent = track(spyOn(noteStore, "getWithContentByShortId"));
    const data = await load(query, "/app/notebooks/book01");
    expect(data.isGraphMode).toBe(true);
    expect(data.isBookMode).toBe(false);
    expect(data.graphShell).toBe(shell);
    expect(data.graphFrom).toBe(from);
    expect(data.bookTree).toHaveLength(shell === "book" ? 1 : 0);
    expect(data.ctx.presentationMode).toBe(from);
    expect(data.selectedNote).toMatchObject({ id: "note01", title: "Welcome", contentMd: null, yjsSnapshot: null });
    expect(data.bookHtml).toBeNull();
    expect(data.selectedRouteState).toBeNull();
    expect(data.backlinks).toEqual([]);
    expect(data.tocItems).toEqual([]);
    expect(data.namedBlocks).toEqual([]);
    expect(data.initialCommentsPage).toBeNull();
    expect(data.showDetailPanel).toBe(false);
    expect(data.graph).toEqual({ nodes: [], edges: [] });
    expect(calls.graph).toHaveBeenCalledTimes(1);
    expect(calls.graph).toHaveBeenCalledWith({ notebookId: notebook.id, noteId: note.id });
    for (const call of [calls.backlinks, calls.comments, calls.versions, content, bookContent]) expect(call).not.toHaveBeenCalled();
  });
}

test("no grant denies graph before reading its data", async () => {
  const calls = fixtures("none");
  expect(await requestPageData("graph", "/app/notebooks/book01")).toEqual({ kind: "access_denied" });
  expect(calls.graph).not.toHaveBeenCalled();
});

for (const permission of ["read", "write"] as const) {
  for (const queryNote of ["note02", "foreign", "missing"]) {
    test(`${permission} graph note query ${queryNote} resolves before the notebook cookie`, async () => {
      fixtures(permission);
      track(spyOn(notebooksService.note, "getByShortId")).mockImplementation(async ({ shortId }) => {
        if (shortId === "missing") return null;
        return { ...note, shortId, notebookId: shortId === "foreign" ? "other-notebook" : notebook.id };
      });
      const data = await requestPageData(`graph&note=${queryNote}`, "/app/notebooks/book01", user, {
        notebooks: { book01: { lastNoteId: "note03" } },
      });
      expect(data.kind).toBe("ok");
      if (data.kind !== "ok") throw new Error("Expected graph data");
      // The cookie names a third note, so neither the first note nor the foreign query can pass for it.
      expect(data.selectedNoteId).toBe(queryNote === "note02" ? "note02" : "note03");
      expect(data.selectedNote?.id).toBe(data.selectedNoteId ?? undefined);
    });
  }
}

test("a graph path note wins over the query, and invalid paths never fall back", async () => {
  fixtures("read");
  track(spyOn(notebooksService.note, "getByShortId")).mockImplementation(async ({ shortId }) =>
    shortId === "note01" ? note : { ...note, shortId, notebookId: "other-notebook" },
  );
  const data = await load("graph&note=foreign");
  expect(data.selectedNote?.id).toBe("note01");
  expect(await requestPageData("graph&note=note01", "/app/notebooks/book01/notes/foreign")).toEqual({ kind: "not_found" });
});

for (const [permission, expected] of [
  ["read", "note02"],
  ["write", "note02"],
] as const) {
  test(`${permission} graph with a foreign query and no cookie starts at the shell's first note`, async () => {
    fixtures(permission);
    const pages = [
      { ...note, shortId: "note01", title: "Kapitel 10" },
      { ...note, id: "other-id", shortId: "note02", title: "Kapitel 2" },
    ];
    for (const spy of mockNoteTree(pages.map((page) => ({ ...page, children: [] })))) track(spy);
    track(spyOn(notebooksService.note, "getByShortId")).mockImplementation(
      async ({ shortId }) => pages.find((page) => page.shortId === shortId) ?? null,
    );
    const data = await load("graph&note=foreign", "/app/notebooks/book01");
    expect(data.selectedNote?.id).toBe(expected);
  });
}

test.each([
  "/app/notebooks/book01",
  "/app/notebooks/book01/tags/garden?mode=book&search=x&page=2",
  "/app/notebooks/book01/attachments?search=x&page=2#files",
])("graph keeps a same-notebook return path (%s), without the hash", async (back) => {
  fixtures("write");
  const data = await load(`graph&back=${encodeURIComponent(back)}`, "/app/notebooks/book01");
  expect(data.graphBack).toBe(back.split("#")[0]);
});

test.each([
  "//evil.example/x",
  "https://evil.example/app/notebooks/book01",
  "https://notebooks.invalid/app/notebooks/book01",
  "javascript:alert(1)",
  "/app/notebooks/other/notes/x",
  "/app/notebooksX",
  "/app/notebooks/book01other",
  "/app/notebooks/book01/../other",
  "/\\evil.example",
])("graph ignores an invalid return path (%s)", async (back) => {
  fixtures("write");
  expect((await load(`graph&back=${encodeURIComponent(back)}`, "/app/notebooks/book01")).graphBack).toBeUndefined();
});

test("return paths apply only to graph mode", async () => {
  fixtures("write");
  expect((await load(`readonly&back=${encodeURIComponent("/app/notebooks/book01/attachments")}`)).graphBack).toBeUndefined();
});

test("graph view state uses the shared URL parser", async () => {
  const calls = fixtures("write");
  const data = await load(
    "graph&view=favorites&display=network&list=1&links=unlinked&hide=top,zzzzzz,!bad&q=K%C3%BChl",
    "/app/notebooks/book01",
  );
  expect(data.graphView).toEqual({
    display: "network",
    sort: null,
    depth: 2,
    list: true,
    links: "unlinked",
    hide: ["top", "zzzzzz"],
    q: "Kühl",
  });
  expect(calls.graph).toHaveBeenCalledTimes(1);
});
