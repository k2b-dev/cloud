import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as cloudServices from "@k2b/cloud/services";
import * as layoutHelp from "@k2b/cloud/ssr/help";
import { Hono } from "hono";
import { fromJSON } from "seroval";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import type { PresentationMode } from "../../lib/presentation-mode";
import { notebooksService } from "../../service";
import * as notebookStore from "../../service/notebooks";
import * as noteStore from "../../service/notes";
import * as routeState from "../../service/route-state";
import { mockNoteTree } from "./page-tree.test-fixture";
import "./_components/detail/ssr-test-plugin";

const islandProps = (attribute: string | undefined) =>
  fromJSON<Record<string, unknown>>(
    JSON.parse((attribute ?? "").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")),
  );

const { default: handler } = await import("./page");
const { default: attachmentsHandler } = await import("./attachments/page");
const { default: tagHandler } = await import("./tags/[tag]/page");
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "writer",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Note",
  sn: "Writer",
  displayName: "Note Writer",
  mail: "writer@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
const noteAuthors = {
  createdBy: { kind: "user" as const, id: user.id, displayName: "Jana Berger", avatarHash: "avatar" },
  lastEditedBy: { kind: "user" as const, id: user.id, displayName: "Jana Berger", avatarHash: "avatar" },
};
const timestamp = "2026-09-27T08:00:00.000Z";
const notebook = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "book01",
  name: "Empty notebook",
  description: null,
  icon: null,
  homepageNoteId: null,
  homepageNoteShortId: null,
  defaultPresentationMode: "write" as const,
  noteDeletePermission: "write" as const,
  defaultNoteTitleTemplate: "Untitled",
  createdBy: user.id,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
let railSnapshot: ReturnType<typeof stubRailSnapshot>;
beforeEach(() => {
  railSnapshot = stubRailSnapshot();
  spies.push(spyOn(layoutHelp, "preloadLayoutHelp").mockResolvedValue(null));
});
afterEach(() => railSnapshot.mockRestore());

const renderEmptyNotebook = async (mode: "write" | "book" | "graph" | "graph&from=readonly", preferences: Record<string, unknown> = {}) => {
  spies.push(spyOn(cloudServices, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(notebooksService.notebook, "getByShortId").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook, "get").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook.permission, "get").mockResolvedValue("write"));
  spies.push(spyOn(notebooksService.workspaceEvents, "latestCursor").mockResolvedValue("1-0"));
  spies.push(...mockNoteTree([]));
  spies.push(spyOn(notebooksService.tag, "listForNotebook").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.note.favorites, "listIds").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.attachment, "count").mockResolvedValue(0));
  spies.push(spyOn(notebooksService.notebook, "graphView").mockResolvedValue({ nodes: [], edges: [] }));
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", {
      apps: [
        {
          id: "notebooks",
          name: "Notebooks",
          icon: "ti ti-notebook",
          description: "Fixture",
          routes: ["/app/notebooks"],
          panel: { href: "/app/notebooks/panel", label: "Notes", icon: "ti ti-notebook" },
        },
      ],
    });
    await next();
  });
  app.get("/app/notebooks/:id", ...handler);
  const response = await app.request(`https://cloud.example.test/app/notebooks/book01?mode=${mode}`, {
    headers: { "accept-language": "de", cookie: `settings-app-notebooks=${encodeURIComponent(JSON.stringify(preferences))}` },
  });
  expect(response.status).toBe(200);
  return response.text();
};

