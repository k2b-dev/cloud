import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as cloudServices from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { notebooksService } from "../../service";
import * as notebookStore from "../../service/notebooks";
import * as noteStore from "../../service/notes";
import * as routeState from "../../service/route-state";
import "./_components/detail/ssr-test-plugin";

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
});
afterEach(() => railSnapshot.mockRestore());

const renderEmptyNotebook = async (mode: "write" | "book", preferences: Record<string, unknown> = {}) => {
  spies.push(spyOn(cloudServices, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(notebooksService.notebook, "getByShortId").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook, "get").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook.permission, "get").mockResolvedValue("write"));
  spies.push(spyOn(notebooksService.workspaceEvents, "latestCursor").mockResolvedValue("1-0"));
  spies.push(spyOn(notebooksService.note, "getTree").mockResolvedValue([]));
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
    spyOn(notebooksService.note, "getTree").mockResolvedValue([
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
    expect(island?.attributes["data-props"]).toBe("({notebookId:&quot;book01&quot;})");
  },
);

test.each([
  ["attachments", "/app/notebooks/:id/attachments", "/app/notebooks/book01/attachments", attachmentsHandler, false],
  ["tag", "/app/notebooks/:id/tags/:tag", "/app/notebooks/book01/tags/ideas", tagHandler, false],
  ["book-mode tag", "/app/notebooks/:id/tags/:tag", "/app/notebooks/book01/tags/ideas?mode=book", tagHandler, true],
] as const)("the %s page of a notebook also records the notebook", async (_name, route, path, pageHandler, bookMode) => {
  spies.push(spyOn(cloudServices, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(notebooksService.notebook, "getByShortId").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook, "get").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook.permission, "get").mockResolvedValue("write"));
  spies.push(spyOn(notebooksService.workspaceEvents, "latestCursor").mockResolvedValue("1-0"));
  spies.push(spyOn(notebooksService.note, "getTree").mockResolvedValue([]));
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
  expect(island?.attributes["data-props"]).toBe("({notebookId:&quot;book01&quot;})");
});

const renderNotebookWithNotes = async (preferences: Record<string, unknown>) => {
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
  spies.push(spyOn(notebooksService.note, "getTree").mockResolvedValue([note("note01", "Private folder"), note("note02", "Team notes")]));
  spies.push(spyOn(notebooksService.notebook, "graph").mockResolvedValue({ nodes: [], edges: [] }));
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
  app.get("/app/notebooks/:id", ...handler);
  // The graph view keeps the notebook route without redirecting to a note.
  const response = await app.request("https://cloud.example.test/app/notebooks/book01?mode=graph", {
    headers: {
      "accept-language": "de",
      cookie: `settings-app-notebooks=${encodeURIComponent(JSON.stringify(preferences))}`,
    },
  });
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
  // The graph has no editor toolbar, so the sidebar offers its own show control.
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
  spies.push(spyOn(notebooksService.note, "getTree").mockResolvedValue([{ ...note, children: [] }]));
  spies.push(spyOn(notebooksService.note, "getByShortId").mockResolvedValue(note));
  spies.push(spyOn(notebooksService.tag, "listForNotebook").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.note.favorites, "listIds").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.attachment, "count").mockResolvedValue(0));
  spies.push(spyOn(notebooksService.notebook, "graph").mockResolvedValue({ nodes: [], edges: [] }));
  spies.push(spyOn(notebooksService.note.versions, "list").mockRejectedValue(new Error("No saved versions in this fixture")));
  spies.push(
    spyOn(notebooksService.note.comments, "listPage").mockResolvedValue({ items: [], page: 1, perPage: 30, total: 0, hasNext: false }),
  );
  spies.push(
    spyOn(routeState, "loadSelectedNoteRouteState").mockResolvedValue({
      note: { ...note, id: note.shortId },
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
  expect(editor?.attributes["data-props"]).toContain("initialContent:&quot;# Wochenplan");
});

test("write mode sends no duplicate initialContent in the editor props", async () => {
  const [editor] = await select(await renderEditorPage(), 'solid-client[data-file="NoteEditor.client.tsx"]');
  expect(editor?.attributes["data-props"]).toContain("initialContent:null");
  expect(editor?.attributes["data-props"]).toContain("contentMd:");
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
