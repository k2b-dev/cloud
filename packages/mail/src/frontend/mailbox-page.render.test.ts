import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ai from "@k2b/cloud/ai";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import { type AuthContext, REQUEST_IDLE_TIMEOUT_SECONDS } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as layoutHelp from "@k2b/cloud/ssr/help";
import { createConfig } from "@k2b/ssr";
import { err, fail } from "@k2b/stdlib";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { selectHtml } from "../../../../tests/fixtures/select-html";
import { resolveMailSearchRoute } from "../search-state";
import { mailboxes, mailboxPreferences } from "../service";
import * as access from "../service/access";
import * as integrations from "../service/app-integrations";
import * as publicResources from "../service/public-resources";
import { CountRefreshBusy } from "../service/view-count-cache";
import type { MailboxPageData } from "../service/workspace";
import * as workspace from "../service/workspace";
import * as sidebarData from "./mail-sidebar-data";

const root = mkdtempSync(join(tmpdir(), "mailbox-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./[mailboxId]/page");
const { default: landingHandler } = await import("./page");

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
const mailboxId = "22222222-2222-4222-8222-222222222222";
const mailboxShortId = "Box001";
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
beforeEach(() => {
  spies.push(stubRailSnapshot());
  spies.push(spyOn(access, "requireMailboxAccess").mockResolvedValue({ ok: true, data: { scope: "mailbox", permission: "read" } }));
  spies.push(
    spyOn(sidebarData, "loadMailSidebarData").mockResolvedValue({
      mailboxes: [],
      pinnedMailboxIds: [],
      hiddenMailboxIds: [],
      focusNoticeOpen: false,
    }),
  );
  spies.push(spyOn(layoutHelp, "preloadLayoutHelp").mockResolvedValue(null));
  spies.push(spyOn(services.coreSettings, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(services, "get").mockResolvedValue("https://cloud.example.test"));
  // The inline draft offers dictation; its availability reads AI settings, which these renders do not start.
  spies.push(spyOn(ai, "getLiveDictationStatus").mockResolvedValue({ available: false, reason: "not_configured" }));
});

const request = (query = "", landingPage = false, env?: { timeout(request: Request, seconds: number): void }) => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("credentialKind", "oauth");
    c.set("credentialScopes", ["mail:read"]);
    c.set("runtime", {
      apps: [
        {
          id: "mail",
          name: "Mail",
          icon: "ti ti-mail",
          description: "Fixture",
          routes: ["/app/mail"],
          panel: { href: "/app/mail/panel", label: "Mail", icon: "ti ti-mail" },
        },
      ],
    });
    await next();
  });
  app.get("/app/mail", ...landingHandler);
  app.get("/app/mail/:mailboxId", ...handler);
  return app.request(`https://cloud.example.test/app/mail${landingPage ? "" : `/${mailboxShortId}`}${query}`, {}, env);
};

test("missing or deleted active mailbox renders shared HTML 404 before loading workspace data", async () => {
  const resolve = spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(null);
  const load = spyOn(workspace, "loadMailboxPageData").mockRejectedValue(new Error("Unexpected workspace load"));
  const integration = spyOn(integrations, "getSpacesMailIntegrationAvailability").mockRejectedValue(
    new Error("Unexpected integration lookup"),
  );
  spies.push(resolve, load, integration);

  const response = await request();

  expect(resolve).toHaveBeenCalledWith(mailboxShortId);
  expect(load).not.toHaveBeenCalled();
  expect(integration).not.toHaveBeenCalled();
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("location")).toBeNull();
  const html = await response.text();
  expect(html).toContain("Page not found");
  expect(html).toContain("Go to home page");
  expect(html).not.toContain("MailWorkspace");
});