/** Attributes and text of every element that matches a selector in the server-rendered page. */
const select = async (html: string, selector: string) => {
  const found: { attributes: Record<string, string>; text: string }[] = [];
  await new HTMLRewriter()
    .on(selector, {
      element(element) {
        found.push({ attributes: Object.fromEntries(element.attributes), text: "" });
      },
      text(chunk) {
        const match = found.at(-1);
        if (match) match.text += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return found;
};

test("an empty notebook shows its sidebar placeholder as one line directly below the notes heading", async () => {
  const html = await renderEmptyNotebook("write");
  // The placeholder is the section's first child, where the first note row would be.
  const [placeholder, ...others] = await select(html, ".k2b-app-workspace__sidebar-section-content > .k2b-placeholder:first-child");

  expect(others).toEqual([]);
  expect(placeholder?.attributes["data-variant"]).toBe("inline");
  expect(placeholder?.attributes["data-align"]).toBe("left");
  expect(placeholder?.text).toBe("Noch keine Notizen");
  expect(await select(html, '[role="tree"]')).toEqual([]);
});

test("an empty notebook centers its main-area placeholder in the work area", async () => {
  const html = await renderEmptyNotebook("write");
  const [placeholder, ...others] = await select(html, ".k2b-app-workspace__main > .k2b-placeholder");

  expect(others).toEqual([]);
  expect(placeholder?.attributes["data-variant"]).toBe("panel");
  expect(placeholder?.attributes["data-align"]).toBe("center");
  expect(placeholder?.attributes.class?.split(/\s+/)).toContain("flex-1");
  expect(placeholder?.text).toBe("Noch keine Notizen");
});

test("an empty notebook with a hidden navigation offers a visible control that shows it again", async () => {
  const hidden = await renderEmptyNotebook("write", { navigationHidden: true });
  // No editor toolbar here, and the sidebar with the create button is hidden.
  const [show, ...others] = await select(hidden, 'button[aria-controls="notebook-navigation"]');
  expect(others).toEqual([]);
  expect(show?.attributes["aria-label"]).toBe("Navigation einblenden");
  expect(show?.attributes["aria-expanded"]).toBe("false");
  expect(show?.attributes.disabled).toBeUndefined();

  const visible = await renderEmptyNotebook("write");
  expect(await select(visible, '.k2b-icon-button[aria-controls="notebook-navigation"]:not([data-app-workspace-sidebar-toggle])')).toEqual(
    [],
  );
});

test("an empty book shows its sidebar placeholder as one line below the pages heading", async () => {
  const html = await renderEmptyNotebook("book");
  const [placeholder, ...others] = await select(html, ".k2b-app-workspace__sidebar-section-content > .k2b-placeholder");

  expect(others).toEqual([]);
  expect(placeholder?.attributes["data-variant"]).toBe("inline");
  expect(placeholder?.attributes["data-align"]).toBe("left");
  expect(placeholder?.text).toBe("Noch keine Seiten");
  // Screen readers get the empty line, not an empty tree next to it.
  expect(await select(html, '[role="tree"]')).toEqual([]);
});

const renderBookPage = async (preferences: Record<string, unknown> = {}) => {
  const page = (shortId: string, title: string, parentId: string | null = null) => ({
    id: `uuid-${shortId}`,
    shortId,
    notebookId: notebook.id,
    parentId,
    title,
    position: 0,
    hasChildren: false,
    historyIncomplete: false,
    yjsSnapshotAt: null,
    contentMd: `# ${title}`,
    yjsSnapshot: null,
    createdBy: user.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    lockedAt: null,
  });
  const home = page("note04", "Überblick", "uuid-note03");
  const withHome = { ...notebook, homepageNoteId: home.id, homepageNoteShortId: home.shortId };
  spies.push(spyOn(cloudServices, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(notebooksService.notebook, "getByShortId").mockResolvedValue(withHome));
  spies.push(spyOn(notebooksService.notebook, "get").mockResolvedValue(withHome));
  spies.push(spyOn(notebooksService.notebook.permission, "get").mockResolvedValue("read"));
  spies.push(spyOn(notebookStore, "canAccess").mockResolvedValue(true));
  spies.push(spyOn(notebooksService.workspaceEvents, "latestCursor").mockResolvedValue("1-0"));
  spies.push(
    ...mockNoteTree([
      { ...page("note02", "Kapitel 10"), children: [] },
      { ...page("note03", "Kapitel 2"), hasChildren: true, children: [{ ...home, children: [] }] },
      { ...page("note01", "Anhang"), children: [] },
    ]),
  );
  spies.push(spyOn(notebooksService.note, "getByShortId").mockResolvedValue(home));
  spies.push(spyOn(noteStore, "getWithContentByShortId").mockResolvedValue(home));
  spies.push(spyOn(notebooksService.tag, "listForNotebook").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.note.favorites, "listIds").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.attachment, "count").mockResolvedValue(0));
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/notebooks/:id/notes/:noteId", ...handler);
  const response = await app.request("https://cloud.example.test/app/notebooks/book01/notes/note04?mode=book", {
    headers: { "accept-language": "de", cookie: `settings-app-notebooks=${encodeURIComponent(JSON.stringify(preferences))}` },
  });
  expect(response.status).toBe(200);
  return response.text();
};

test("a book page is server-rendered with the start page first and the other pages by title", async () => {
  const rows = await select(await renderBookPage(), '[role="tree"] [data-k2b-nav-tree-id]');

  // The start page lives below "Kapitel 2" and is still the first row, listed once.
  expect(rows.map((row) => row.attributes["data-k2b-nav-tree-id"])).toEqual(["note04", "note01", "note03", "note02"]);
});

test("a book page with a hidden navigation is server-rendered without its contents list", async () => {
  const html = await renderBookPage({ navigationHidden: true });
  const [sidebar, ...others] = await select(html, "aside.k2b-app-workspace__sidebar");

  expect(others).toEqual([]);
  expect(sidebar?.attributes.id).toBe("notebook-navigation");
  expect(sidebar?.attributes.hidden).toBeDefined();
  expect(await select(html, "aside.k2b-app-workspace__sidebar *")).toEqual([]);
  expect(await select(html, '[role="tree"]')).toEqual([]);
  expect(await select(html, '[data-app-workspace-resize="sidebar"]')).toEqual([]);
  // The page itself stays readable, and Book view has no editor toolbar, so it offers the show control.
  const [article] = await select(html, "#notebook-book-content h1");
  expect(article?.text).toBe("Überblick");
  expect((await select(html, 'button[aria-controls="notebook-navigation"]')).map((button) => button.attributes["aria-label"])).toEqual([
    "Navigation einblenden",
  ]);
  // Phones keep the contents in the header menu.
  expect(html).toContain("data-cloud-workspace-navigation");

  const visible = await renderBookPage({ navigationHidden: false });
  expect(await select(visible, '[role="tree"] [data-k2b-nav-tree-id]')).toHaveLength(4);
  expect(await select(visible, '.k2b-icon-button[aria-controls="notebook-navigation"]:not([data-app-workspace-sidebar-toggle])')).toEqual(
    [],
  );
});

test.each(["write", "book"] as const)(
  "a notebook shown in %s mode records itself as the notebook the Notebooks entry opens next",
  async (mode) => {
    const html = await renderEmptyNotebook(mode);
    const [island, ...others] = await select(html, 'solid-island[data-file="RememberNotebook.island.tsx"]');

    expect(others).toEqual([]);
    expect(islandProps(island?.attributes["data-props"])).toEqual({ notebookId: "book01" });
  },
);

test.each([
  ["attachments", "/app/notebooks/:id/attachments", "/app/notebooks/book01/attachments?search=x&page=2", attachmentsHandler, false],
  ["tag", "/app/notebooks/:id/tags/:tag", "/app/notebooks/book01/tags/ideas?search=x&page=2", tagHandler, false],
  ["book-mode tag", "/app/notebooks/:id/tags/:tag", "/app/notebooks/book01/tags/ideas?mode=book&search=x&page=2", tagHandler, true],
] as const)("the %s page of a notebook also records the notebook", async (_name, route, path, pageHandler, bookMode) => {
  spies.push(spyOn(cloudServices, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(notebooksService.notebook, "getByShortId").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook, "get").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook.permission, "get").mockResolvedValue("write"));
  spies.push(spyOn(notebooksService.workspaceEvents, "latestCursor").mockResolvedValue("1-0"));
  spies.push(...mockNoteTree([]));
  spies.push(spyOn(notebooksService.tag, "listForNotebook").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.tag, "listNotesForTag").mockResolvedValue({ items: [], total: 0 }));
  spies.push(spyOn(notebooksService.tag, "countNotesForTag").mockResolvedValue(0));
  spies.push(spyOn(notebooksService.note.favorites, "listIds").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.attachment, "count").mockResolvedValue(0));
  spies.push(
    spyOn(notebooksService.attachment, "listPaginated").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 200, hasNext: false }),
  );
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get(route, ...pageHandler);
  const response = await app.request(`https://cloud.example.test${path}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(await select(html, 'solid-island[data-file="BookController.island.tsx"]')).toHaveLength(bookMode ? 1 : 0);
  const [island, ...others] = await select(html, 'solid-island[data-file="RememberNotebook.island.tsx"]');

  expect(others).toEqual([]);
  expect(islandProps(island?.attributes["data-props"])).toEqual({ notebookId: "book01" });
  const [links] = await select(html, ".notebook-sidebar-foot a");
  expect(links?.attributes.href).toBe(
    `/app/notebooks/book01?mode=graph${bookMode ? "&amp;from=book" : ""}&amp;back=${encodeURIComponent(path)}`,
  );
});

const renderNotebookWithNotes = async (
  preferences: Record<string, unknown>,
  mode: "graph" | "write" | "readonly" = "graph",
  query = "",
) => {
  const note = (shortId: string, title: string) => ({
    id: `uuid-${shortId}`,
    shortId,
    notebookId: notebook.id,
    parentId: null,
    title,
    position: 0,
    hasChildren: false,
    historyIncomplete: false,
    yjsSnapshotAt: null,
    contentMd: `# ${title}`,
    yjsSnapshot: null,
    createdBy: user.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    lockedAt: null,
    children: [],
  });
  spies.push(spyOn(cloudServices, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(notebooksService.notebook, "getByShortId").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook, "get").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook.permission, "get").mockResolvedValue("write"));
  spies.push(spyOn(notebooksService.workspaceEvents, "latestCursor").mockResolvedValue("1-0"));
  spies.push(...mockNoteTree([note("note01", "Private folder"), note("note02", "Team notes")]));
  spies.push(
    spyOn(notebooksService.notebook, "graphView").mockResolvedValue(
      query
        ? {
            nodes: ["note01", "note02"].map((id, position) => ({
              id,
              title: id === "note01" ? "Private folder" : "Team notes",
              parentId: null,
              position,
              inDegree: position,
              updatedAt: timestamp,
            })),
            edges: [{ source: "note01", target: "note02" }],
          }
        : { nodes: [], edges: [] },
    ),
  );
  spies.push(spyOn(routeState, "loadSelectedNoteRouteState").mockResolvedValue(null));
  spies.push(spyOn(notebooksService.tag, "listForNotebook").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.note.favorites, "listIds").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.attachment, "count").mockResolvedValue(0));
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  spies.push(
    spyOn(notebooksService.note, "getByShortId").mockImplementation(async ({ shortId }) =>
      shortId === "other1"
        ? { ...note(shortId, "Foreign note"), notebookId: "other-notebook" }
        : shortId === "note01"
          ? note(shortId, "Private folder")
          : shortId === "note02"
            ? note(shortId, "Team notes")
            : null,
    ),
  );
  if (mode !== "graph") {
    spies.push(
      spyOn(routeState, "loadSelectedNoteRouteState").mockResolvedValue({
        note: { ...note("note01", "Private folder"), id: "note01", yjsSnapshot: null },
        noteAuthors,
        readonlyMode: mode === "readonly",
        tocItems: [],
        namedBlocks: [],
        taskProgress: { done: 0, total: 0 },
        panelAttachments: [],
        backlinks: [],
      }),
    );
    spies.push(
      spyOn(notebooksService.note.comments, "listPage").mockResolvedValue({ items: [], page: 1, perPage: 30, total: 0, hasNext: false }),
    );
  }
  app.get("/app/notebooks/:id/notes/:noteId", ...handler);
  app.get("/app/notebooks/:id", ...handler);
  // The graph view keeps the notebook route without redirecting to a note.
  const response = await app.request(
    `https://cloud.example.test/app/notebooks/book01${mode === "graph" ? "" : "/notes/note01"}?mode=${mode}${query}`,
    {
      headers: {
        "accept-language": "de",
        cookie: `settings-app-notebooks=${encodeURIComponent(JSON.stringify(preferences))}`,
      },
    },
  );
  expect(response.status).toBe(200);
  return response.text();
};

