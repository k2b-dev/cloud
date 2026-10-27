import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ai from "@k2b/cloud/ai";
import * as live from "@k2b/cloud/ai/live";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as server from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as rail from "@k2b/cloud/services/rail-snapshot";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import * as projectContext from "../project-context";
import * as sidebar from "../sidebar";

const root = mkdtempSync(join(tmpdir(), "assistant-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Reader",
  displayName: "Test Reader",
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
const project = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "project123",
  name: "Selected project",
  description: "",
  icon: "ti ti-folders",
  instructions: "",
  defaultModel: null,
  permission: "read",
  revision: 1,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
} satisfies ai.AiProject;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
beforeEach(() => {
  spies.push(spyOn(ai, "getAiChatQuotas").mockResolvedValue({ enabled: false, balances: [] }));
  spies.push(spyOn(rail, "readRailSnapshot").mockResolvedValue({ revision: 0, visibility: {}, shortcuts: [], managedShortcuts: [] }));
  spies.push(spyOn(live.aiLive, "cursor").mockResolvedValue("s6t.cloud-live-core.0"));
  spies.push(
    spyOn(ai, "assistantAiSettingsState").mockResolvedValue({
      ok: true,
      enabled: false,
      status: "ok",
      selection: null,
      effectiveDefault: { class: "balanced" },
      classes: [],
      visionModelConfigured: false,
      audioModelConfigured: false,
      error: null,
      firecrawlConfigured: false,
      options: [],
    }),
  );
  spies.push(spyOn(ai, "listAssistantAiModels").mockResolvedValue([]));
  spies.push(spyOn(server, "loadPendingApprovals").mockResolvedValue({ items: [], nextCursor: null, count: 0, elsewhere: 0 }));
  spies.push(
    spyOn(ai.aiUserPrefs, "get").mockResolvedValue({
      userId: user.id,
      memoryEnabled: true,
      memoryLearningEnabled: false,
      selection: null,
      updatedAt: project.updatedAt,
    }),
  );
  spies.push(spyOn(services.coreSettings, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(services, "get").mockResolvedValue("https://cloud.example.test"));
});

const request = (href = "https://cloud.example.test/app/assistant?project=project123") => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user, sessionKind: "app" });
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("credentialKind", "session");
    c.set("credentialScopes", []);
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/assistant", ...handler);
  app.get("/app/assistant/panel", ...handler);
  return app.request(href);
};

test("missing or revoked selected project returns opaque HTML404 despite a stale sidebar", async () => {
  spies.push(
    spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
      projects: [{ ...project, id: project.shortId }],
      doneCount: 0,
      questions: { items: [], count: 0 },
      conversations: [],
    }),
  );
  spies.push(spyOn(ai.aiProjects, "getByShortId").mockResolvedValue(null));
  const chats = spyOn(ai.aiConversations, "listConversationsPage");
  spies.push(chats);
  const response = await request();
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("location")).toBeNull();
  expect(await response.text()).not.toContain(project.name);
  expect(chats).not.toHaveBeenCalled();
});

test("authorized project omitted by sidebar cap remains in the rendered workspace with public IDs", async () => {
  spies.push(
    spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
      projects: [],
      doneCount: 0,
      questions: { items: [], count: 0 },
      conversations: [],
    }),
  );
  const lookup = spyOn(ai.aiProjects, "getByShortId").mockResolvedValue(project);
  const chats = spyOn(ai.aiConversations, "listConversationsPage").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    perPage: 20,
    hasNext: false,
  });
  spies.push(lookup, chats);
  spies.push(
    spyOn(projectContext, "loadAssistantProjectContextSnapshot").mockImplementation(async (authority) => {
      expect(authority).toMatchObject({
        actor: { kind: "user", sessionKind: "app" },
        accessSubject: { type: "user", userId: user.id },
        credentialKind: "session",
        scopes: [],
      });
      return {
        projectId: project.shortId,
        knowledge: [],
        files: [],
        references: [],
        skills: { items: [], page: 1, hasNext: false },
        apps: { items: [], page: 1, hasNext: false },
      };
    }),
  );
  const response = await request();
  expect(response.status).toBe(200);
  expect(lookup).toHaveBeenCalledWith(project.shortId, { type: "user", userId: user.id });
  expect(chats).toHaveBeenCalledWith({ ownerUserId: user.id, projectId: project.id, page: 1, perPage: 20 });
  const html = await response.text();
  expect(html).toContain(project.name);
  expect(html).toContain(project.shortId);
  expect(html).not.toContain(project.id);
});

