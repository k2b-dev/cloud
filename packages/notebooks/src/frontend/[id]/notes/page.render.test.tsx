import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { CloudRuntime, PermissionLevel, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as cloudServices from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../../tests/fixtures/rail-snapshot";
import { notebooksService } from "../../../service";
import { mockNoteTree } from "../page-tree.test-fixture";
import "../_components/detail/ssr-test-plugin";

// The notes list replaces the tag page: the address is the list state, the service filters, and an old tag link leads
// to the list with the tag set.
const { default: handler } = await import("./page");
const { default: tagHandler } = await import("../tags/[tag]/page");

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
const admin = { ...user, id: "11111111-1111-4111-8111-999999999999", uid: "admin", roles: ["user", "admin"] } satisfies User;
const timestamp = "2026-09-03T08:00:00.000Z";
const notebook = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "book01",
  name: "Handbook",
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
const track = <T extends { mockRestore(): void }>(spy: T): T => {
  spies.push(spy);
  return spy;
};
let railSnapshot: ReturnType<typeof stubRailSnapshot>;
beforeEach(() => {
  railSnapshot = stubRailSnapshot();
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  railSnapshot.mockRestore();
});

function fixtures(permission: PermissionLevel = "read", total = 1) {
  track(spyOn(cloudServices, "get")).mockResolvedValue("https://cloud.example.test");
  track(spyOn(notebooksService.notebook, "getByShortId")).mockResolvedValue(notebook);
  track(spyOn(notebooksService.notebook, "get")).mockResolvedValue(notebook);
  track(spyOn(notebooksService.notebook.permission, "get")).mockResolvedValue(permission);
  track(spyOn(notebooksService.workspaceEvents, "latestCursor")).mockResolvedValue("1-0");
  for (const spy of mockNoteTree([])) track(spy);
  track(spyOn(notebooksService.attachment, "count")).mockResolvedValue(0);
  track(spyOn(notebooksService.note.favorites, "listIds")).mockResolvedValue([]);
  track(spyOn(notebooksService.tag, "listForNotebook")).mockResolvedValue([
    { tag: "team", count: 101 },
    { tag: "garden", count: 3 },
  ]);
  track(spyOn(notebooksService.pageTemplate, "list")).mockResolvedValue({ ok: true, data: [] });
  const list = track(spyOn(notebooksService.pages, "list")).mockResolvedValue({
    items: [
      {
        shortId: "note01",
        title: "Onboarding",
        preview: "Start here",
        tags: ["team"],
        createdAt: timestamp,
        updatedAt: timestamp,
        lockedAt: null,
      },
    ],
    total,
  });
  return { list };
}

const request = async (path: string, actor: User = user) => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: actor });
    c.set("user", actor);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/notebooks/:id/notes", ...handler);
  app.get("/app/notebooks/:id/tags/:tag", ...tagHandler);
  return app.request(`https://cloud.example.test${path}`, { headers: { "Accept-Language": "en" } });
};

describe("the notes list", () => {
  test("an old tag link leads to the list with the tag, the search, the page and the mode", async () => {
    const response = await request("/app/notebooks/book01/tags/TEAM?search=plan&page=2&mode=book");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/notebooks/book01/notes?tag=team&q=plan&page=2&mode=book");
    const bare = await request("/app/notebooks/book01/tags/garden");
    expect(bare.headers.get("location")).toBe("/app/notebooks/book01/notes?tag=garden");
  });

  test("the server reads the address and filters with the person's access, and the first picture shows the notes", async () => {
    const { list } = fixtures("read", 101);
    const response = await request("/app/notebooks/book01/notes?tag=team&q=plan&page=2&mode=book");
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      notebookId: notebook.id,
      userId: user.id,
      favorite: undefined,
      tag: "team",
      search: "plan",
      sort: "updated",
      offset: 50,
      limit: 50,
    });
    const html = await response.text();
    expect(html.match(/data-k2-part="Workspace"/g)).toHaveLength(1);
    expect(html).toContain('data-k2-part="FilterBar"');
    expect(html).toContain("101 notes");
    expect(html).toContain("Onboarding");
    expect(html).toContain("Start here");
    // a reader keeps Book: the note opens in Book
    expect(html).toContain('href="/app/notebooks/book01/notes/note01?mode=book"');
    // readers cannot create notes
    expect(html).not.toMatch(/New note(?!book)/);
    expect(html).not.toContain('data-k2-part="Loading"');
  });

  test("favorites are a view; a page past the end opens the last page", async () => {
    const { list } = fixtures("write", 3);
    const favorites = await request("/app/notebooks/book01/notes?favorite=yes&view=favorites");
    expect(favorites.status).toBe(200);
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ favorite: true, tag: null, search: null, offset: 0 });
    const past = await request("/app/notebooks/book01/notes?page=9");
    expect(past.status).toBe(302);
    expect(past.headers.get("location")).toBe("/app/notebooks/book01/notes");
  });

  test("a global administrator reads the list without a notebook grant", async () => {
    const { list } = fixtures("none");
    const response = await request("/app/notebooks/book01/notes", admin);
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalled();
  });

  test("without access the list is not read", async () => {
    const { list } = fixtures("none");
    const response = await request("/app/notebooks/book01/notes?tag=team");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Onboarding");
    expect(list).not.toHaveBeenCalled();
  });
});
