import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { selectHtml } from "../../../../tests/fixtures/select-html";
import { notebooksService } from "../service";
import "./[id]/_components/detail/ssr-test-plugin";

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
const notebook = (shortId: string, index: number) => ({
  id: `22222222-2222-4222-8222-22222222222${index}`,
  shortId,
  name: `Notebook ${index}`,
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
beforeEach(() => {
  spies.push(stubRailSnapshot());
  spies.push(
    spyOn(notebooksService.notebook, "list").mockResolvedValue({
      items: [notebook("bookAA", 1), notebook("bookBB", 2)],
      total: 2,
      page: 1,
      perPage: 2,
      hasNext: false,
    }),
  );
  spies.push(spyOn(notebooksService.note, "recentForUser").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.activity, "list").mockResolvedValue({ items: [], nextCursor: null }));
  spies.push(spyOn(notebooksService.notebook, "overviewStats").mockResolvedValue([]));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const openNotebooksEntry = (lastNotebookId: string) => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/notebooks", ...handler);
  return app.request("https://cloud.example.test/app/notebooks?recent=true", {
    headers: { cookie: `settings-app-notebooks=${encodeURIComponent(JSON.stringify({ lastNotebookId }))}` },
  });
};

test("the Notebooks entry opens the notebook used last", async () => {
  const response = await openNotebooksEntry("bookBB");

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/app/notebooks/bookBB");
});

test("the Notebooks entry shows the overview when the notebook used last is gone or no longer shared", async () => {
  const response = await openNotebooksEntry("bookZZ");

  expect(response.status).toBe(200);
});

/** The home itself, in German, with the notebooks this person pinned (the settings cookie). */
const openHome = (pinnedNotebookIds: string[] = []) => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/notebooks", ...handler);
  return app.request("https://cloud.example.test/app/notebooks", {
    headers: {
      "accept-language": "de",
      cookie: `settings-app-notebooks=${encodeURIComponent(JSON.stringify({ pinnedNotebookIds }))}`,
    },
  });
};
const recentNote = {
  id: "33333333-3333-4333-8333-333333333331",
  shortId: "noteAA",
  notebookId: "22222222-2222-4222-8222-222222222221",
  notebookShortId: "bookAA",
  title: "Wochenplan",
  updatedAt: timestamp,
  notebookIcon: null,
  notebookName: "Notebook 1",
};
const activityItem = {
  id: "44444444-4444-4444-8444-444444444441",
  notebook: { id: "22222222-2222-4222-8222-222222222221", shortId: "bookAA", name: "Notebook 1", icon: null },
  note: { id: "33333333-3333-4333-8333-333333333331", shortId: "noteAA", title: "Wochenplan" },
  noteVersionId: null,
  actor: { kind: "user" as const, id: user.id, displayName: "Note Writer", avatarHash: null },
  action: "note.updated",
  metadata: {},
  occurrenceCount: 1,
  createdAt: timestamp,
  lastOccurredAt: timestamp,
};

test("the home is one v2 workspace: the pinned notebooks first, the notes edited last and the activity, without a loader", async () => {
  spies.push(spyOn(notebooksService.note, "recentForUser").mockResolvedValue([recentNote]));
  spies.push(spyOn(notebooksService.activity, "list").mockResolvedValue({ items: [activityItem], nextCursor: null }));
  const html = await (await openHome(["bookBB"])).text();
  expect(await selectHtml(html, "[data-k2-workspace]")).toHaveLength(1);
  // the sidebar: the overview is the open place, the pinned notebook stands in its own group above the others
  const groups = (await selectHtml(html, '[data-k2-part="Nav"]'))[0]?.text ?? "";
  expect(groups.indexOf("Angeheftet")).toBeLessThan(groups.indexOf("Notebook 2"));
  expect(groups.indexOf("Notebook 2")).toBeLessThan(groups.indexOf("Alle Notizbücher"));
  expect(groups.indexOf("Alle Notizbücher")).toBeLessThan(groups.indexOf("Notebook 1"));
  expect((await selectHtml(html, '[data-k2-part="Nav"] [aria-current="page"]'))[0]?.text).toContain("Übersicht");
  // the head repeats no title of the sidebar: it holds the search and the one "+"
  expect((await selectHtml(html, '[data-slot="head"]'))[0]?.text.trim()).toBe("");
  expect(html).toContain("Wochenplan");
  expect(html).toContain('href="/app/notebooks/bookAA/notes/noteAA"');
  // the server reads all of it: nothing loads in the first picture
  expect(await selectHtml(html, '[data-k2-part="Loading"]')).toHaveLength(0);
  expect(await selectHtml(html, '[data-k2-part="Digest"] [data-k2-part="Row"]')).toHaveLength(1);
});

test("the home says when its activity could not be read, with a way to try again", async () => {
  spies.push(spyOn(notebooksService.activity, "list").mockRejectedValue(new Error("database down")));
  const html = await (await openHome()).text();
  expect(await selectHtml(html, '[data-k2-part="Failed"]')).toHaveLength(1);
  // the reason stays on the server
  expect(html).not.toContain("database down");
});

test("without notebooks the home says so and offers a new one", async () => {
  spies.push(spyOn(notebooksService.notebook, "list").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 0, hasNext: false }));
  const html = await (await openHome()).text();
  expect((await selectHtml(html, '[data-k2-part="Empty"]'))[0]?.text).toContain("Noch keine Notizbücher.");
  expect((await selectHtml(html, '[data-k2-part="Empty"] button'))[0]?.text).toContain("Neues Notizbuch");
});
