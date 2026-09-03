import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CloudRuntime, PermissionLevel, User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import * as cloudServices from "@valentinkolb/cloud/services";
import { Hono } from "hono";
import { notebooksService } from "../../../../service";
import "../../_components/detail/ssr-test-plugin";

const { default: handler } = await import("./page");

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
  scriptsEnabled: false,
  defaultPresentationMode: "write" as const,
  defaultNoteTitleTemplate: "Untitled",
  createdBy: user.id,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const activeSpies: Array<{ mockRestore(): void }> = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
  activeSpies.push(spy);
  return spy;
};
afterEach(() => {
  for (const spy of activeSpies.splice(0)) spy.mockRestore();
});

function fixtures(permission: PermissionLevel = "read") {
  track(spyOn(cloudServices, "get")).mockResolvedValue("https://cloud.example.test");
  track(spyOn(notebooksService.notebook, "getByShortId")).mockResolvedValue(notebook);
  track(spyOn(notebooksService.notebook, "get")).mockResolvedValue(notebook);
  track(spyOn(notebooksService.notebook.permission, "get")).mockResolvedValue(permission);
  const cursor = track(spyOn(notebooksService.workspaceEvents, "latestCursor")).mockResolvedValue("1-0");
  const tree = track(spyOn(notebooksService.note, "getTree")).mockResolvedValue([]);
  track(spyOn(notebooksService.attachment, "count")).mockResolvedValue(0);
  track(spyOn(notebooksService.note.favorites, "listIds")).mockResolvedValue([]);
  const tags = track(spyOn(notebooksService.tag, "listForNotebook")).mockResolvedValue([{ tag: "team", count: 101 }]);
  const count = track(spyOn(notebooksService.tag, "countNotesForTag")).mockResolvedValue(101);
  const notes = track(spyOn(notebooksService.tag, "listNotesForTag")).mockResolvedValue({
    items: [
      { id: "33333333-3333-4333-8333-333333333333", shortId: "note01", title: "Onboarding", preview: "Start here", updatedAt: timestamp },
    ],
    total: 101,
  });
  return { cursor, tree, tags, count, notes };
}

async function render(query = "mode=write", locale = "en") {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/notebooks/:id/tags/:tag", ...handler);
  const response = await app.request(`https://cloud.example.test/app/notebooks/book01/tags/TEAM?${query}`, {
    headers: { "Accept-Language": locale },
  });
  const html = await response.text();
  expect(response.status).toBe(200);
  return html;
}

describe("Book tag page SSR", () => {
  test("read grants override Write and render Book navigation without editor islands", async () => {
    const calls = fixtures();
    const html = await render();
    expect(html).toContain("notebook-book-shell");
    expect(html).toContain("Onboarding");
    expect(html).toContain("Start here");
    expect(html).toContain("/app/notebooks/book01/notes/note01?mode=book");
    expect(html).not.toMatch(/NotebookSidebar|NoteEditor|NotebookDetailPanel|yjsSnapshot/);
    expect(html).toContain("WorkspaceEventBridge");
    expect(calls.notes).toHaveBeenCalledWith({
      notebookId: notebook.id,
      tag: "team",
      search: undefined,
      pagination: { limit: 50, offset: 0 },
    });
  });

  test("search GET submissions and pagination preserve Book and the current search", async () => {
    const calls = fixtures();
    const html = await render("mode=book&search=%20join%20us%20&page=2", "de");
    expect(html).toMatch(/<form[^>]*role="search"[^>]*method="get"[^>]*action="\/app\/notebooks\/book01\/tags\/team"/);
    expect(html).toContain('type="hidden" name="mode" value="book"');
    expect(html).toContain('name="search"');
    expect(html).toContain('value="join us"');
    expect(html).toContain("Suchen");
    expect(html).toContain("/app/notebooks/book01/tags/team?mode=book&amp;search=join+us&amp;page=3");
    expect(calls.notes).toHaveBeenCalledWith({
      notebookId: notebook.id,
      tag: "team",
      search: "join us",
      pagination: { limit: 50, offset: 50 },
    });
  });

  test("explicit Book works for authors even with a Write default", async () => {
    fixtures("write");
    const html = await render("mode=book");
    expect(html).toContain("notebook-book-shell");
    expect(html).toContain("/app/notebooks/book01/notes/note01?mode=book");
    expect(html).not.toMatch(/NotebookSidebar|NoteEditor|NotebookDetailPanel/);
    expect(html).toContain("WorkspaceEventBridge");
  });

  test("no-access requests do not read the tag index or notebook workspace", async () => {
    const calls = fixtures("none");
    const html = await render();
    expect(html).not.toContain("Onboarding");
    expect(html).not.toContain("notebook-book-shell");
    expect(html).toContain("Access Denied");
    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
  });
});