const chat = {
  id: "chat1",
  shortId: "chat1",
  title: "Offer Q4",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "2026-10-08T09:00:00.000Z",
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: user.id,
  createdAt: "2026-10-08T09:00:00.000Z",
  updatedAt: "2026-10-08T09:00:00.000Z",
} satisfies ai.AiConversation;
const approval = {
  id: "33333333-3333-4333-8333-333333333333",
  app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
  action: "draft.send",
  assurance: "confirm" as const,
  sentence: "Mail: Send the Q4 offer",
  review: null,
  requester: { kind: "chat" as const, appId: "assistant", title: "Offer Q4", href: "/app/assistant?conversation=chat1" },
  remember: { chat: false, always: false, website: false },
  createdAt: "2026-10-08T09:00:00.000Z",
  expiresAt: "2026-10-09T09:00:00.000Z",
};

test("?approvals=1 renders the approvals view without selecting a chat, and the row only while something waits", async () => {
  spies.push(
    spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
      projects: [],
      doneCount: 0,
      questions: { items: [], count: 0 },
      conversations: [chat],
    }),
  );
  const lookup = spyOn(ai.aiConversations, "getConversationByShortId").mockResolvedValue(null);
  spies.push(lookup);
  const pending = spyOn(server, "loadPendingApprovals").mockResolvedValue({ items: [approval], nextCursor: null, count: 1, elsewhere: 0 });
  spies.push(pending);
  const response = await request("https://cloud.example.test/app/assistant?approvals=1");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(pending).toHaveBeenCalledWith(expect.anything(), { app: "assistant" });
  // The view replaces the chat: no chat is loaded, so the first open chat is not selected behind it.
  expect(lookup).not.toHaveBeenCalled();
  expect(html).toContain("What the Assistant wants to do for you.");
  expect(html).toContain("Send the Q4 offer");
  expect(html).toContain('href="/app/assistant?approvals=1"');
  expect(html).toMatch(
    /href="\/app\/assistant\?approvals=1"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/app\/assistant\?approvals=1"/,
  );

  // Nothing waits: a chat page has no Approvals row.
  pending.mockResolvedValue({ items: [], nextCursor: null, count: 0, elsewhere: 0 });
  const plain = await (await request("https://cloud.example.test/app/assistant")).text();
  expect(plain).not.toContain('href="/app/assistant?approvals=1"');
  expect(plain).not.toContain("What the Assistant wants to do for you.");
});

test("the panel starts without selecting an unrelated recent chat and renders no second shell", async () => {
  spies.push(
    spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
      projects: [],
      doneCount: 0,
      questions: { items: [], count: 0 },
      conversations: [chat],
    }),
  );
  const lookup = spyOn(ai.aiConversations, "getConversationByShortId").mockResolvedValue(null);
  spies.push(lookup);
  const response = await request("https://cloud.example.test/app/assistant/panel");
  expect(response.status).toBe(200);
  expect(response.headers.get("referrer-policy")).toBe("same-origin");
  const html = await response.text();
  expect(lookup).not.toHaveBeenCalled();
  expect(html).toContain("cloud-panel-page");
  expect(html).not.toContain('id="cloud-shell-data"');
  expect(html).toContain('href="/app/assistant/panel?conversation=chat1"');
  expect(html).toContain("Open full view");
});

test("a panel conversation selector does not bypass ownership or fall back to another chat", async () => {
  spies.push(
    spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
      projects: [],
      doneCount: 0,
      questions: { items: [], count: 0 },
      conversations: [chat],
    }),
  );
  const lookup = spyOn(ai.aiConversations, "getConversationByShortId").mockResolvedValue(null);
  spies.push(lookup);
  const response = await request("https://cloud.example.test/app/assistant/panel?conversation=foreign");
  expect(response.status).toBe(404);
  expect(lookup).toHaveBeenCalledWith({ shortId: "foreign", ownerUserId: user.id });
  expect(await response.text()).not.toContain(chat.title);
});
