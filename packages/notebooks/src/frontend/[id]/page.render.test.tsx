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
  // The note tree is the section's only child; its first child is where the first note row would be.
  const [placeholder, ...others] = await select(html, ".k2b-app-workspace__sidebar-section-content > div > .k2b-placeholder:first-child");

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
  expect(await select(visible, '.k2b-icon-button[aria-controls="notebook-navigation"]')).toEqual([]);
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

test("a book page is server-rendered with the start page first and the other pages by title", async () => {
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
    headers: { "accept-language": "de" },
  });
  expect(response.status).toBe(200);
  const rows = await select(await response.text(), '[role="tree"] [data-k2b-nav-tree-id]');

  // The start page lives below "Kapitel 2" and is still the first row, listed once.
  expect(rows.map((row) => row.attributes["data-k2b-nav-tree-id"])).toEqual(["note04", "note01", "note03", "note02"]);
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

test("a hidden navigation is server-rendered without the note tree or the navigator's note list", async () => {
  const html = await renderNotebookWithNotes({ sidebarMode: "navigator", navigationHidden: true });
  const [sidebar, ...others] = await select(html, "aside.k2b-app-workspace__sidebar");

  expect(others).toEqual([]);
  expect(sidebar?.attributes.id).toBe("notebook-navigation");
  expect(sidebar?.attributes.hidden).toBeDefined();
  expect(sidebar?.text).toBe("");
  expect(await select(html, "aside.k2b-app-workspace__sidebar *")).toEqual([]);
  expect(await select(html, '[data-app-workspace-resize="sidebar"]')).toEqual([]);
  // The navigator's note list pane hides with the sidebar and renders no rows while hidden.
  const [pane] = await select(html, '[data-workspace-main-region="notebook-notes"]');
  expect(pane?.attributes["data-surface"]).toBe("navigation");
  expect((await select(html, '[data-workspace-main-region="notebook-notes"] *')).filter((element) => element.text.trim())).toEqual([]);
  expect(await select(html, '[data-workspace-main-region="notebook-notes"] a')).toEqual([]);
  // The graph has no editor toolbar, so the sidebar offers its own show control.
  expect((await select(html, 'button[aria-controls="notebook-navigation"]')).map((button) => button.attributes["aria-label"])).toEqual([
    "Navigation einblenden",
  ]);
});

test("a visible navigation is server-rendered with its note tree and the navigator's note list", async () => {
  const simple = await renderNotebookWithNotes({ sidebarMode: "simple" });
  const [sidebar] = await select(simple, "aside.k2b-app-workspace__sidebar");
  expect(sidebar?.attributes.hidden).toBeUndefined();
  expect(sidebar?.text).toContain("Private folder");
  expect(await select(simple, '[data-app-workspace-resize="sidebar"]')).toHaveLength(1);

  const navigator = await renderNotebookWithNotes({ sidebarMode: "navigator" });
  const rows = await select(navigator, '[data-workspace-main-region="notebook-notes"] a');
  expect(rows.map((row) => row.text).join(" ")).toContain("Private folder");
});
