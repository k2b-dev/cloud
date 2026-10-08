import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { accountsAppService, type NotificationBatchRecipient, notificationBatches } from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";

const root = mkdtempSync(join(tmpdir(), "accounts-notification-detail-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./detail.page");

const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  roles: ["user", "admin"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: "admin@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
const batchId = "22222222-2222-4222-8222-222222222222";
const recipient = (n: number, status: NotificationBatchRecipient["status"], mail: NotificationBatchRecipient["outgoingMailStatus"]) => ({
  batchId,
  userId: `33333333-3333-4333-8333-00000000000${n}`,
  recipient: `reader${n}@example.test`,
  uid: `reader${n}`,
  displayName: `Reader ${n}`,
  avatarHash: null,
  provider: "local" as const,
  profile: "user" as const,
  status,
  notificationId: null,
  outgoingMailId: mail ? `44444444-4444-4444-8444-00000000000${n}` : null,
  outgoingMailStatus: mail,
  error: null,
  attemptCount: 1,
  sentAt: status === "sent" ? "2026-10-08T08:00:00.000Z" : null,
  updatedAt: "2026-10-08T08:00:00.000Z",
});

test("batch recipients show mail status where it differs from the recipient status", async () => {
  const spies = [
    stubRailSnapshot(),
    spyOn(accountsAppService.accountRequest, "list").mockResolvedValue({ items: [], page: 1, perPage: 50, total: 0, hasNext: false }),
    spyOn(notificationBatches, "get").mockResolvedValue({
      id: batchId,
      subject: "Maintenance window",
      bodyMarkdown: "Hello",
      bodyHtml: "<p>Hello</p>",
      selection: {},
      selectionHash: "hash",
      status: "running",
      createdBy: admin.id,
      finalizedBy: admin.id,
      createdAt: "2026-10-08T07:00:00.000Z",
      finalizedAt: "2026-10-08T07:00:00.000Z",
      startedAt: "2026-10-08T07:00:00.000Z",
      completedAt: null,
      targetCount: 3,
      deliverableCount: 3,
      sentCount: 2,
      skippedCount: 0,
      errorCount: 0,
      lastError: null,
    }),
    // A bounced mail still counts as sent for the recipient; a paced one is still queued.
    spyOn(notificationBatches, "listRecipients").mockResolvedValue({
      items: [recipient(1, "sent", "bounced"), recipient(2, "sending", "queued"), recipient(3, "sent", "sent")],
      total: 3,
      page: 1,
      perPage: 100,
    }),
  ];
  try {
    const server = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    server.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user: admin });
      c.set("user", admin);
      c.set("runtime", { apps: [] });
      await next();
    });
    server.get("/app/accounts/notifications/:id", ...handler);
    for (const locale of ["en", "de"]) {
      const response = await server.request(`/app/accounts/notifications/${batchId}`, { headers: { "Accept-Language": locale } });
      const html = await response.text();
      expect(response.status, html).toBe(200);
      expect(html).toContain(locale === "de" ? "E-Mail: Unzustellbar" : "Mail: Bounced");
      expect(html).toContain(locale === "de" ? "E-Mail: In Warteschlange" : "Mail: Queued");
      expect(html).not.toContain(locale === "de" ? "E-Mail: Gesendet" : "Mail: Sent");
      expect(html).toContain('title="44444444-4444-4444-8444-000000000001"');
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
