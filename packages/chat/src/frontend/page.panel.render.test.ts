import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ai from "@k2b/cloud/ai";
import type { User } from "@k2b/cloud/contracts";
import { PANEL_CONTEXT_PARAM } from "@k2b/cloud/contracts";
import { type AuthContext, fail, ok } from "@k2b/cloud/server";
import { announcements } from "@k2b/cloud/services/announcements";
import { session } from "@k2b/cloud/services/session";
import * as help from "@k2b/cloud/ssr/help";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { createDomTestHarness } from "../../../ui/test/dom";
import { conversations as conversationService } from "../service/conversations";
import { personal } from "../service/personal";
import * as snapshot from "../service/snapshot";
import { systemChats } from "../service/system-chats";
import { chatView, conversations } from "./pwa-fixtures.test-fixture";

const root = mkdtempSync(join(tmpdir(), "chat-panel-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: pages } = await import("./index");
const { app } = await import("../config");

/** Invented demo account. */
const person: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mberger",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Mia",
  sn: "Berger",
  displayName: "Mia Berger",
  mail: "mia.berger@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const notebook = { type: "inventory.collection", id: "Shelf-7" };
// The discussion about the host page's resource is Werk01, the fixture chat with an open snapshot.
const context = (scope?: { type: string; id: string }) =>
  encodeURIComponent(
    JSON.stringify({ v: 1, seq: 1, pageId: "0b6f6a2e-4f6f-4c43-9d3c-2d6a9a0d7c11", app: "inventory", ...(scope ? { scope } : {}) }),
  );

const viewSpy = spyOn(snapshot, "loadChatView").mockImplementation(async (_context, input) => chatView(input.conversationId));
const found = ok({ conversation: "Werk01", thread: null, item: false, title: "Lager Ost", canWrite: true });
const locateSpy = spyOn(systemChats, "locate").mockResolvedValue(found);
// Looking never starts a discussion: the page only locates it.
const createSpy = spyOn(systemChats, "openFor");
const openSpy = spyOn(systemChats, "open");
const spies = [
  viewSpy,
  locateSpy,
  createSpy,
  openSpy,
  spyOn(personal, "preferences").mockResolvedValue(ok({ collapsed: [] })),
  spyOn(conversationService, "list").mockResolvedValue(ok({ items: conversations, nextCursor: null })),
  spyOn(ai, "getLiveDictationStatus").mockResolvedValue({ available: false } as Awaited<ReturnType<typeof ai.getLiveDictationStatus>>),
  spyOn(session, "getToken").mockReturnValue("test-session"),
  spyOn(session, "authenticateRequest").mockResolvedValue({
    user: person,
    data: { userId: person.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
  }),
  stubRailSnapshot(),
  spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  spyOn(announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
];
afterEach(() => {
  viewSpy.mockClear();
  expect(createSpy).not.toHaveBeenCalled();
  expect(openSpy).not.toHaveBeenCalled();
  locateSpy.mockClear();
  locateSpy.mockResolvedValue(found);
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

const server = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps: [app.meta] } as never);
    c.set("settings" as never, { app: { name: "Example Cloud" } } as never);
    await next();
  })
  .route("/app/chat", pages);
const parser = (() => {
  const dom = createDomTestHarness();
  dom.cleanup();
  return new dom.window.DOMParser();
})();
const request = (path: string) => server.request(`https://cloud.example.test${path}`, { headers: { Cookie: "session=test-session" } });
const render = async (path: string) => {
  const response = await request(path);
  return { response, document: parser.parseFromString(await response.text(), "text/html") as unknown as Document };
};

describe("Chat in the panel beside a resource", () => {
  test("starts in the discussion about the host page's resource and keeps the shared context in its address", async () => {
    const response = await request(`/app/chat/panel?${PANEL_CONTEXT_PARAM}=${context(notebook)}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/app/chat/panel/c/Werk01?${PANEL_CONTEXT_PARAM}=${context(notebook)}`);
    // The scope only selects: the container is read as this reader, and nothing is created.
    expect(locateSpy).toHaveBeenCalledTimes(1);
    const input = locateSpy.mock.calls[0]![0];
    expect(input.ref).toEqual(notebook);
    expect(input.accessSubject).toMatchObject({ type: "user", userId: person.id });
  });

  test("an item the host page shares opens its thread in its container's discussion", async () => {
    locateSpy.mockResolvedValue(ok({ conversation: "Werk01", thread: "Thrd01", item: true, title: "Lieferplan KW47.csv", canWrite: true }));
    const item = { type: "inventory.item", id: "Plan-47" };
    const response = await request(`/app/chat/panel?${PANEL_CONTEXT_PARAM}=${context(item)}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/app/chat/panel/c/Werk01/t/Thrd01?${PANEL_CONTEXT_PARAM}=${context(item)}`);
    expect(locateSpy.mock.calls[0]![0].ref).toEqual(item);
  });

  test("before anyone wrote, the panel shows a ready discussion and creates nothing", async () => {
    locateSpy.mockResolvedValue(ok({ conversation: null, thread: null, item: false, title: "Lager Ost", canWrite: true }));
    const start = await request(`/app/chat/panel?${PANEL_CONTEXT_PARAM}=${context(notebook)}`);
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe(`/app/chat/panel/resource?${PANEL_CONTEXT_PARAM}=${context(notebook)}`);
    const { response, document } = await render(`/app/chat/panel/resource?${PANEL_CONTEXT_PARAM}=${context(notebook)}`);
    expect(response.status).toBe(200);
    const view = document.querySelector('.chat-resource-start[aria-label="About Lager Ost"]')!;
    expect(view.querySelector('a[aria-label="All chats"]')?.getAttribute("href")).toBe("/app/chat/panel");
    expect(view.textContent).toContain("Nobody has written here yet.");
    expect(view.querySelector('textarea[placeholder="Message Lager Ost"]')).not.toBeNull();
    // An item without its thread is the same ready start, even when its container's chat exists.
    locateSpy.mockResolvedValue(ok({ conversation: "Werk01", thread: null, item: true, title: "Lieferplan KW47.csv", canWrite: true }));
    const item = { type: "inventory.item", id: "Plan-47" };
    expect((await request(`/app/chat/panel?${PANEL_CONTEXT_PARAM}=${context(item)}`)).headers.get("location")).toBe(
      `/app/chat/panel/resource?${PANEL_CONTEXT_PARAM}=${context(item)}`,
    );
  });

  test("a reader who may not write sees the empty discussion without a composer", async () => {
    locateSpy.mockResolvedValue(ok({ conversation: null, thread: null, item: false, title: "Lager Ost", canWrite: false }));
    const { document } = await render(`/app/chat/panel/resource?${PANEL_CONTEXT_PARAM}=${context(notebook)}`);
    const view = document.querySelector(".chat-resource-start")!;
    expect(view.textContent).toContain("People who may edit it can start the discussion.");
    expect(view.querySelector("textarea")).toBeNull();
  });

  test("the start page moves to the discussion once it exists, and to the list without a place", async () => {
    const exists = await request(`/app/chat/panel/resource?${PANEL_CONTEXT_PARAM}=${context(notebook)}`);
    expect(exists.headers.get("location")).toBe(`/app/chat/panel/c/Werk01?${PANEL_CONTEXT_PARAM}=${context(notebook)}`);
    const none = await request("/app/chat/panel/resource");
    expect(none.status).toBe(302);
    expect(none.headers.get("location")).toBe("/app/chat/panel");
  });

  test("in the resource's discussion the header leads to all chats, and nowhere out of the panel", async () => {
    const { response, document } = await render(`/app/chat/panel/c/Werk01?${PANEL_CONTEXT_PARAM}=${context(notebook)}`);
    expect(response.status).toBe(200);
    const header = document.querySelector(".chat-conversation__header")!;
    expect(header.querySelector('a[aria-label="All chats"]')?.getAttribute("href")).toBe("/app/chat/panel");
    expect(header.querySelector('a[aria-label="Chat about Lager Ost"]')).toBeNull();
    expect(document.querySelector('a[href^="/app/chat/c/"]')).toBeNull();
  });

  test("elsewhere in the panel one icon leads back to the resource's discussion", async () => {
    const { document } = await render(`/app/chat/panel/archive?${PANEL_CONTEXT_PARAM}=${context(notebook)}`);
    const back = document.querySelector('a[aria-label="Chat about Lager Ost"]');
    expect(back?.getAttribute("href")).toBe("/app/chat/panel/c/Werk01?list=archive");
    // The panel switches chats; it neither searches nor starts them.
    expect(document.querySelector('input[type="search"]')).toBeNull();
    expect(document.body.textContent).not.toContain("New chat");
    expect(document.body.textContent).not.toContain("For you");
  });

  test("a resource the reader cannot read, or no shared place, leaves the panel at the chat list", async () => {
    locateSpy.mockResolvedValue(fail({ code: "NOT_FOUND", status: 404, message: "Not found" }));
    const denied = await render(`/app/chat/panel?${PANEL_CONTEXT_PARAM}=${context(notebook)}`);
    expect(denied.response.status).toBe(200);
    expect(denied.document.querySelector('a[aria-label^="Chat about"]')).toBeNull();
    expect(denied.document.body.textContent).not.toContain("Lager Ost");
    locateSpy.mockClear();
    for (const path of [
      `/app/chat/panel?${PANEL_CONTEXT_PARAM}=${context()}`,
      `/app/chat/panel?${PANEL_CONTEXT_PARAM}=%7Bbroken`,
      "/app/chat/panel",
    ]) {
      expect((await request(path)).status).toBe(200);
    }
    expect(locateSpy).not.toHaveBeenCalled();
  });

  test("the full view ignores a shared place", async () => {
    expect((await request(`/app/chat?${PANEL_CONTEXT_PARAM}=${context(notebook)}`)).status).toBe(200);
    expect(locateSpy).not.toHaveBeenCalled();
  });
});