test("mailbox SSR keeps the count wait budget and restores the normal timeout on overload", async () => {
  const timeouts: number[] = [];
  spies.push(spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(mailboxId));
  spies.push(
    spyOn(integrations, "getSpacesMailIntegrationAvailability").mockResolvedValue({
      invitations: false,
      settings: false,
      composer: false,
      context: false,
    }),
  );
  spies.push(
    spyOn(workspace, "loadMailboxPageData").mockImplementation(async () => {
      await Bun.sleep(0);
      expect(timeouts).toEqual([40]);
      throw new CountRefreshBusy("Mailbox counts are still refreshing; retry the request");
    }),
  );

  const response = await request("", false, {
    timeout: (_request, seconds) => {
      timeouts.push(seconds);
    },
  });

  expect(response.status).toBe(503);
  expect(timeouts).toEqual([40, REQUEST_IDLE_TIMEOUT_SECONDS]);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const html = await response.text();
  expect(html).toContain("Go to home page");
  expect(html).not.toContain("MailWorkspace");
  expect(html).not.toContain("Mailbox counts are still refreshing");
});

test("an active mailbox the caller may not read answers the shared no-store 404 page, as for an unknown address", async () => {
  const resolve = spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(mailboxId);
  const select = spyOn(workspace, "resolveWorkspaceRequest").mockRejectedValue(new Error("Unexpected workspace selection"));
  const load = spyOn(workspace, "loadMailboxPageData").mockResolvedValue({
    ok: false,
    error: { code: "FORBIDDEN", message: "Internal mailbox permission details", status: 403 },
  });
  const integration = spyOn(integrations, "getSpacesMailIntegrationAvailability").mockResolvedValue({
    invitations: false,
    settings: false,
    composer: false,
    context: false,
  });
  spies.push(resolve, select, load, integration);

  spies.push(spyOn(access, "requireMailboxAccess").mockResolvedValue(fail(err.forbidden("Access denied"))));

  const response = await request();

  expect(resolve).toHaveBeenCalledWith(mailboxShortId);
  expect(select).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(integration).not.toHaveBeenCalled();
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("location")).toBeNull();
  const html = await response.text();
  expect(html).toContain("Page not found");
  expect(html).toContain("Go to home page");
  expect(html).not.toContain("Internal mailbox permission details");
  expect(html).not.toContain(mailboxId);
  expect(html).not.toContain("MailWorkspace");
});

test.each([
  "?q=invoice&qFields=from,subject",
  `?${new URLSearchParams({ search: JSON.stringify({ expression: { type: "local_tag_id", tagId: "Tag001" }, sort: "newest" }) })}`,
  "?search=invalid&q=invoice",
])("SSR passes the request's resolved public search to its snapshot loader: %s", async (query) => {
  spies.push(spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(mailboxId));
  spies.push(spyOn(publicResources, "resolveExistingMailboxPublicIds").mockResolvedValue(new Map()));
  const load = spyOn(workspace, "loadMailboxPageData").mockResolvedValue({
    ok: false,
    error: { code: "FORBIDDEN", message: "Denied", status: 403 },
  });
  spies.push(
    load,
    spyOn(integrations, "getSpacesMailIntegrationAvailability").mockResolvedValue({
      invitations: false,
      settings: false,
      composer: false,
      context: false,
    }),
  );
  const response = await request(query);
  // A readable mailbox retains the snapshot loader's precise permission error.
  expect(response.status).toBe(403);
  expect(load.mock.calls[0]?.[0].publicSearch).toEqual(
    resolveMailSearchRoute(new URL(`https://cloud.example.test/app/mail/${mailboxShortId}${query}`)),
  );
});

