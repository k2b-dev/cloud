import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as server from "@k2b/cloud/server";
import { accountsAppService, audit, notificationBatches } from "@k2b/cloud/services";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { AUDIT_EVENTS } from "../audit/render-fixture";
import { ADMIN, adminApp, BATCH_ID, BATCHES, batch, pageWeight, RECIPIENTS } from "../notifications/render-fixture";
import { DELETED, REMINDERS } from "./render-fixture";

// The weight of the activity page's kinds and a batch's record on the same invented data as the measurements of the
// former pages: their elements and the loading indicators on the first picture. The first picture comes with its data,
// so it shows no loader at all.
const root = mkdtempSync(join(tmpdir(), "accounts-admin-weight-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: activityPage } = await import("./page");
const { default: recordPage } = await import("./notification.page");

test("every kind of the activity page and a batch render their first picture with data and without a loader", async () => {
  const spies = [
    stubRailSnapshot(),
    spyOn(server, "resolveDisplayNames").mockImplementation(async (entries) =>
      entries.map((entry) => ({ ...entry, displayName: "Ada Renz" })),
    ),
    spyOn(accountsAppService.accountRequest, "countPending").mockResolvedValue(2),
    spyOn(audit, "list").mockResolvedValue({
      items: AUDIT_EVENTS,
      page: 1,
      perPage: 100,
      total: AUDIT_EVENTS.length,
      hasNext: false,
      hiddenAutomaticCount: 3,
    }),
    spyOn(notificationBatches, "list").mockResolvedValue({ items: BATCHES, total: BATCHES.length, page: 1, perPage: 50 }),
    spyOn(notificationBatches, "get").mockResolvedValue(batch(0, { selection: { userIds: [], groupIds: [] } })),
    spyOn(notificationBatches, "listRecipients").mockResolvedValue({ items: RECIPIENTS, total: RECIPIENTS.length, page: 1, perPage: 100 }),
    spyOn(accountsAppService.lifecycle.reminders, "list").mockResolvedValue({
      items: REMINDERS,
      total: REMINDERS.length,
      page: 1,
      perPage: 100,
    }),
    spyOn(accountsAppService.lifecycle.deletedAccounts, "list").mockResolvedValue({
      items: DELETED,
      total: DELETED.length,
      page: 1,
      perPage: 100,
    }),
  ];
  const app = adminApp();
  app.get("/app/accounts/activity", ...activityPage);
  app.get("/app/accounts/activity/notifications/:id", ...recordPage);
  try {
    const weights: Record<string, { elements: number; loaders: number }> = {};
    for (const path of [
      "/app/accounts/activity",
      "/app/accounts/activity?kind=notifications",
      "/app/accounts/activity?kind=reminders",
      "/app/accounts/activity?kind=deleted",
      `/app/accounts/activity/notifications/${BATCH_ID}`,
    ]) {
      const response = await app.request(path, { headers: { "Accept-Language": "de" } });
      const html = await response.text();
      expect(response.status, html.slice(0, 500)).toBe(200);
      weights[path] = pageWeight(html);
    }
    console.info(`page weight (${ADMIN.uid}): ${JSON.stringify(weights)}`);
    for (const weight of Object.values(weights)) expect(weight.loaders).toBe(0);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
