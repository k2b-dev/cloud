import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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
import * as automationWorkspace from "../service/automation-workspace";
import * as publicResources from "../service/public-resources";

const root = mkdtempSync(join(tmpdir(), "mail-automation-pages-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
// The real Mail page router, so a missing route registration fails here.
const { default: mailPages } = await import("./index");

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
] as const;

for (const page of pages) {
  test(`${page.path} answers 404 for a mailbox the caller may not read, as for an unknown address`, async () => {
    const load = spyOn(automationWorkspace, page.loader).mockResolvedValue(fail(err.forbidden("Access denied")));
    spies.push(load);
    const response = await request(page.path);
    expect(load).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Page not found");
  });

  test(`${page.path} keeps other refusals, such as a server failure`, async () => {
    spies.push(spyOn(automationWorkspace, page.loader).mockResolvedValue(fail(err.internal("Unavailable"))));
    expect((await request(page.path)).status).toBe(500);
  });
}