test("a hidden navigation is server-rendered without the note tree", async () => {
  // A cookie from the former Navigator layout renders the one sidebar.
  const html = await renderNotebookWithNotes({ sidebarMode: "navigator", navigationHidden: true });
  const [sidebar, ...others] = await select(html, "aside.k2b-app-workspace__sidebar");

  expect(others).toEqual([]);
  expect(sidebar?.attributes.id).toBe("notebook-navigation");
  expect(sidebar?.attributes.hidden).toBeDefined();
  expect(sidebar?.text).toBe("");
  expect(await select(html, "aside.k2b-app-workspace__sidebar *")).toEqual([]);
  expect(await select(html, '[data-app-workspace-resize="sidebar"]')).toEqual([]);
  expect(await select(html, "[data-workspace-main-region=notebook-notes]")).toEqual([]);
  // The graph's own toolbar offers the show control, so the sidebar adds none in a corner.
  expect((await select(html, 'button[aria-controls="notebook-navigation"]')).map((button) => button.attributes["aria-label"])).toEqual([
    "Navigation einblenden",
  ]);
});

test("a visible navigation is server-rendered with its one sidebar and note tree, also for a former Navigator layout", async () => {
  for (const preferences of [{}, { sidebarMode: "navigator" }]) {
    const html = await renderNotebookWithNotes(preferences);
    const [sidebar] = await select(html, "aside.k2b-app-workspace__sidebar");
    expect(sidebar?.attributes.hidden).toBeUndefined();
    expect(sidebar?.text).toContain("Private folder");
    expect(sidebar?.text).toContain("Notizen durchsuchen");
    expect(sidebar?.text).toContain("Favoriten");
    expect(sidebar?.text).toContain("Zuletzt");
    expect(await select(html, '[data-app-workspace-resize="sidebar"]')).toHaveLength(1);
    // No second column lists the notes again.
    expect(await select(html, "[data-workspace-main-region=notebook-notes]")).toEqual([]);
  }
});