test("mailbox scope uses the public ID and Mail's page without a mailbox has no mailbox scope (#1471)", async () => {
  const snapshot: MailboxPageData = {
    viewPreference: { large: "auto", phone: "compact" },
    doneTodayCounts: { doneToday: 0, doneByAutomation: 0 },
    receivingAddress: null,
    mailbox: {
      id: mailboxId,
      name: "Support",
      description: null,
      health: "active",
      healthReason: null,
      syncEnabled: true,
      searchBackend: "postgres",
      automaticReplyManagementPermission: "admin",
      accessScope: "mailbox",
      draftEditMode: "lock",
      composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    permission: "read",
    access: { scope: "mailbox", permission: "read" },
    initialLiveCursor: null,
    folders: [],
    identities: [],
    scheduledMode: false,
    scheduledCount: 0,
    scheduledPage: null,
    scheduledError: null,
    draftsMode: false,
    draftsPage: null,
    draftsError: null,
    eventsMode: false,
    eventsPage: null,
    eventsError: null,
    activeView: "needs_action",
    savedViewId: null,
    savedViews: [],
    listMode: "conversations",
    folderId: null,
    viewCounts: { needs_action: 0, mine: 0, unassigned: 0, waiting: 0, done: 0, snoozed: 0, send_problems: 0, recently_active: 0, kept: 0 },
    query: "",
    search: { query: "", expression: null, sort: "relevance", error: null },
    selectedConversationId: null,
    selectedMessageId: null,
    listItems: [],
    listCursor: null,
    nextListCursor: null,
    listError: null,
    hiddenDone: null,
    assignedGroups: null,
    listTitle: "Needs action",
    conversationRowState: null,
    detailMessages: [],
    conversationSummary: null,
    conversationDrafts: [],
    automationTrace: [],
    detailError: null,
    collaborationState: null,
    localTags: [],
    conversationLocalTags: null,
    comments: [],
    commentsCursor: null,
    assignableUsers: [],
    activity: [],
    reminder: null,
    keep: null,
    collaborationError: null,
    detailErrors: {
      collaboration: null,
      tags: null,
      comments: null,
      assignableUsers: null,
      activity: null,
      reminder: null,
      keep: null,
      reference: null,
      summary: null,
      drafts: null,
    },
    selectedSubject: "",
    selectedReference: null,
  };
  spies.push(
    spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(mailboxId),
    spyOn(publicResources, "publicIds").mockResolvedValue(new Map([[mailboxId, mailboxShortId]])),
    spyOn(workspace, "loadMailboxPageData").mockResolvedValue({ ok: true, data: snapshot }),
    spyOn(integrations, "getSpacesMailIntegrationAvailability").mockResolvedValue({
      invitations: false,
      settings: false,
      composer: false,
      context: false,
    }),
  );
  const response = await request();
  expect(response.status).toBe(200);
  const html = await response.text();
  const shell = JSON.parse(html.match(/id="cloud-shell-data" type="application\/json">([^<]*)/)![1]!);
  expect(shell.panel.context.scope).toEqual({ type: "mail.mailbox", id: mailboxShortId });
  expect(shell.panel.context.scope.id).not.toBe(mailboxId);
  // The keyed session must publish the open mailbox before the outer sidebar's first SSR render.
  expect(await selectHtml(html, ".mail-workspace")).toHaveLength(1);
  expect(await selectHtml(html, ".mail-workspace .k2b-app-workspace__head")).toHaveLength(1);
  expect(await selectHtml(html, ".mail-workspace .mail-sidebar")).toHaveLength(1);
  expect((await selectHtml(html, `[data-mailbox="${mailboxShortId}"]`))[0]?.attributes["data-open"]).toBe("true");
  spies.push(
    spyOn(mailboxes, "listMailboxes").mockResolvedValue({ ok: true, data: [] }),
    spyOn(mailboxPreferences, "listMailboxPreferences").mockResolvedValue({ pinnedMailboxIds: [], hiddenMailboxIds: [] }),
  );
  // Without a mailbox, Mail's own page shows the setup and reports no mailbox scope.
  const landingResponse = await request("", true);
  expect(landingResponse.status).toBe(200);
  const landingHtml = await landingResponse.text();
  const landingShell = JSON.parse(landingHtml.match(/id="cloud-shell-data" type="application\/json">([^<]*)/)![1]!);
  expect(landingShell.panel.context?.scope).toBeUndefined();
});
