import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ai from "@k2b/cloud/ai";
import * as live from "@k2b/cloud/ai/live";
import * as capabilityServer from "@k2b/cloud/capabilities/server";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as server from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as rail from "@k2b/cloud/services/rail-snapshot";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import * as chatContext from "../chat-context";
import * as projectContext from "../project-context";
import * as sidebar from "../sidebar";

const root = mkdtempSync(join(tmpdir(), "assistant-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
// After the Solid plugin: the shared Code page and Cloud's SSR are .tsx.
const cloudSsr = await import("@k2b/cloud/ssr");
const { codePageFixture } = await import("@k2b/cloud/ssr/code-page/code-page.fixture");

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
  // Core's Code queries answer empty unless a test says otherwise; no test reaches a real Core.
  codeInvoke = spyOn(capabilityServer, "invokeCapabilityWithDataSchema");
  spies.push(codeInvoke);
  mockCodeQueries([]);
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
  app.get("/app/assistant/code/:codeId", ...handler);
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
  expect(lookup).toHaveBeenCalledWith(project.shortId, {
    actor: { kind: "user", user, sessionKind: "app" },
    accessSubject: { type: "user", userId: user.id },
  });
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

test("?approvals=1 renders Waiting for you without selecting a chat, and the row stays when nothing waits", async () => {
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
  expect(html).toContain("Waiting for you");
  expect(html).toContain("What Gustav wants to do for you.");
  expect(html).toContain("Send the Q4 offer");
  expect(html).toContain('href="/app/assistant?approvals=1"');
  expect(html).toMatch(
    /href="\/app\/assistant\?approvals=1"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/app\/assistant\?approvals=1"/,
  );

  // Nothing waits: the row keeps its place, so the footer never moves; the view itself stays closed.
  pending.mockResolvedValue({ items: [], nextCursor: null, count: 0, elsewhere: 0 });
  const plain = await (await request("https://cloud.example.test/app/assistant")).text();
  expect(plain).toContain('href="/app/assistant?approvals=1"');
  expect(plain).not.toContain("What Gustav wants to do for you.");
});

const codeItem = {
  id: "c_week01",
  owner: { kind: "person", userId: user.id },
  title: "Weekly sales report",
  serviceAccountId: null,
  state: "active",
  activeVersionId: null,
  createdBy: user.id,
  createdAt: "2026-10-12T07:00:00.000Z",
  permission: "editor",
};
/** Core's public Code queries as the page calls them, with the person's credentials. */
let codeInvoke: ReturnType<typeof spyOn<typeof capabilityServer, "invokeCapabilityWithDataSchema">>;
const mockCodeQueries = (items: unknown[], options: { fail?: boolean } = {}) => {
  codeInvoke.mockImplementation(async (invocation, schema) => {
    if (options.fail) return { ok: false, error: { code: "APP_UNAVAILABLE", message: "Core is unavailable", status: 503 } };
    const data =
      invocation.capabilityId === "code.list"
        ? { items, nextCursor: null }
        : {
            items: [{ id: "run-1", state: "succeeded", createdAt: "2026-10-26T07:00:00.000Z", endedAt: "2026-10-26T07:00:04.000Z" }],
            nextCursor: null,
          };
    return { ok: true, data: { data: schema.parse(data) } };
  });
  return codeInvoke;
};

test("My apps & automations shows only for a person with Code, and ?code=1 renders their list from the server", async () => {
  spies.push(
    spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
      projects: [],
      doneCount: 0,
      questions: { items: [], count: 0 },
      conversations: [chat],
    }),
  );
  spies.push(spyOn(ai.aiConversations, "getConversationByShortId").mockResolvedValue(null));
  const invoke = mockCodeQueries([]);
  // No Code: no entry and no empty section.
  const none = await (await request("https://cloud.example.test/app/assistant")).text();
  expect(invoke).toHaveBeenCalledWith(
    { appId: "core", capabilityId: "code.list", kind: "query", input: { owner: { kind: "person", userId: user.id }, limit: 1 } },
    expect.anything(),
    expect.objectContaining({ locale: "en" }),
  );
  expect(none).not.toContain('href="/app/assistant?code=1"');
  expect(none).not.toContain("My apps &amp; automations");

  mockCodeQueries([codeItem]);
  const withCode = await (await request("https://cloud.example.test/app/assistant")).text();
  expect(withCode).toContain('href="/app/assistant?code=1"');
  const view = await (await request("https://cloud.example.test/app/assistant?code=1")).text();
  expect(view).toContain("Your Code runs as you.");
  expect(view).toContain("Weekly sales report");
  expect(view).toMatch(/href="\/app\/assistant\?code=1"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/app\/assistant\?code=1"/);
});

test("an unknown Code answer keeps the entry, and the list shows its error with a way to retry", async () => {
  spies.push(
    spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
      projects: [],
      doneCount: 0,
      questions: { items: [], count: 0 },
      conversations: [chat],
    }),
  );
  spies.push(spyOn(ai.aiConversations, "getConversationByShortId").mockResolvedValue(null));
  mockCodeQueries([], { fail: true });
  const plain = await (await request("https://cloud.example.test/app/assistant")).text();
  expect(plain).toContain('href="/app/assistant?code=1"');
  const view = await (await request("https://cloud.example.test/app/assistant?code=1")).text();
  expect(view).toContain("Your apps and automations could not be loaded");
  expect(view).toContain("Try again");
});

