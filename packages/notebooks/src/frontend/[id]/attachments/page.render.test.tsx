import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as cloudServices from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../../tests/fixtures/rail-snapshot";
import { selectHtml } from "../../../../../../tests/fixtures/select-html";
import { notebooksService } from "../../../service";
import "../_components/detail/ssr-test-plugin";

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

test("readers cannot enter the attachments workspace through a direct URL", async () => {
  spies.push(spyOn(notebooksService.notebook, "getByShortId").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook.permission, "get").mockResolvedValue("read"));
  const tree = spyOn(notebooksService.note, "getTree");
  const attachments = spyOn(notebooksService.attachment, "listPaginated");
  spies.push(tree, attachments);
  const app = new Hono<AuthContext>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    await next();
  });
  app.get("/app/notebooks/:id/attachments", ...handler);
  for (const mode of ["book", "write", "readonly"]) {
    const response = await app.request("https://cloud.example.test/app/notebooks/book01/attachments?mode=" + mode);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/notebooks/book01?mode=book");
  }
  expect(tree).not.toHaveBeenCalled();
  expect(attachments).not.toHaveBeenCalled();
});

test("attachments render their current sidebar destination and unframed empty panel, preserving search and presentation", async () => {
  spies.push(spyOn(cloudServices, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(notebooksService.notebook, "getByShortId").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook, "get").mockResolvedValue(notebook));
  spies.push(spyOn(notebooksService.notebook.permission, "get").mockResolvedValue("write"));
  spies.push(spyOn(notebooksService.workspaceEvents, "latestCursor").mockResolvedValue("1-0"));
  spies.push(spyOn(notebooksService.note, "getTree").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.tag, "listForNotebook").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.note.favorites, "listIds").mockResolvedValue([]));
  spies.push(spyOn(notebooksService.attachment, "count").mockResolvedValue(401));
  spies.push(
    spyOn(notebooksService.attachment, "listPaginated").mockResolvedValue({
      items: [],
      total: 401,
      page: 1,
      perPage: 200,
      hasNext: true,
    }),
  );
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/notebooks/:id/attachments", ...handler);
  for (const mode of ["write", "readonly"]) {
    for (const search of ["", "&search=team"]) {
      const response = await app.request(`https://cloud.example.test/app/notebooks/book01/attachments?mode=${mode}${search}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`/app/notebooks/book01/attachments?mode=${mode}${search ? "&amp;search=team" : ""}&amp;page=2`);
      expect(html).toContain(`/app/notebooks/book01/attachments?mode=${mode}`);
      const current = await selectHtml(html, '.notebook-sidebar-foot [aria-current="page"]');
      expect(current).toHaveLength(1);
      expect(current[0]?.attributes.href).toBe(`/app/notebooks/book01/attachments?mode=${mode}`);
      expect(current[0]?.text).toContain("Attachments");
      const empty = await selectHtml(html, '.k2b-app-workspace__main .k2b-placeholder[data-variant="panel"]');
      expect(empty).toHaveLength(1);
      expect(empty[0]?.attributes["data-surface"]).not.toBe("paper");
      expect(empty[0]?.text).toContain(search ? "No attachments match “team”." : "No attachments yet");
    }
  }
});

let railSnapshot: ReturnType<typeof stubRailSnapshot>;
beforeEach(() => {
  railSnapshot = stubRailSnapshot();
});
afterEach(() => railSnapshot.mockRestore());
