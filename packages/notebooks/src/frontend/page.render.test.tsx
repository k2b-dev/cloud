import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
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
