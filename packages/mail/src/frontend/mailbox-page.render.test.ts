import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as layoutHelp from "@k2b/cloud/ssr/help";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { selectHtml } from "../../../../tests/fixtures/select-html";
import { resolveMailSearchRoute } from "../search-state";
import { focus, mailboxes, mailboxPreferences } from "../service";
import * as integrations from "../service/app-integrations";
import * as publicResources from "../service/public-resources";
import type { MailboxPageData } from "../service/workspace";
import * as workspace from "../service/workspace";
import * as sidebarData from "./mail-sidebar-data";

const root = mkdtempSync(join(tmpdir(), "mailbox-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./[mailboxId]/page");
const { default: focusHandler } = await import("./page");

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
  spies.push(
    spyOn(sidebarData, "loadMailSidebarData").mockResolvedValue({
      mailboxes: [],
      pinnedMailboxIds: [],
      hiddenMailboxIds: [],
    }),
  );
  spies.push(spyOn(layoutHelp, "preloadLayoutHelp").mockResolvedValue(null));
  spies.push(spyOn(services.coreSettings, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(services, "get").mockResolvedValue("https://cloud.example.test"));
});

const request = (query = "", focusPage = false) => {
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
  app.get("/app/mail", ...focusHandler);
  app.get("/app/mail/:mailboxId", ...handler);
  return app.request(`https://cloud.example.test/app/mail${focusPage ? "" : `/${mailboxShortId}`}${query}`);
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

test("active mailbox denied by workspace preserves 403 in the shared no-store HTML page", async () => {
  const resolve = spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(mailboxId);
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
  spies.push(resolve, load, integration);

  const response = await request();

  expect(resolve).toHaveBeenCalledWith(mailboxShortId);
  expect(load).toHaveBeenCalledTimes(1);
  expect(integration).toHaveBeenCalledWith({
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    credentialKind: "oauth",
    scopes: ["mail:read"],
  });
  expect(load.mock.calls[0]?.[0]).toMatchObject({
    mailboxId,
    context: {
      actor: { kind: "user", user },
      accessSubject: { type: "user", userId: user.id },
    },
  });
  expect(response.status).toBe(403);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("location")).toBeNull();
  const html = await response.text();
  expect(html).toContain("Access denied");
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
  expect(response.status).toBe(403);
  expect(load.mock.calls[0]?.[0].publicSearch).toEqual(
    resolveMailSearchRoute(new URL(`https://cloud.example.test/app/mail/${mailboxShortId}${query}`)),
  );
});

test("mailbox scope uses the public ID and Focus has no mailbox scope (#1471)", async () => {
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
    listTitle: "Needs action",
    conversationRowState: null,
    detailMessages: [],
    conversationSummary: null,
    conversationDrafts: [],
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
    spyOn(focus, "listFocusOverview").mockResolvedValue({
      ok: true,
      data: {
        pages: {
          mine: { items: [], nextCursor: null },
          unassigned: { items: [], nextCursor: null },
          waiting: { items: [], nextCursor: null },
          all: { items: [], nextCursor: null },
        },
        counts: { mine: 0, unassigned: 0, waiting: 0, all: 0 },
        mailboxCounts: [],
      },
    }),
  );
  const focusResponse = await request("", true);
  expect(focusResponse.status).toBe(200);
  const focusHtml = await focusResponse.text();
  const focusShell = JSON.parse(focusHtml.match(/id="cloud-shell-data" type="application\/json">([^<]*)/)![1]!);
  expect(focusShell.panel.context?.scope).toBeUndefined();
});
