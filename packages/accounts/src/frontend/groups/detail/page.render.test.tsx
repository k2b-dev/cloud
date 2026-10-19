import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { accountsAppService, coreSettings, linuxIdentities } from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../../tests/fixtures/rail-snapshot";

const root = mkdtempSync(join(tmpdir(), "accounts-group-detail-render-"));
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
  app.get("/app/accounts/groups/:id", ...handler);
  return app;
};

const groupId = "22222222-2222-4222-8222-222222222222";
test("group sections are ViewTabs links, clearing tab filters and retaining list context", async () => {
  const empty = { items: [], page: 1, perPage: 100, total: 0, hasNext: false };
  const spies = [
    stubRailSnapshot(),
    spyOn(coreSettings, "get").mockResolvedValue(false),
    spyOn(linuxIdentities, "configuration").mockResolvedValue({
      enabled: false,
      rangeStart: 10000,
      rangeEnd: 20000,
      homeTemplate: "/home/{uid}",
      loginShell: "/bin/bash",
    }),
    spyOn(accountsAppService.group, "get").mockResolvedValue({
      id: groupId,
      name: "finance",
      provider: "local",
      description: null,
      gidnumber: null,
      personalOwner: null,
    }),
    spyOn(accountsAppService.accountRequest, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.parent, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.managedGroup, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.member, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.manager, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.entity, "list").mockResolvedValue(empty),
  ];
  try {
    const app = server();
    for (const current of ["members", "managers", "member-of"]) {
      const response = await app.request(
        `/app/accounts/groups/${groupId}?tab=${current}&search=ada&page=3&indirect=true&service_accounts=true&list_search=ops&list_page=2`,
        { headers: { "Accept-Language": "en" } },
      );
      const html = await response.text();
      expect(response.status, html).toBe(200);
      const nav = html.match(/<nav[^>]*class="k2b-view-tabs[^>]*>[\s\S]*?<\/nav>/)?.[0];
      expect(nav).toBeDefined();
      expect(nav).toContain('aria-label="Group detail sections"');
      expect(nav).not.toContain('role="tab"');
      expect(nav).not.toContain('data-variant="primary"');
      const links = [...nav!.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
      expect(links).toHaveLength(3);
      for (const [index, tab] of ["members", "managers", "member-of"].entries()) {
        const attrs = links[index]![1]!;
        expect(attrs).toContain(`href="/app/accounts/groups/${groupId}?list_search=ops&amp;list_page=2&amp;tab=${tab}"`);
        expect(attrs.includes('aria-current="page"')).toBe(tab === current);
        for (const cleared of ["&amp;search=", "&amp;page=", "indirect=", "service_accounts="]) expect(attrs).not.toContain(cleared);
      }
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
