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
// bookAA and bookBB exist; the person reaches both unless a test says otherwise
let list: ReturnType<typeof spyOn<typeof notebooksService.notebook, "list">>;
let permission: ReturnType<typeof spyOn<typeof notebooksService.notebook.permission, "get">>;
beforeEach(() => {
  spies.push(stubRailSnapshot());
  list = spyOn(notebooksService.notebook, "list").mockResolvedValue({
    items: [notebook("bookAA", 1)],
    total: 2,
    page: 1,
    perPage: 1,
    hasNext: true,
  });
  permission = spyOn(notebooksService.notebook.permission, "get").mockResolvedValue("read");
  spies.push(list, permission);
  spies.push(
    spyOn(notebooksService.notebook, "getByShortId").mockImplementation(async ({ shortId }) =>
      shortId === "bookAA" ? notebook("bookAA", 1) : shortId === "bookBB" ? notebook("bookBB", 2) : null,
    ),
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
  test(`Notebooks opens the notebook used last, reading that one alone (${query || "no query"})`, async () => {
    const response = await openNotebooks("bookBB", query);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/notebooks/bookBB");
    // no list of every notebook: one notebook and its access
    expect(list).not.toHaveBeenCalled();
    expect(permission).toHaveBeenCalledWith({ notebookId: notebook("bookBB", 2).id, userId: user.id });
  });

test("a command link to Notebooks reaches the notebook it opens, with its query", async () => {
  // what openCommand follows for "New note" from another app, as resolveCommand builds it
  const query = `?command=notebooks.note.compose&commandInput=${encodeURIComponent(JSON.stringify({ notebookId: "bookAA" }))}`;
  const response = await openNotebooks("bookBB", `${query}&recent=true`);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`/app/notebooks/bookBB${query}`);
});

test("Notebooks opens the first notebook when the one used last is gone, no longer shared, or unknown", async () => {
  for (const [last, access] of [
    ["bookZZ", "read"],
    ["bookBB", "none"],
    [undefined, "read"],
  ] as const) {
    permission.mockResolvedValue(access);
    list.mockClear();
    const response = await openNotebooks(last);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/notebooks/bookAA");
    // the first one by name, and only that one
    expect(list).toHaveBeenCalledWith({ userId: user.id, pagination: { page: 1, perPage: 1 } });
  }
});

test("without a notebook, Notebooks offers the ways to start as rows, read from the notebooks alone", async () => {
  list.mockResolvedValue({ items: [], total: 0, page: 1, perPage: 1, hasNext: false });
  const recent = spyOn(notebooksService.note, "recentForUser");
  const activity = spyOn(notebooksService.activity, "list");
  spies.push(recent, activity);
  const response = await openNotebooks();
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(await selectHtml(html, "[data-k2-workspace]")).toHaveLength(1);
  const [section] = await selectHtml(html, '[data-k2-part="Section"]');
  expect(section?.text).toContain("Erstes Notizbuch anlegen");
  // a blank notebook first, then every template with what it holds, each a row that opens
  const rows = await selectHtml(html, '[data-k2-part="Row"]');
  const templates = notebooksService.template.list("de");
  expect(rows.map((row) => row.text.trim())).toEqual([
    "Leeres NotizbuchLeer, mit einer Willkommensseite",
    ...templates.map((template) => `${template.name}${template.description}`),
  ]);
  expect(await selectHtml(html, '[data-k2-part="Row"] button.k2-row-open')).toHaveLength(rows.length);
  // no head that only repeats the rows; the phone's floating main action makes a blank one
  expect(await selectHtml(html, '[data-slot="head"]')).toHaveLength(0);
  expect((await selectHtml(html, ".k2-fab"))[0]?.text).toContain("Neues Notizbuch");
  expect(recent).not.toHaveBeenCalled();
  expect(activity).not.toHaveBeenCalled();
});
