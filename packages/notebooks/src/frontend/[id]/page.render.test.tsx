import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as cloudServices from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { notebooksService } from "../../service";
import "./_components/detail/ssr-test-plugin";

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

const renderEmptyNotebook = async (mode: "write" | "book") => {
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
    headers: { "accept-language": "de" },
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

test("an empty book shows its sidebar placeholder as one line below the pages heading", async () => {
  const html = await renderEmptyNotebook("book");
  const [placeholder, ...others] = await select(html, ".k2b-app-workspace__sidebar-section-content > .k2b-placeholder");

  expect(others).toEqual([]);
  expect(placeholder?.attributes["data-variant"]).toBe("inline");
  expect(placeholder?.attributes["data-align"]).toBe("left");
  expect(placeholder?.text).toBe("Noch keine Seiten");
});
