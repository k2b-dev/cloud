import { afterAll, afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ai from "@k2b/cloud/ai";
import { aiLive } from "@k2b/cloud/ai/live";
import type { RuntimeAppMeta, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as server from "@k2b/cloud/server";
import { announcements } from "@k2b/cloud/services/announcements";
import { session } from "@k2b/cloud/services/session";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { fromJSON } from "seroval";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { createDomTestHarness } from "../../../ui/test/dom";
import * as sidebar from "../sidebar";

const root = mkdtempSync(join(tmpdir(), "assistant-pwa-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
// The count route's rate limit needs Valkey; this test reads the route's answer only.
const limiter = spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
const { pwaApi, pwaRoutes } = await import("./index");
const { app } = await import("../config");

/** Invented demo account. */
const person: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mmuster",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.test",
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
const shell: RuntimeAppMeta = { id: "pwa", name: "Mobile app", icon: "ti ti-device-mobile", description: "", routes: ["/pwa"] };

setSystemTime(new Date("2026-11-04T09:41:00Z"));
const chat = (shortId: string, title: string): ai.AiConversation => ({
  id: `uuid-${shortId}`,
  shortId,
  title,
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "2026-11-04T09:00:00.000Z",
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: true,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: person.id,
  createdAt: "2026-11-04T08:00:00.000Z",
  updatedAt: "2026-11-04T09:00:00.000Z",
});
const own = chat("Chat01", "Velvet care");

const spies = [
  spyOn(aiLive, "cursor").mockResolvedValue("cursor-1"),
  spyOn(ai, "assistantAiSettingsState").mockResolvedValue({
    ok: true,
    error: null,
    enabled: true,
    visionModelConfigured: true,
    status: "ok",
    selection: null,
    effectiveDefault: { class: "balanced" },
    classes: [],
    options: [],
  } as unknown as Awaited<ReturnType<typeof ai.assistantAiSettingsState>>),
  spyOn(ai, "getLiveDictationStatus").mockResolvedValue({ available: false } as Awaited<ReturnType<typeof ai.getLiveDictationStatus>>),
  spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
    conversations: [{ ...own, id: own.shortId }],
    projects: [],
    doneCount: 0,
    questions: { items: [], count: 0 },
  }),
  spyOn(ai.aiConversations, "listConversationsPage").mockResolvedValue({ total: 1, page: 1, perPage: 1, hasNext: false, items: [] }),
  spyOn(ai, "loadAiStreamState").mockImplementation(async (conversation) => ({
    type: "state",
    conversation,
    messages: [],
    hasMoreMessages: false,
    activeTurn: null,
  })),
  spyOn(ai.aiConversations, "listConversationTimeline").mockResolvedValue([]),
  stubRailSnapshot(),
  spyOn(announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
];
const readSpy = spyOn(ai.aiConversations, "getConversationByShortId").mockImplementation(async ({ shortId, ownerUserId }) =>
  shortId === own.shortId && ownerUserId === person.id ? own : null,
);
const viewedSpy = spyOn(ai.aiConversations, "markConversationViewed").mockResolvedValue(undefined as never);
const countSpy = spyOn(ai, "countAiOpenQuestions").mockResolvedValue(2);
const tokenSpy = spyOn(session, "getToken").mockReturnValue(null);
const sessionSpy = spyOn(session, "authenticateRequest").mockResolvedValue(null);
afterEach(() => {
  readSpy.mockClear();
  viewedSpy.mockClear();
  tokenSpy.mockReturnValue(null);
  sessionSpy.mockResolvedValue(null);
});
afterAll(() => {
  for (const spy of [...spies, limiter, readSpy, viewedSpy, countSpy, tokenSpy, sessionSpy]) spy.mockRestore();
  setSystemTime();
});

const signIn = (kind: "app" | "web", account: User = person) => {
  tokenSpy.mockReturnValue("test-session");
  sessionSpy.mockResolvedValue({
    user: account,
    data: { userId: account.id, sid: "test", authEpoch: 0, kind, expiresAt: "2099-01-01T00:00:00Z" },
  });
};

const routes = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps: [shell, app.meta] } as never);
    c.set("settings" as never, { app: { name: "Example Cloud" } } as never);
    await next();
  })
  .route("/api/assistant/pwa", pwaApi)
  .route("/pwa/assistant", pwaRoutes);

