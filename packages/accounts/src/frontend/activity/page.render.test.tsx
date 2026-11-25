import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as server from "@k2b/cloud/server";
import { accountsAppService, audit, notificationBatches } from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { AUDIT_EVENTS } from "../audit/render-fixture";
import { ADMIN, adminApp, BATCH_ID, BATCHES } from "../notifications/render-fixture";
import { DELETED, REMINDERS } from "./render-fixture";

const root = mkdtempSync(join(tmpdir(), "accounts-activity-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: activityPage } = await import("./page");
const { default: recordPage } = await import("./notification.page");
const { default: formerNotifications } = await import("../notifications/page");
const { default: formerBatch } = await import("../notifications/detail.page");
const { default: formerReminders } = await import("../reminders/page");
const { default: formerDeleted } = await import("../deleted-accounts/page");

const services = () => {
  const spies = {
    audit: spyOn(audit, "list").mockResolvedValue({
      items: AUDIT_EVENTS,
      page: 1,
      perPage: 100,
      total: AUDIT_EVENTS.length,
      hasNext: false,
    }),
    batches: spyOn(notificationBatches, "list").mockResolvedValue({ items: BATCHES, total: BATCHES.length, page: 1, perPage: 50 }),
    batch: spyOn(notificationBatches, "get").mockResolvedValue(BATCHES[0]!),
    recipients: spyOn(notificationBatches, "listRecipients").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 }),
    reminders: spyOn(accountsAppService.lifecycle.reminders, "list").mockResolvedValue({
      items: REMINDERS,
      total: REMINDERS.length,
      page: 1,
      perPage: 100,
    }),
    deleted: spyOn(accountsAppService.lifecycle.deletedAccounts, "list").mockResolvedValue({
      items: DELETED,
      total: DELETED.length,
      page: 1,
      perPage: 100,
    }),
  };
  const others = [
    stubRailSnapshot(),
    spyOn(server, "resolveDisplayNames").mockImplementation(async (entries) =>
      entries.map((entry) => ({ ...entry, displayName: "Ada Renz" })),
    ),
    spyOn(accountsAppService.accountRequest, "countPending").mockResolvedValue(2),
  ];
  return { spies, restore: () => [...Object.values(spies), ...others].forEach((spy) => spy.mockRestore()) };
};

const mount = (app: Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>) => {
  app.get("/app/accounts/activity", ...activityPage);
  app.get("/app/accounts/activity/notifications/:id", ...recordPage);
  app.get("/app/accounts/notifications", ...formerNotifications);
  app.get("/app/accounts/notifications/:id", ...formerBatch);
  app.get("/app/accounts/reminders", ...formerReminders);
  app.get("/app/accounts/deleted-accounts", ...formerDeleted);
  return app;
};

const de = { headers: { "Accept-Language": "de" } };

test("each kind reads its entries through its own service, with its own filters from the address", async () => {
  const { spies, restore } = services();
  const app = mount(adminApp());
  try {
    const notifications = await (await app.request("/app/accounts/activity?kind=notifications&status=failed", de)).text();
    expect(spies.batches.mock.calls.at(-1)?.[0]).toEqual({ page: 1, perPage: 50, status: "failed" });
    expect(notifications).toContain("Benachrichtigungen");
    expect(notifications).toContain(BATCHES[1]!.subject);
    expect(notifications).toContain(`/app/accounts/activity/notifications/${BATCH_ID}`);

    const reminders = await (await app.request("/app/accounts/activity?kind=reminders&status=error&q=ada", de)).text();
    expect(spies.reminders.mock.calls.at(-1)?.[0]).toEqual({ page: 1, perPage: 100, search: "ada", status: "error" });
    expect(reminders).toContain("SMTP: connection refused");

    const deleted = await (
      await app.request(`/app/accounts/activity?kind=deleted&reason=manual_delete&entry=${DELETED[1]!.id}`, de)
    ).text();
    expect(spies.deleted.mock.calls.at(-1)?.[0]).toEqual({ page: 1, perPage: 100, search: undefined, reason: "manual_delete" });
    // the open entry stands beside the list with its recorded metadata
    expect(deleted).toContain("Austritt zum 31.10.");

    // no other kind's service is asked
    expect(spies.audit).not.toHaveBeenCalled();
    const auditHtml = await (await app.request("/app/accounts/activity", de)).text();
    expect(spies.audit).toHaveBeenCalledTimes(1);
    expect(auditHtml).toContain("Protokoll");
  } finally {
    restore();
  }
});

test("“New notification” opens the form beside the batches, in the address", async () => {
  const { restore } = services();
  const app = mount(adminApp());
  try {
    const html = await (await app.request("/app/accounts/activity?kind=notifications&new=1", de)).text();
    // the form closes back to the list, and the list stays beside it
    expect(html).toContain('href="/app/accounts/activity?kind=notifications"');
    expect(html).toContain(BATCHES[1]!.subject);
    for (const word of ["Betreff", "Inhalt", "Empfängerauswahl", "Live-Vorschau", "Entwurf erstellen"]) expect(html).toContain(word);
  } finally {
    restore();
  }
});

test("only administrators see the activity or a batch, whatever kind the address names", async () => {
  const member = { ...ADMIN, id: "99999999-9999-4999-8999-999999999999", uid: "member", roles: ["user"] } satisfies User;
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: member });
    c.set("user", member);
    c.set("runtime", { apps: [] });
    await next();
  });
  mount(app);
  const { spies, restore } = services();
  try {
    for (const kind of ["", "?kind=notifications", "?kind=reminders", "?kind=deleted"]) {
      const response = await app.request(`/app/accounts/activity${kind}`);
      expect(response.status).toBe(403);
    }
    expect((await app.request(`/app/accounts/activity/notifications/${BATCH_ID}`)).status).toBe(403);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  } finally {
    restore();
  }
});

test("the former pages lead to their kind with every parameter, and a batch to its record", async () => {
  const app = mount(adminApp());
  const cases = [
    ["/app/accounts/notifications?status=draft&page=2", "/app/accounts/activity?kind=notifications&status=draft&page=2"],
    [`/app/accounts/notifications/${BATCH_ID}?recipient_status=error`, `/app/accounts/activity/notifications/${BATCH_ID}?status=error`],
    ["/app/accounts/reminders?search=ada&status=sent", "/app/accounts/activity?kind=reminders&status=sent&q=ada"],
    ["/app/accounts/deleted-accounts?reason=manual_delete&entry=e-1", "/app/accounts/activity?kind=deleted&reason=manual_delete&entry=e-1"],
  ] as const;
  for (const [from, to] of cases) {
    const response = await app.request(from);
    expect(response.status, from).toBe(302);
    expect(response.headers.get("location")).toBe(to);
  }
});

test("an unknown kind shows the audit log and says what did not apply", async () => {
  const { restore } = services();
  const app = mount(adminApp());
  try {
    const html = await (await app.request("/app/accounts/activity?kind=mail", de)).text();
    expect(html).toContain("kind=mail");
  } finally {
    restore();
  }
});