test("an existing chat still loads at its old address under the name Gustav", async () => {
  spies.push(
    spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
      projects: [],
      doneCount: 0,
      questions: { items: [], count: 0 },
      conversations: [chat],
    }),
  );
  mockCodeQueries([]);
  const lookup = spyOn(ai.aiConversations, "getConversationByShortId").mockResolvedValue(chat);
  spies.push(lookup);
  spies.push(spyOn(ai.aiConversations, "markConversationViewed").mockResolvedValue(true));
  spies.push(spyOn(ai.aiConversations, "listConversationTimeline").mockResolvedValue([]));
  spies.push(spyOn(ai, "loadAiStreamState").mockResolvedValue({ type: "state", conversation: chat, messages: [], activeTurn: null }));
  spies.push(spyOn(chatContext, "loadAssistantChatContextSnapshot").mockResolvedValue(null));
  const response = await request("https://cloud.example.test/app/assistant?conversation=chat1");
  // Same address, no redirect: links and bookmarks to old chats keep working.
  expect(response.status).toBe(200);
  expect(lookup).toHaveBeenCalledWith({ shortId: "chat1", ownerUserId: user.id });
  const html = await response.text();
  expect(html).toContain("<title>Gustav</title>");
  expect(html).toContain(chat.title);
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
  // No head row and no suggestions: "All chats" under the composer opens the application in the host window.
  expect(html).not.toContain("Open full view");
  expect(html).not.toContain("assistant-starters");
  const allChats = /<a[^>]*assistant-panel-link[^>]*>/.exec(html)?.[0] ?? "";
  expect(allChats).toContain('href="/app/assistant"');
  expect(allChats).toContain('target="_top"');
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

