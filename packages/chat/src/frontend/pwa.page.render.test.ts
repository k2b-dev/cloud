import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAppMeta, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { announcements } from "@k2b/cloud/services/announcements";
import { session } from "@k2b/cloud/services/session";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { createDomTestHarness } from "../../../ui/test/dom";
import * as snapshot from "../service/snapshot";
import { chatView } from "./pwa-fixtures.test-fixture";

const root = mkdtempSync(join(tmpdir(), "chat-pwa-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { pwaPages } = await import("./index");
const { app } = await import("../config");

/** Invented demo accounts. */
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
const guest: User = { ...person, id: "22222222-2222-4222-8222-222222222222", uid: "gast", profile: "guest", roles: ["guest"] };
const shell: RuntimeAppMeta = { id: "pwa", name: "Cloud app", icon: "ti ti-device-mobile", description: "", routes: ["/pwa"] };

const viewSpy = spyOn(snapshot, "loadChatView").mockImplementation((async (_context: unknown, input: { conversationId?: string }) =>
  chatView(input.conversationId)) as never);
const tokenSpy = spyOn(session, "getToken").mockReturnValue(null);
const sessionSpy = spyOn(session, "authenticateRequest").mockResolvedValue(null);
const spies = [
  viewSpy,
  tokenSpy,
  sessionSpy,
  stubRailSnapshot(),
  spyOn(announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
];
afterEach(() => {
  viewSpy.mockClear();
  tokenSpy.mockReturnValue(null);
  sessionSpy.mockResolvedValue(null);
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

const signIn = (kind: "app" | "web", account: User = person) => {
  tokenSpy.mockReturnValue("test-session");
  sessionSpy.mockResolvedValue({
    user: account,
    data: { userId: account.id, sid: "test", authEpoch: 0, kind, expiresAt: "2099-01-01T00:00:00Z" },
  });
};

const server = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps: [shell, app.meta] } as never);
    c.set("settings" as never, { app: { name: "Example Cloud" } } as never);
    await next();
  })
  .route("/pwa/chat", pwaPages);

const parser = (() => {
  const dom = createDomTestHarness();
  dom.cleanup();
  return new dom.window.DOMParser();
})();
const render = async (path: string) => {
  const response = await server.request(`https://cloud.example.test${path}`, { headers: { Cookie: "pwa_session=test-session" } });
  return { response, document: parser.parseFromString(await response.text(), "text/html") as unknown as Document };
};

describe("Chat in the Cloud app", () => {
  test("declares its part for people with the user role, with the unread count for the sidebar", () => {
    expect(app.meta.pwa).toEqual({ href: "/pwa/chat", requiresRoles: ["user"], badge: "/api/chat/conversations/unread-count" });
    expect(app.meta.routes).toContain("/pwa/chat");
  });

  test("lists the chats in the app's frame, with Chat as the open part and its count beside it", async () => {
    signIn("app");
    const { response, document } = await render("/pwa/chat");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(document.querySelector("title")?.textContent).toBe("Chat");
    expect(document.querySelector(".chat-app")?.hasAttribute("data-open")).toBe(false);
    expect([...document.querySelectorAll('.chat-app__list a[href^="/pwa/chat/c/"]')].map((link) => link.getAttribute("href"))).toEqual([
      "/pwa/chat/c/Werk01",
      "/pwa/chat/c/Mobi01",
      "/pwa/chat/c/Nora01",
      "/pwa/chat/c/Jana01",
    ]);
    expect(document.querySelector('.k2b-mobile-shell__sidebar a[aria-current="page"]')?.getAttribute("href")).toBe("/pwa/chat");
    expect(
      document.querySelector('.k2b-mobile-shell__sidebar a[data-tab="chat"] .k2b-mobile-shell__sidebar-count solid-island'),
    ).not.toBeNull();
  });

  test("opens a chat at its own address beside the list, with the other chats' unread messages at Back", async () => {
    signIn("app");
    const { document } = await render("/pwa/chat/c/Werk01");
    expect(viewSpy.mock.calls.at(-1)?.[1]).toMatchObject({ conversationId: "Werk01" });
    expect(document.querySelector("title")?.textContent).toBe("Werkstatt-Team");
    expect(document.querySelector(".chat-app")?.hasAttribute("data-open")).toBe(true);
    expect(document.querySelector(".chat-conversation__back-count")?.textContent).toBe("2");
    expect(document.querySelector(".chat-conversation__back a")?.getAttribute("aria-label")).toBe("Back to chats, 2 unread");
    expect(document.querySelector(".chat-conversation__composer")?.hasAttribute("data-k2b-shell-bottom")).toBe(true);
  });

  test("a guest, a web session and no session never reach it", async () => {
    signIn("app", guest);
    expect((await render("/pwa/chat")).response.status).toBe(403);
    signIn("web");
    for (const cookie of ["session_token=test-session", ""]) {
      const response = await server.request("https://cloud.example.test/pwa/chat/c/Werk01", { headers: { Cookie: cookie } });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/pwa/_auth/session/launch?to=${encodeURIComponent("/pwa/chat/c/Werk01")}`);
    }
    expect(viewSpy).not.toHaveBeenCalled();
  });
});