const previewMarkdown = "# Wochenplan\n\nWir sammeln **wichtige** Gedanken für das Team.\n";
const renderEditorPage = async (
  options: {
    mode?: "write" | "readonly" | "versions" | "graph";
    richMode?: "rich" | "source";
    markdown?: string | null;
    snapshot?: string | null;
    locked?: boolean;
    historyIncomplete?: boolean;
  } = {},
) => {
  const note = {
    id: "uuid-note01",
    shortId: "note01",
    notebookId: notebook.id,
    parentId: null,
    title: "Wochenplan",
    position: 0,
    hasChildren: false,
    historyIncomplete: options.historyIncomplete ?? false,
    yjsSnapshotAt: timestamp,
    contentMd: options.markdown === undefined ? previewMarkdown : options.markdown,
    yjsSnapshot: options.snapshot === undefined ? "c25hcHNob3Q=" : options.snapshot,
    createdBy: user.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    lockedAt: options.locked ? timestamp : null,
  };
  spies.push(spyOn(cloudServices, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(notebooksService.notebook, "getByShortId").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook, "get").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook.permission, "get").mockResolvedValue("write"));
  spies.push(spyOn(notebooksService.workspaceEvents, "latestCursor").mockResolvedValue("1-0"));
  spies.push(...mockNoteTree([{ ...note, children: [] }]));
  spies.push(spyOn(notebooksService.note, "getByShortId").mockResolvedValue(note));
  spies.push(spyOn(notebooksService.tag, "listForNotebook").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.note.favorites, "listIds").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.attachment, "count").mockResolvedValue(0));
  spies.push(spyOn(notebooksService.notebook, "graphView").mockResolvedValue({ nodes: [], edges: [] }));
  spies.push(spyOn(notebooksService.note.versions, "list").mockRejectedValue(new Error("No saved versions in this fixture")));
  spies.push(
    spyOn(notebooksService.note.comments, "listPage").mockResolvedValue({ items: [], page: 1, perPage: 30, total: 0, hasNext: false }),
  );
  spies.push(
    spyOn(routeState, "loadSelectedNoteRouteState").mockResolvedValue({
      note: { ...note, id: note.shortId },
      noteAuthors,
      readonlyMode: !!options.locked,
      tocItems: [],
      taskProgress: { done: 0, total: 0 },
      namedBlocks: [],
      backlinks: [],
      panelAttachments: [],
    }),
  );
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/notebooks/:id/notes/:noteId", ...handler);
  const preferences = { notebooks: { book01: { richMode: options.richMode ?? "rich" } } };
  const response = await app.request(`https://cloud.example.test/app/notebooks/book01/notes/note01?mode=${options.mode ?? "write"}`, {
    headers: { "accept-language": "de", cookie: `settings-app-notebooks=${encodeURIComponent(JSON.stringify(preferences))}` },
  });
  expect(response.status).toBe(200);
  return response.text();
};