test("the panel names the place's Code from the first paint, through the place's own reader", async () => {
  spies.push(
    spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
      projects: [],
      doneCount: 0,
      questions: { items: [], count: 0 },
      conversations: [chat],
    }),
  );
  spies.push(spyOn(ai.aiConversations, "getConversationByShortId").mockResolvedValue(null));
  const mailbox = { type: "mail.mailbox", id: "m_info" };
  spies.push(
    spyOn(capabilityServer, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: {
        appId: "mail",
        appName: "Mail",
        appIcon: "ti ti-mail",
        appDescription: "Mail.",
        manifest: {
          protocolVersion: 2,
          appId: "mail",
          manifestHash: "a".repeat(64),
          types: [{ localId: "mailbox", title: "Mailbox", description: "A mailbox.", icon: "ti ti-mail", reader: "mailbox.read" }],
          queries: [
            {
              localId: "mailbox.read",
              title: "Read mailbox",
              description: "Read one mailbox.",
              inputSchema: {},
              dataSchema: {},
              schemaHash: "b".repeat(64),
              openWorld: false,
            },
          ],
          actions: [],
          commands: [],
        },
      },
    }),
  );
  codeInvoke.mockImplementation(async (invocation, schema) => {
    const data =
      invocation.appId === "mail"
        ? { view: { title: "info@example.test" } }
        : invocation.capabilityId === "code.list"
          ? {
              items: [{ ...codeItem, id: "c_info01", title: "Sort requests", owner: { kind: "resource", ref: mailbox } }],
              nextCursor: null,
            }
          : { items: [], nextCursor: null };
    const links = invocation.appId === "mail" ? [{ rel: "open" as const, href: "/app/mail/m/info" }] : undefined;
    return { ok: true, data: { data: schema.parse(data), ...(links ? { links } : {}) } };
  });
  const context = { v: 1, seq: 1, pageId: "88888888-8888-4888-8888-888888888888", app: "mail", scope: mailbox };
  const html = await (
    await request(`https://cloud.example.test/app/assistant/panel?cloud_panel_context=${encodeURIComponent(JSON.stringify(context))}`)
  ).text();
  expect(codeInvoke).toHaveBeenCalledWith(
    { appId: "core", capabilityId: "code.list", kind: "query", input: { owner: { kind: "resource", ref: mailbox }, limit: 20 } },
    expect.anything(),
    expect.anything(),
  );
  expect(html).toContain("Sort requests");
  expect(html).toContain("of info@example.test");
  expect(html).toContain("Open Mailbox");
  expect(html).toContain('href="/app/mail/m/info"');
});

const mailCatalog = (owners: string[]) =>
  spyOn(capabilityServer, "getCapabilityCatalogApp").mockResolvedValue({
    ok: true,
    data: {
      appId: "mail",
      appName: "Mail",
      appIcon: "ti ti-mail",
      appDescription: "Mail.",
      manifest: {
        protocolVersion: 2,
        appId: "mail",
        manifestHash: "a".repeat(64),
        types: [{ localId: "mailbox", title: "Mailbox", description: "A mailbox.", icon: "ti ti-mail", reader: "mailbox.read" }],
        queries: [
          {
            localId: "mailbox.read",
            title: "Read mailbox",
            description: "Read one mailbox.",
            inputSchema: {},
            dataSchema: {},
            schemaHash: "b".repeat(64),
            openWorld: false,
          },
        ],
        actions: [],
        commands: [],
        code: { access: { app: false, types: ["mailbox"] }, owners },
      },
    },
  });
const quietSidebar = () =>
  spies.push(
    spyOn(sidebar, "loadAssistantSidebarSnapshot").mockResolvedValue({
      projects: [],
      doneCount: 0,
      questions: { items: [], count: 0 },
      conversations: [chat],
    }),
    spyOn(ai.aiConversations, "getConversationByShortId").mockResolvedValue(null),
  );

test("a place that can own Code but has none says so in the panel; other places show nothing", async () => {
  quietSidebar();
  const mailbox = { type: "mail.mailbox", id: "m_info" };
  const catalog = mailCatalog(["mailbox"]);
  spies.push(catalog);
  codeInvoke.mockImplementation(async (invocation, schema) => {
    const data = invocation.appId === "mail" ? { view: { title: "info@example.test" } } : { items: [], nextCursor: null };
    return {
      ok: true,
      data: {
        data: schema.parse(data),
        ...(invocation.appId === "mail" ? { links: [{ rel: "open" as const, href: "/app/mail/m/info" }] } : {}),
      },
    };
  });
  const context = { v: 1, seq: 1, pageId: "88888888-8888-4888-8888-888888888888", app: "mail", scope: mailbox };
  const panel = `https://cloud.example.test/app/assistant/panel?cloud_panel_context=${encodeURIComponent(JSON.stringify(context))}`;
  const html = await (await request(panel)).text();
  expect(html).toContain("info@example.test has no Code yet.");
  expect(html).toContain("Create with Gustav");
  catalog.mockRestore();
  spies.push(mailCatalog([]));
  expect(await (await request(panel)).text()).not.toContain("has no Code yet");
});

