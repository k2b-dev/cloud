import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";

const root = mkdtempSync(join(tmpdir(), "accounts-requests-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const user = {
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

const server = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/requests", ...handler);
  return app;
};

test("request status is URL navigation, with Pending as the default", async () => {
  const spies = [
    stubRailSnapshot(),
    spyOn(services.coreSettings, "get").mockResolvedValue(false),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    spyOn(services.accountsAppService.accountRequest, "list").mockResolvedValue({
      items: [],
      page: 1,
      perPage: 100,
      total: 0,
      hasNext: false,
    }),
  ];
  try {
    const app = server();
    for (const [query, current] of [
      ["?status=completed", "completed"],
      ["", "pending"],
    ]) {
      const response = await app.request(`/app/accounts/requests${query}`, { headers: { "Accept-Language": "en" } });
      const html = await response.text();
      expect(response.status, html).toBe(200);
      const nav = html.match(/<nav[^>]*aria-label="Request status"[^>]*>[\s\S]*?<\/nav>/)?.[0];
      expect(nav).toContain("k2b-view-tabs");
      const links = [...nav!.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
      expect(links).toHaveLength(4);
      for (const [index, status] of ["pending", "completed", "denied", "all"].entries()) {
        const [_, attrs, content] = links[index]!;
        expect(attrs).toContain(`href="/app/accounts/requests${status === "pending" ? "" : `?status=${status}`}"`);
        expect(content).toContain(status[0]!.toUpperCase() + status.slice(1));
        expect(attrs!.includes('aria-current="page"')).toBe(status === current);
        expect(attrs).not.toContain('data-variant="primary"');
      }
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