test("a saved writable note has readable server text before its editor mounts", async () => {
  const html = await renderEditorPage();
  const [preview] = await select(html, "#notebook-note-preview");
  expect(preview?.attributes["data-mode"]).toBe("rich");
  expect(preview?.text).toContain("Wochenplan");
  expect(preview?.text).toContain("Wir sammeln wichtige Gedanken für das Team.");
  expect(preview?.text).not.toContain("**");
  const rows = await select(html, "#notebook-note-preview .notebook-note-preview__line");
  expect(rows[0]?.text).toBe("# Wochenplan");
  expect(await select(html, "#notebook-note-preview .notebook-note-preview__strong")).toHaveLength(1);
  expect(await select(html, "#notebook-note-preview [class^=cm-]")).toEqual([]);
});

test.each([{ mode: "readonly" as const }, { locked: true }])(
  "read-only and locked notes keep their server preview (%j)",
  async (options) => {
    const [preview] = await select(await renderEditorPage(options), "#notebook-note-preview");
    expect(preview?.text).toContain("Wochenplan");
  },
);

test.each(["versions", "graph"] as const)("%s mode has no note preview", async (mode) => {
  const html = await renderEditorPage({ mode });
  expect(await select(html, "#notebook-note-preview")).toEqual([]);
  expect(await select(html, 'solid-client[data-file="NoteEditor.client.tsx"]')).toEqual([]);
});

test("Links from version history returns to version history", async () => {
  const html = await renderEditorPage({ mode: "versions" });
  const [links] = await select(html, ".notebook-sidebar-foot a");
  const back = encodeURIComponent("/app/notebooks/book01/notes/note01?mode=versions");
  expect(links?.attributes.href).toBe(`/app/notebooks/book01?mode=graph&amp;note=note01&amp;back=${back}`);
});

test("source mode includes line numbers and the literal Markdown markers", async () => {
  const html = await renderEditorPage({ richMode: "source" });
  const [preview] = await select(html, "#notebook-note-preview");
  expect(preview?.attributes["data-mode"]).toBe("source");
  const rows = await select(html, "#notebook-note-preview .notebook-note-preview__line");
  expect(rows.map((row) => row.text)).toEqual(previewMarkdown.split("\n"));
  const numbers = await select(html, "#notebook-note-preview .notebook-note-preview__number");
  // The hidden spacer first, sized for the last line number like CodeMirror's gutter.
  expect(numbers.map((row) => row.text)).toEqual(["9", "1", "2", "3", "4"]);
  expect(numbers.every((row) => row.attributes["aria-hidden"] === "true")).toBe(true);
});

test("source preview escapes HTML as readable text instead of creating elements", async () => {
  const markdown = "<script>alert(1)</script>\n<img src=x onerror=alert(1)>";
  const html = await renderEditorPage({ richMode: "source", markdown });
  const rows = await select(html, "#notebook-note-preview .notebook-note-preview__line");
  expect(rows.map((row) => row.text)).toEqual(["&lt;script>alert(1)&lt;/script>", "&lt;img src=x onerror=alert(1)>"]);
  expect(await select(html, "#notebook-note-preview script, #notebook-note-preview img")).toEqual([]);
});

test("write mode without a snapshot starts with an empty preview, matching the editor", async () => {
  const html = await renderEditorPage({ snapshot: null });
  expect((await select(html, "#notebook-note-preview .notebook-note-preview__line")).map((row) => row.text)).toEqual([""]);
  expect(await select(html, "#notebook-note-preview .notebook-note-preview__line br")).toHaveLength(1);
});

test("read-only without a snapshot starts from the saved Markdown", async () => {
  const html = await renderEditorPage({ mode: "readonly", snapshot: null });
  expect((await select(html, "#notebook-note-preview"))[0]?.text).toContain("Wir sammeln wichtige Gedanken für das Team.");
  const [editor] = await select(html, 'solid-client[data-file="NoteEditor.client.tsx"]');
  expect(islandProps(editor?.attributes["data-props"]).initialContent).toStartWith("# Wochenplan");
});

test("write mode sends no duplicate initialContent in the editor props", async () => {
  const [editor] = await select(await renderEditorPage(), 'solid-client[data-file="NoteEditor.client.tsx"]');
  const props = islandProps(editor?.attributes["data-props"]);
  expect(props.initialContent).toBeNull();
  expect(props.initialDetail).toHaveProperty("contentMd");
});

