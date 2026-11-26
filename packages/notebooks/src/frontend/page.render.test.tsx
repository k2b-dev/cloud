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
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Notebooks as the rail opens it (`/app/notebooks`, or the older `?recent=true`), in German, with the notebook used last. */
const openNotebooks = (lastNotebookId?: string, query = "") => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/notebooks", ...handler);
  return app.request(`https://cloud.example.test/app/notebooks${query}`, {
    headers: {
      "accept-language": "de",
      cookie: `settings-app-notebooks=${encodeURIComponent(JSON.stringify(lastNotebookId ? { lastNotebookId } : {}))}`,
    },
  });
};

for (const query of ["", "?recent=true"])
  test(`Notebooks opens the notebook used last (${query || "no query"})`, async () => {
    const response = await openNotebooks("bookBB", query);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/notebooks/bookBB");
  });

test("a command link to Notebooks reaches the notebook it opens, with its query", async () => {
  // what openCommand follows for "New note" from another app, as resolveCommand builds it
  const query = `?command=notebooks.note.compose&commandInput=${encodeURIComponent(JSON.stringify({ notebookId: "bookAA" }))}`;
  const response = await openNotebooks("bookBB", `${query}&recent=true`);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`/app/notebooks/bookBB${query}`);
});

test("Notebooks opens the first notebook when the one used last is gone, no longer shared, or unknown", async () => {
  for (const last of ["bookZZ", undefined]) {
    const response = await openNotebooks(last);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/notebooks/bookAA");
  }
});

test("without a notebook, Notebooks starts the first one: one sentence and the one +, read from the notebooks alone", async () => {
  spies.push(spyOn(notebooksService.notebook, "list").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 0, hasNext: false }));
  const recent = spyOn(notebooksService.note, "recentForUser");
  const activity = spyOn(notebooksService.activity, "list");
  spies.push(recent, activity);
  const response = await openNotebooks();
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(await selectHtml(html, "[data-k2-workspace]")).toHaveLength(1);
  expect((await selectHtml(html, '[data-k2-part="Empty"]'))[0]?.text).toContain("Noch keine Notizbücher.");
  // the one way to the first notebook is the head's +
  expect(await selectHtml(html, '[data-slot="head"] button[aria-label="Neues Notizbuch"]')).toHaveLength(1);
  expect(await selectHtml(html, '[data-k2-part="Empty"] button')).toHaveLength(0);
  expect(recent).not.toHaveBeenCalled();
  expect(activity).not.toHaveBeenCalled();
});
