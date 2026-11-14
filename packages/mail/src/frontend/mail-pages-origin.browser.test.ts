import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as rail from "@k2b/cloud/services/rail-snapshot";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { createConfig } from "@k2b/ssr";
import { err, fail } from "@k2b/stdlib";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { checkFixtureSessionOrigin } from "../../../../scripts/fixtures/session-origin";
import { launchBrowser } from "../../../ui/test/browser";
import * as access from "../service/access";
import * as automationWorkspace from "../service/automation-workspace";
import * as publicResources from "../service/public-resources";

const root = mkdtempSync(join(tmpdir(), "mail-origin-pages-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
const { default: mailPages } = await import("./index");
const userId = "11111111-1111-4111-8111-111111111111";
const mailboxId = "22222222-2222-4222-8222-222222222222";
const pages = [
  ["/automations", "loadMailAutomationOverview"],
  ["/automations/replies", "loadMailAutomaticRepliesWorkspace"],
  ["/automations/incoming", "loadMailIncomingAutomationsWorkspace"],
  ["/automations/activity", "loadMailAutomationActivity"],
  ["/automations/workflows", "loadMailWorkflowsWorkspace"],
] as const;
const spies: Array<{ mockRestore(): void }> = [];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const user = buildProjectedUser({ id: userId, provider: "local", profile: "user", uid: "reader", display_name: "Test Reader" });
  spies.push(spyOn(services.session, "getToken").mockReturnValue("fixture-session"));
  spies.push(
    spyOn(services.session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId, sid: "fixture-session", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
    }),
  );
  spies.push(
    spyOn(services.announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
  );
  spies.push(
    spyOn(rail, "readRailSnapshot").mockResolvedValue({
      revision: 0,
      visibility: {},
      shortcuts: [],
      showNames: true,
      managedShortcuts: [],
    }),
  );
  spies.push(spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(mailboxId));
  spies.push(spyOn(access, "requireMailboxAccess").mockResolvedValue(fail(err.forbidden("Access denied"))));
  for (const [, loader] of pages) spies.push(spyOn(automationWorkspace, loader).mockResolvedValue(fail(err.forbidden("Access denied"))));
  const router = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
    .use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      return next();
    })
    .route("/app/mail", mailPages);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const refused = await checkFixtureSessionOrigin(request);
      return refused ?? router.fetch(request);
    },
  });
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  for (const spy of spies) spy.mockRestore();
  // Keep the temporary build directory; it contains no credentials.
});

test("real Mail 404 pages remain reachable to a session browser without an Origin on GET", async () => {
  const context = await browser.newContext();
  try {
    await context.addCookies([{ name: "session_token", value: "fixture-session", url: server.url.origin }]);
    const page = await context.newPage();
    for (const [path] of pages) {
      const response = await page.goto(new URL(`/app/mail/Box001${path}`, server.url).href);
      expect(response?.status()).toBe(404);
      expect(await page.locator("body").innerText()).toContain("Page not found");
    }
  } finally {
    await context.close();
  }
}, 30_000);