/** Only for parsing the HTML: the SSR render itself runs without browser globals. */
const parser = (() => {
  const dom = createDomTestHarness();
  dom.cleanup();
  return new dom.window.DOMParser();
})();

const render = async (path: string, headers: Record<string, string> = {}) => {
  const response = await routes.request(`https://cloud.example.test${path}`, {
    headers: { Cookie: "pwa_session=test-session", ...headers },
  });
  const html = await response.text();
  return { response, document: parser.parseFromString(html, "text/html") as unknown as Document };
};
const islandProps = (document: Document) =>
  fromJSON(JSON.parse(document.querySelector('solid-island[data-file*="AssistantPwa"]')?.getAttribute("data-props") ?? "null")) as {
    initialAddress: unknown;
    initialDetail: { conversation: { title: string } } | null;
    name: string;
    canConfigure: boolean;
  };

describe("The Assistant in the Cloud app", () => {
  test("declares its part first among the parts, for people with the user role, with a count of waiting questions", () => {
    expect(app.meta.pwa).toEqual({ href: "/pwa/assistant", requiresRoles: ["user"], badge: "/api/assistant/pwa/badge", order: 1 });
    expect(app.meta.routes).toContain("/pwa/assistant");
  });

  test("never answers a web session below /pwa/", async () => {
    signIn("web");
    const response = await routes.request("https://cloud.example.test/pwa/assistant", {
      headers: { Cookie: "session_token=test-session" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith("/pwa/_auth/session/launch?to=");
  });

  test("the start shows the part's name in the app's frame with the tab bar", async () => {
    signIn("app");
    const { response, document } = await render("/pwa/assistant");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(document.querySelector("h1.k2b-mobile-shell__title")?.textContent).toBe("Gustav");
    expect(document.querySelector(".k2b-mobile-shell")?.hasAttribute("data-k2b-screen")).toBe(false);
    expect(document.querySelectorAll(".assistant-pwa-row").length).toBe(1);
    const props = islandProps(document);
    expect(props.initialAddress).toEqual({ level: "start" });
    expect(props.name).toBe("Gustav");
    // App sessions carry no administration, so the way to set up AI never shows in the app.
    expect(props.canConfigure).toBe(false);
  });

  test("one of the person's chats opens as a screen of its own and counts as read", async () => {
    signIn("app");
    const { response, document } = await render("/pwa/assistant/c/Chat01");
    expect(response.status).toBe(200);
    expect(document.title).toContain("Velvet care");
    expect(document.querySelector(".k2b-mobile-shell")?.hasAttribute("data-k2b-screen")).toBe(true);
    expect(readSpy.mock.calls[0]?.[0]).toEqual({ shortId: "Chat01", ownerUserId: person.id });
    expect(viewedSpy.mock.calls[0]?.[0]).toEqual({ conversationId: own.id, ownerUserId: person.id });
    expect(islandProps(document).initialDetail?.conversation.title).toBe("Velvet care");
  });

  test("another person's chat or one that does not exist reads the same and names nothing", async () => {
    signIn("app");
    const { response, document } = await render("/pwa/assistant/c/Other01");
    expect(response.status).toBe(404);
    expect(document.title).toContain("Chat not available");
    expect(document.body.textContent).toContain("This chat does not exist, or it belongs to someone else.");
    expect(viewedSpy).not.toHaveBeenCalled();
    expect(islandProps(document).initialDetail).toBeNull();
  });

  test("a person without the user role gets the part's own refusal", async () => {
    signIn("app", guest);
    const { response, document } = await render("/pwa/assistant");
    expect(response.status).toBe(403);
    expect(document.querySelector(".k2b-placeholder")?.textContent).toContain("Gustav is not available to you");
  });

  test("the count route answers how many questions wait for the person", async () => {
    signIn("web");
    const response = await routes.request("https://cloud.example.test/api/assistant/pwa/badge", {
      headers: { Cookie: "session_token=test-session" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 2 });
    expect(countSpy).toHaveBeenCalledWith(person.id);
  });
});