test("the preview shares the incomplete-history notice with the editor", async () => {
  const html = await renderEditorPage({ historyIncomplete: true });
  const [notice] = await select(html, '#notebook-note-preview [role="status"]');
  expect(notice?.text).toContain("Einige Änderungen der Notiz konnten nicht wiederhergestellt werden");
});

test("a long note ends at the preview budget, and source mode keeps the gutter of its last line", async () => {
  const markdown = Array.from({ length: 2000 }, (_, index) => `Paragraph ${index} with ordinary prose.`).join("\n\n");
  for (const richMode of ["rich", "source"] as const) {
    const html = await renderEditorPage({ markdown, richMode });
    const [preview] = await select(html, "#notebook-note-preview");
    expect(preview?.text).toContain("Paragraph 80 with ordinary prose.");
    expect(preview?.text).not.toContain("Paragraph 81 with ordinary prose.");
    expect(await select(html, "#notebook-note-preview .notebook-note-preview__line")).toHaveLength(162);
    const [spacer] = await select(html, "#notebook-note-preview .notebook-note-preview__spacer");
    expect(spacer?.text).toBe(richMode === "source" ? "9999" : undefined);
  }
});

test("null saved text keeps the editor's single empty line", async () => {
  const html = await renderEditorPage({ mode: "readonly", markdown: null, snapshot: null });
  expect((await select(html, "#notebook-note-preview .notebook-note-preview__line")).map((row) => row.text)).toEqual([""]);
  expect(await select(html, "#notebook-note-preview .notebook-note-preview__line br")).toHaveLength(1);
});

for (const mode of ["write", "readonly"] as const) {
  test(`${mode}: the first HTML renders full width and seeds Ansicht from the cookie`, async () => {
    for (const fullWidth of [false, true]) {
      const html = await renderNotebookWithNotes(fullWidth ? { fullWidth: true } : {}, mode);
      const surfaces = await select(html, ".notebook-document-surface");
      expect(surfaces).toHaveLength(1);
      expect(surfaces[0]?.attributes["data-full-width"]).toBe(fullWidth ? "" : undefined);
      const [panel] = await select(html, 'solid-island[data-file="NotebookDetailPanel.island.tsx"]');
      expect(islandProps(panel?.attributes["data-props"]).fullWidth).toBe(fullWidth);
      expect(await select(html, ".notebook-view-menu__trigger")).toHaveLength(1);
      expect(await select(html, '.notebooks-full-width-option input[role="switch"]')).toHaveLength(0);
    }
  });
}

test("Book renders the full-width attribute in its first HTML", async () => {
  for (const fullWidth of [false, true]) {
    const surfaces = await select(await renderBookPage(fullWidth ? { fullWidth: true } : {}), ".notebook-document-surface");
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.attributes["data-full-width"]).toBe(fullWidth ? "" : undefined);
  }
});

const renderLinkedNotebook = async (
  permission: "read" | "write",
  query: string,
  locale = "en",
  defaultPresentationMode: PresentationMode = "write",
  scope?: { around: string; total: number },
) => {
  const linkedNotebook = { ...notebook, defaultPresentationMode };
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
    contentMd: "# Welcome\n\nPrivate note body.",
    createdBy: user.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    lockedAt: null,
  };
  spies.push(spyOn(cloudServices, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(notebooksService.notebook, "getByShortId").mockResolvedValue(linkedNotebook));
  spies.push(spyOn(notebooksService.notebook, "get").mockResolvedValue(linkedNotebook));
  spies.push(spyOn(notebooksService.notebook.permission, "get").mockResolvedValue(permission));
  spies.push(spyOn(notebookStore, "canAccess").mockResolvedValue(true));
  spies.push(spyOn(notebooksService.workspaceEvents, "latestCursor").mockResolvedValue("1-0"));
  spies.push(...mockNoteTree([{ ...note, children: [] }]));
  spies.push(spyOn(notebooksService.note, "getByShortId").mockResolvedValue(note));
  spies.push(spyOn(noteStore, "getWithContentByShortId").mockResolvedValue({ ...note, yjsSnapshot: null }));
  spies.push(spyOn(notebooksService.tag, "listForNotebook").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.note.favorites, "listIds").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.attachment, "count").mockResolvedValue(0));
  spies.push(
    spyOn(notebooksService.notebook, "graphView").mockResolvedValue({
      nodes: [{ id: "note01", title: "Welcome", inDegree: 0, parentId: null, position: 0, updatedAt: timestamp }],
      edges: [],
      ...(scope ? { scope } : {}),
    }),
  );
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/notebooks/:id", ...handler);
  app.get("/app/notebooks/:id/notes/:noteId", ...handler);
  const path = query === "book" ? "/app/notebooks/book01/notes/note01?mode=book" : `/app/notebooks/book01?mode=${query}&note=note01`;
  const response = await app.request(`https://cloud.example.test${path}`, { headers: { "accept-language": locale } });
  expect(response.status).toBe(200);
  return response.text();
};

