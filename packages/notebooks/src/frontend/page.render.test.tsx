import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as layoutHelp from "@k2b/cloud/ssr/help";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { notebooksService } from "../service";
import "./[id]/_components/detail/ssr-test-plugin";

// `/app/notebooks` has no overview: it opens the last notebook, else the first one, and only without any notebook it
// shows a workspace that offers the first one.
const { default: handler } = await import("./page");

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
const notebook = (shortId: string) => ({
  id: `22222222-2222-4222-8222-${shortId.padStart(12, "0")}`,
  shortId,
  name: `Notebook ${shortId}`,
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
});

const spies: Array<{ mockRestore(): void }> = [];
let railSnapshot: ReturnType<typeof stubRailSnapshot>;
beforeEach(() => {
  railSnapshot = stubRailSnapshot();
  spies.push(spyOn(layoutHelp, "preloadLayoutHelp").mockResolvedValue(null));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  railSnapshot.mockRestore();
});

/** Stubs the notebooks this person can see (the first one listed first) and where the last opened one stands. */
const given = (options: { visible: string[]; last?: { shortId: string; permission: "read" | "none" } | "deleted" }) => {
  const list = spyOn(notebooksService.notebook, "list").mockImplementation(async () => {
    const items = options.visible.slice(0, 1).map(notebook);
    return { items, pagination: { page: 1, perPage: 1, total: options.visible.length, totalPages: options.visible.length } } as never;
  });
  const byShortId = spyOn(notebooksService.notebook, "getByShortId").mockImplementation(async ({ shortId }) =>
    options.last === "deleted" || !options.last ? null : (notebook(shortId) as never),
  );
  const permission = spyOn(notebooksService.notebook.permission, "get").mockResolvedValue(
    options.last && options.last !== "deleted" ? options.last.permission : "none",
  );
  spies.push(list, byShortId, permission);
  return { list, byShortId };
};

const request = async (address: string, lastNotebookId?: string) => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/notebooks", ...handler);
  const cookie = lastNotebookId ? `settings-app-notebooks=${encodeURIComponent(JSON.stringify({ lastNotebookId }))}` : "";
  return app.request(`https://cloud.example.test${address}`, { headers: { "accept-language": "de", cookie } });
};

test("opens the notebook opened last, with the address's parameters", async () => {
  const { list } = given({ visible: ["first1"], last: { shortId: "last01", permission: "read" } });
  const response = await request("/app/notebooks?mode=book&recent=true", "last01");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/app/notebooks/last01?mode=book");
  // the last notebook is enough: the list is not read
  expect(list).not.toHaveBeenCalled();
});

test("opens the first visible notebook when the last one is gone or no longer shared", async () => {
  given({ visible: ["first1", "second"], last: "deleted" });
  const gone = await request("/app/notebooks", "gone01");
  expect(gone.headers.get("location")).toBe("/app/notebooks/first1");
  for (const spy of spies.splice(0)) spy.mockRestore();
  given({ visible: ["first1"], last: { shortId: "secret", permission: "none" } });
  const unshared = await request("/app/notebooks", "secret");
  expect(unshared.headers.get("location")).toBe("/app/notebooks/first1");
  for (const spy of spies.splice(0)) spy.mockRestore();
  given({ visible: ["first1"] });
  const fresh = await request("/app/notebooks");
  expect(fresh.headers.get("location")).toBe("/app/notebooks/first1");
});

test("without any notebook the workspace says so and offers the first one, on v2 and without an overview", async () => {
  given({ visible: [] });
  const response = await request("/app/notebooks");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html.match(/data-k2-part="Workspace"/g)).toHaveLength(1);
  expect(html).toContain('data-k2-part="Empty"');
  expect(html).toContain("Du kannst noch kein Notizbuch öffnen. Erstelle das erste.");
  expect(html).toContain("Neues Notizbuch");
  expect(html).not.toContain("Zuletzt bearbeitet");
  expect(html).not.toContain('data-k2-part="Loading"');
});
