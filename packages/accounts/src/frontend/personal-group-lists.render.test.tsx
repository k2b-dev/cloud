import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BaseGroup, type CloudRuntime, DEFAULT_ACCOUNT_CATEGORY_POLICY, type User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";

const root = mkdtempSync(join(tmpdir(), "accounts-personal-lists-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: groupsPage } = await import("./groups/page");
const { default: userPage } = await import("./users/detail/page");
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "quinn",
  provider: "local",
  profile: "user",
  roles: ["user", "admin"],
  givenname: "Quinn",
  sn: "Doe",
  displayName: "Quinn Doe",
  mail: "quinn@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
const personal: BaseGroup = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "quinn",
  provider: "local",
  description: null,
  gidnumber: 200000,
  personalOwner: { id: user.id, uid: user.uid, displayName: user.displayName },
};
const team: BaseGroup = { ...personal, id: "33333333-3333-4333-8333-333333333333", name: "Design team", personalOwner: null };
const inherited: BaseGroup = { ...team, id: "44444444-4444-4444-8444-444444444444", name: "Inherited team" };
const config = { enabled: true, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" };
const empty = { items: [], page: 1, perPage: 100, total: 0, hasNext: false };
const page = (items: BaseGroup[]) => ({ ...empty, items, total: items.length });

const server = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/groups", ...groupsPage);
  app.get("/app/accounts/users/:id", ...userPage);
  return app;
};

test("old personal-group list URLs use normal discovery and retain ordinary list context", async () => {
  const list = spyOn(services.accountsAppService.group, "list").mockResolvedValue(page([team]));
  const spies = [
    list,
    stubRailSnapshot(),
    spyOn(services.coreSettings, "get").mockResolvedValue(false),
    spyOn(services.linuxIdentities, "configuration").mockResolvedValue(config),
    spyOn(services.accountsAppService.accountRequest, "list").mockResolvedValue(empty),
  ];
  try {
    const response = await server().request("/app/accounts/groups?personal=1&scope=all&search=Design", {
      headers: { "Accept-Language": "en" },
    });
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expect(list).toHaveBeenCalledWith({
      pagination: { page: 1, perPage: 100 },
      filter: { search: "Design" },
      scope: { userId: undefined, mode: "all", provider: undefined },
    });
    expect(html).toContain("Design team");
    expect(html).not.toContain("personal=1");
    expect(html).not.toContain("list_personal");
    expect(html).toContain("list_search=Design");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test("direct and indirect user memberships hide personal groups and keep normal groups", async () => {
  const list = spyOn(services.accountsAppService.group, "list").mockImplementation(async (input) =>
    page(input.scope?.ids ? [personal, team] : input.scope?.mode === "member" ? [team, inherited] : []),
  );
  const spies = [
    list,
    stubRailSnapshot(),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    spyOn(services.coreSettings, "get").mockResolvedValue(false),
    spyOn(services.appApproval, "config").mockRejectedValue(new Error("Not configured")),
    spyOn(services.accountsAppService.user, "get").mockResolvedValue(user),
    spyOn(services.linuxIdentities, "get").mockResolvedValue({
      config,
      user: {
        id: user.id,
        uid: user.uid,
        displayName: user.displayName,
        provider: "local",
        profile: "user",
        identity: null,
        state: "ready",
      },
    }),
    spyOn(services.accountsAppService.accountRequest, "list").mockResolvedValue(empty),
    spyOn(services.accountsAppService.user.groupId, "list").mockResolvedValue([personal.id, team.id]),
    spyOn(services.serviceAccountCredentials, "listOverview").mockResolvedValue(empty),
    spyOn(services.appApproval, "listUserDevices").mockResolvedValue([]),
    spyOn(services.pwaDevices, "listUserDevices").mockResolvedValue([]),
  ];
  try {
    for (const query of ["", "?recursive=true"]) {
      const response = await server().request(`/app/accounts/users/${user.id}${query}`, { headers: { "Accept-Language": "en" } });
      const html = await response.text();
      expect(response.status, html).toBe(200);
      expect(html).toContain(`/app/accounts/groups/${team.id}`);
      expect(html).not.toContain(`/app/accounts/groups/${personal.id}`);
      expect(html.includes(`/app/accounts/groups/${inherited.id}`)).toBe(query !== "");
      expect(list).toHaveBeenCalledWith({ pagination: { page: 1, perPage: 1000 }, scope: { userId: user.id, mode: "member" } });
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
