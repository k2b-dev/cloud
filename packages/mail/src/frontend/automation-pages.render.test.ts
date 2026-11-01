import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as rail from "@k2b/cloud/services/rail-snapshot";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { createConfig } from "@k2b/ssr";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { MAIL_CONTACT_DIRECTORY_DEFAULTS, resolveMailContactDirectory } from "../contact-directory-settings";
import * as access from "../service/access";
import * as automationLog from "../service/automation-log";
import * as automationWorkspace from "../service/automation-workspace";
import * as contactDirectory from "../service/contact-directory";
import * as publicResources from "../service/public-resources";

const root = mkdtempSync(join(tmpdir(), "mail-automation-pages-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
// The real Mail page router, so a missing route registration fails here.
const { default: mailPages } = await import("./index");
const { automationLogHref } = await import("./automation-log-href");

const userId = "11111111-1111-4111-8111-111111111111";
const mailboxId = "22222222-2222-4222-8222-222222222222";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
beforeEach(() => {
  const user = buildProjectedUser({ id: userId, provider: "local", profile: "user", uid: "reader", display_name: "Test Reader" });
  spies.push(spyOn(services.session, "getToken").mockReturnValue("test-session"));
  spies.push(
    spyOn(services.session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
    }),
  );
  spies.push(spyOn(rail, "readRailSnapshot").mockResolvedValue({ revision: 0, visibility: {}, shortcuts: [], managedShortcuts: [] }));
  spies.push(spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(mailboxId));
});

const requestUrl = (url: string) =>
  new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
    .use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      await next();
    })
    .route("/app/mail", mailPages)
    .request(`https://cloud.example.test${url}`);
const request = (path: string) =>
  new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
    .use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      await next();
    })
    .route("/app/mail", mailPages)
    .request(`https://cloud.example.test/app/mail/Box001${path}`);

const pages = [
  { path: "/automations", loader: "loadMailAutomationOverview" },
  { path: "/automations/replies", loader: "loadMailAutomaticRepliesWorkspace" },
  { path: "/automations/incoming", loader: "loadMailIncomingAutomationsWorkspace" },
  { path: "/automations/activity", loader: "loadMailAutomationActivity" },
  { path: "/automations/workflows", loader: "loadMailWorkflowsWorkspace" },
  { path: "/automations/log", loader: "loadMailAutomationLog" },
] as const;

for (const page of pages) {
  test(`${page.path} answers 404 for a mailbox the caller may not read, as for an unknown address`, async () => {
    const load = spyOn(automationWorkspace, page.loader).mockResolvedValue(fail(err.forbidden("Access denied")));
    spies.push(load, spyOn(access, "requireMailboxAccess").mockResolvedValue(fail(err.forbidden("Access denied"))));
    const response = await request(page.path);
    expect(load).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Page not found");
  });

  test(`${page.path} keeps 403 for a member who may read the mailbox but not administer its automations`, async () => {
    spies.push(
      spyOn(automationWorkspace, page.loader).mockResolvedValue(fail(err.forbidden("Mailbox administration permission required"))),
      spyOn(access, "requireMailboxAccess").mockResolvedValue(ok({ scope: "mailbox", permission: "read", userId })),
    );
    expect((await request(page.path)).status).toBe(403);
  });

  test(`${page.path} keeps other refusals, such as a server failure`, async () => {
    spies.push(spyOn(automationWorkspace, page.loader).mockResolvedValue(fail(err.internal("Unavailable"))));
    expect((await request(page.path)).status).toBe(500);
  });
}

describe("the automation log the reader and the workspace link to", () => {
  const entryId = "44444444-4444-4444-8444-444444444444";
  const logData = (): automationWorkspace.MailAutomationLogData => ({
    mailbox: {
      accessScope: "mailbox",
      id: mailboxId,
      name: "Vertrieb Nord",
      description: null,
      health: "active",
      healthReason: null,
      syncEnabled: true,
      searchBackend: "postgres",
      automaticReplyManagementPermission: "admin",
      composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      timeZone: "Europe/Berlin",
    },
    permission: "read",
    log: { day: "2026-10-31", counts: { all: 0, assignments: 0, uncertain: 0, skipped: 0, manual: 0 }, items: [], nextCursor: null },
  });
  const stubPage = () => {
    const load = spyOn(automationWorkspace, "loadMailAutomationLog").mockResolvedValue(ok(logData()));
    const item = spyOn(automationLog, "getAutomationLogItem").mockResolvedValue(fail(err.notFound("Entry")));
    spies.push(
      load,
      item,
      spyOn(publicResources, "publicIds").mockResolvedValue(new Map([[mailboxId, "Box001"]])),
      spyOn(contactDirectory, "requestContactDirectory").mockResolvedValue(resolveMailContactDirectory(MAIL_CONTACT_DIRECTORY_DEFAULTS)),
    );
    return { load, item };
  };

  test("the workspace's log link opens the log page", async () => {
    const { load } = stubPage();
    const response = await requestUrl(automationLogHref("Box001"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("MailAutomationLogPage");
    expect(load.mock.calls[0]?.[1]).toBe(mailboxId);
  });

  test("the reader's link opens the log page at its entry", async () => {
    const { item } = stubPage();
    const response = await requestUrl(automationLogHref("Box001", entryId));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("MailAutomationLogPage");
    expect(item.mock.calls[0]?.slice(1)).toEqual([mailboxId, entryId]);
  });
});