test("a personal Code opens at its own address with the shared Code page; a malformed ID is not found", async () => {
  quietSidebar();
  const page = spyOn(cloudSsr, "loadCodePage").mockResolvedValue({
    ...codePageFixture("overview", "en"),
    owner: { kind: "person", ref: null, title: "Weekly sales report", typeTitle: null },
    href: "/app/assistant/code/c_woche1",
  });
  spies.push(page);
  const response = await request("https://cloud.example.test/app/assistant/code/c_woche1");
  expect(response.status).toBe(200);
  expect(page).toHaveBeenCalledWith(expect.anything(), {
    owner: { codeId: "c_woche1" },
    href: "/app/assistant/code/c_woche1",
    canManageOwner: false,
  });
  const html = await response.text();
  expect(html).toContain("Weekly sales report");
  expect(html).toContain("Your Code · runs as you");
  // The sidebar marks My apps & automations while a Code is open.
  expect(html).toMatch(/href="\/app\/assistant\?code=1"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/app\/assistant\?code=1"/);
  expect((await request("https://cloud.example.test/app/assistant/code/not-a-code")).status).toBe(404);
});

test("the Code list counts today's runs from the start of the person's day", async () => {
  quietSidebar();
  codeInvoke.mockImplementation(async (invocation, schema) => {
    const data =
      invocation.capabilityId === "code.run.count"
        ? { runs: 9, failed: 1 }
        : invocation.capabilityId === "code.list"
          ? { items: [codeItem], nextCursor: null }
          : { items: [], nextCursor: null };
    return { ok: true, data: { data: schema.parse(data) } };
  });
  const html = await (await request("https://cloud.example.test/app/assistant?code=1")).text();
  expect(html).toContain("Today 9 runs · 1 failed");
  expect(html).toContain('href="/app/assistant/code/c_week01"');
  const count = codeInvoke.mock.calls.find(([invocation]) => invocation.capabilityId === "code.run.count");
  expect(count?.[0].input).toEqual({ since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/) });
});

test("Waiting for you lists Code of a place the person administers when it needs them", async () => {
  quietSidebar();
  spies.push(mailCatalog(["mailbox"]));
  codeInvoke.mockImplementation(async (invocation, schema) => {
    const data =
      invocation.appId === "mail"
        ? { view: { title: "info@example.test" } }
        : invocation.capabilityId === "code.attention.list"
          ? {
              items: [
                {
                  code: { id: "c_info02", title: "Deliveries", owner: { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } } },
                  reasons: ["run_failed", "access_removed"],
                  lastRunAt: "2026-10-31T09:41:03.000Z",
                },
              ],
              nextCursor: null,
            }
          : { items: [], nextCursor: null };
    return {
      ok: true,
      data: {
        data: schema.parse(data),
        ...(invocation.appId === "mail" ? { links: [{ rel: "open" as const, href: "/app/mail/m/info" }] } : {}),
      },
    };
  });
  const html = await (await request("https://cloud.example.test/app/assistant?approvals=1")).text();
  expect(html).toContain("From your chats");
  expect(html).toContain("Code you administer");
  expect(html).toContain("Code of info@example.test: last run failed, access missing");
  expect(html).toContain("“Deliveries” · you administer info@example.test");
  expect(html).toContain('href="/app/mail/m/info"');
});