for (const [locale, line] of [
  ["en", "This notebook has 20,000 pages. The graph shows the 1 around “Welcome”"],
  ["de", "Dieses Notizbuch hat 20.000 Seiten. Der Graph zeigt die 1 rund um „Welcome“"],
]) {
  test(`a large notebook's graph says from its first paint that it shows the pages around one page (${locale})`, async () => {
    const html = await renderLinkedNotebook("write", "graph", locale, "write", { around: "note01", total: 20_000 });
    const [scope] = await select(html, ".notebook-graph__scope");
    expect(scope?.attributes.role).toBe("note");
    expect(scope?.text).toContain(line);
    expect(await select(await renderLinkedNotebook("write", "graph", locale), ".notebook-graph__scope")).toHaveLength(0);
  });
}

for (const [locale, label] of [
  ["en", "Links"],
  ["de", "Verknüpfungen"],
]) {
  test(`reader graph renders the Book navigation and origin (${locale})`, async () => {
    const html = await renderLinkedNotebook("read", "graph", locale);
    expect(html).toContain("notebook-book-workspace");
    expect(html).not.toContain("Private note body.");
    expect(html).not.toContain("notebook-book-content");
    const rows = await select(html, ".notebook-book-workspace .notebook-sidebar-foot .k2b-app-workspace__sidebar-item");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text.trim()).toBe(label!);
    expect(rows[0]?.attributes["aria-current"]).toBe("page");
    expect(rows[0]?.attributes.href).toBe("/app/notebooks/book01?mode=graph&amp;note=note01&amp;from=book");
    expect(html).toContain('href="/app/notebooks/book01?mode=graph&amp;note=note01&amp;from=book"');
    const snapshot = JSON.parse((await select(html, "script[data-cloud-workspace-navigation]"))[0]!.text);
    expect(snapshot.items.find((item: { id: string }) => item.id === "graph")).toMatchObject({ active: true });
    expect(snapshot.items.some((item: { id: string }) => ["attachments", "settings"].includes(item.id))).toBe(false);
    const close = await select(html, 'a[href="/app/notebooks/book01/notes/note01?mode=book"]');
    expect(close.some((item) => item.attributes["aria-label"] === (locale === "de" ? "Graph schließen" : "Close graph"))).toBe(true);
    expect(await select(html, '[role="tree"] [aria-current="page"]')).toEqual([]);
    // Like Book, the reading graph follows revoked access and ended sessions.
    expect(await select(html, 'solid-island[data-file="WorkspaceEventBridge.island.tsx"]')).toHaveLength(1);
    expect(await select(html, 'solid-island[data-file="BookGraphLive.island.tsx"]')).toHaveLength(1);
  });

  test(`reader Book note has a Links footer that is not current (${locale})`, async () => {
    const html = await renderLinkedNotebook("read", "book", locale);
    const rows = await select(html, ".notebook-sidebar-foot .k2b-app-workspace__sidebar-item");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text.trim()).toBe(label!);
    expect(rows[0]?.attributes["aria-current"]).toBeUndefined();
    // Links carries the page it opened from, so Close returns to it.
    expect(rows[0]?.attributes.href).toBe(
      `/app/notebooks/book01?mode=graph&amp;note=note01&amp;from=book&amp;back=${encodeURIComponent("/app/notebooks/book01/notes/note01?mode=book")}`,
    );
  });
}

test("writer graph marks Links current in the workspace footer and phone navigation", async () => {
  const html = await renderLinkedNotebook("write", "graph");
  expect(html).not.toContain("notebook-book-workspace");
  const rows = await select(html, ".notebook-sidebar-foot .k2b-app-workspace__sidebar-item");
  expect(rows.map((item) => item.text.trim())).toEqual(["Links", "Attachments", "Settings"]);
  expect(rows[0]?.attributes["aria-current"]).toBe("page");
  expect(rows[1]?.attributes["aria-current"]).toBeUndefined();
  expect(rows[0]?.attributes.href).toBe(
    `/app/notebooks/book01?mode=graph&amp;note=note01&amp;back=${encodeURIComponent("/app/notebooks/book01/notes/note01")}`,
  );
  const snapshot = JSON.parse((await select(html, "script[data-cloud-workspace-navigation]"))[0]!.text);
  expect(snapshot.items.find((item: { id: string }) => item.id === "graph")).toMatchObject({ active: true });
  const close = await select(html, 'a[aria-label="Close graph"]');
  expect(close[0]?.attributes.href).toBe("/app/notebooks/book01/notes/note01");
  expect(await select(html, '[role="tree"] [aria-current="page"]')).toEqual([]);
});

test("writer graph from Book keeps Write pointed at the selected note", async () => {
  const html = await renderLinkedNotebook("write", "graph&from=book");
  expect(html).toContain("notebook-book-workspace");
  expect((await select(html, '#notebook-navigation a[href="/app/notebooks/book01/notes/note01?mode=write"]'))[0]?.text).toBe("Write");
  expect((await select(html, 'a[aria-label="Close graph"]'))[0]?.attributes.href).toBe("/app/notebooks/book01/notes/note01?mode=book");
});

test.each(["write", "readonly"] as const)("writer graph preserves %s origin over the Book default", async (mode) => {
  const html = await renderLinkedNotebook("write", `graph&from=${mode}`, "en", "book");
  expect(html).not.toContain("notebook-book-workspace");
  const rows = await select(html, ".notebook-sidebar-foot .k2b-app-workspace__sidebar-item");
  expect(rows[0]?.text.trim()).toBe("Links");
  expect(rows[0]?.attributes.href).toBe(
    `/app/notebooks/book01?mode=graph&amp;note=note01&amp;from=${mode}&amp;back=${encodeURIComponent(`/app/notebooks/book01/notes/note01?mode=${mode}`)}`,
  );
  expect(rows[1]?.attributes.href).toBe(`/app/notebooks/book01/attachments?mode=${mode}`);
  expect((await select(html, 'a[aria-label="Close graph"]'))[0]?.attributes.href).toBe(`/app/notebooks/book01/notes/note01?mode=${mode}`);
  expect(await select(html, `[role="tree"] a[href="/app/notebooks/book01/notes/note01?mode=${mode}"]`)).toHaveLength(1);
});

test("an empty notebook's graph still offers Close back to the notebook", async () => {
  const html = await renderEmptyNotebook("graph");
  expect(html).toContain("Dieses Notizbuch hat noch keine Notizen.");
  // The graph toolbar renders Close twice: a back chevron on phones and a close button from md up.
  const close = await select(html, 'a[aria-label="Graph schließen"]');
  expect(close.map((item) => item.attributes.href)).toEqual(["/app/notebooks/book01", "/app/notebooks/book01"]);
});

test("an empty graph preserves the Read-only origin when closing to the notebook", async () => {
  const html = await renderEmptyNotebook("graph&from=readonly");
  const close = await select(html, 'a[aria-label="Graph schließen"]');
  expect(close.map((item) => item.attributes.href)).toEqual(["/app/notebooks/book01?mode=readonly", "/app/notebooks/book01?mode=readonly"]);
});

for (const permission of ["write", "read"] as const) {
  test(`${permission} graph Close and Links preserve a return page with its query`, async () => {
    const back = `/app/notebooks/book01/${permission === "read" ? "tags/garden?mode=book&search=x&page=2" : "attachments?search=x&page=2"}`;
    const html = await renderLinkedNotebook(permission, `graph&back=${encodeURIComponent(back)}`);
    expect((await select(html, 'a[aria-label="Close graph"]'))[0]?.attributes.href).toBe(back.replaceAll("&", "&amp;"));
    const rows = await select(html, ".notebook-sidebar-foot .k2b-app-workspace__sidebar-item");
    const href = `/app/notebooks/book01?mode=graph&note=note01${permission === "read" ? "&from=book" : ""}&back=${encodeURIComponent(back)}`;
    expect(rows[0]?.attributes.href).toBe(href.replaceAll("&", "&amp;"));
    const navigation: { items: { id: string; href?: string }[] } = JSON.parse(
      (await select(html, "script[data-cloud-workspace-navigation]"))[0]!.text,
    );
    expect(navigation.items.find((item) => item.id === "graph")?.href).toBe(href);
  });
}

test.each(["write", "readonly"] as const)("%s: SSR supplies author identities to the panel", async (mode) => {
  const html = await renderEditorPage({ mode });
  const [panel] = await select(html, '[data-file="NotebookDetailPanel.island.tsx"]');
  expect(panel).toBeDefined();
  const props = islandProps(panel?.attributes["data-props"]);
  expect(props.noteAuthors).toEqual(noteAuthors);
  const [editor] = await select(html, 'solid-client[data-file="NoteEditor.client.tsx"]');
  expect(islandProps(editor?.attributes["data-props"]).initialDetail).toHaveProperty("noteAuthors", noteAuthors);
});

test.each(["note02", "other1"])(
  "Neighborhood serializes the query centre before the cookie, with foreign-note fallback (%s)",
  async (queryNote) => {
    const html = await renderNotebookWithNotes(
      { notebooks: { book01: { lastNoteId: "note01" } } },
      "graph",
      `&display=neighborhood&note=${queryNote}`,
    );
    const [island] = await select(html, 'solid-island[data-file="NotebookGraph.island.tsx"]');
    expect(island).toBeDefined();
    const props = islandProps(island?.attributes["data-props"]);
    expect(props.selectedNoteId).toBe(queryNote === "note02" ? "note02" : "note01");
    expect(props.view).toMatchObject({ display: "neighborhood", depth: 2, sort: null });
    expect(props.timeZone).toBe("UTC");
    const [title] = await select(html, ".notebook-graph__title small");
    expect(title?.text).toContain(`von „${queryNote === "note02" ? "Team notes" : "Private folder"}“`);
    expect(html).not.toContain("Foreign note");
  },
);

for (const mode of ["write", "book", "graph", "graph&from=readonly"] as const)
  test(`${mode} notebook page reports the public notebook scope in shell data`, async () => {
    const html = await renderEmptyNotebook(mode);
    const shell = JSON.parse(html.match(/id="cloud-shell-data" type="application\/json">([^<]*)/)![1]!);
    expect(shell.panel.context.scope).toEqual({ type: "notebooks.notebook", id: notebook.shortId });
    expect(shell.panel.context.scope.id).not.toBe(notebook.id);
  });
