import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, GroupRelations, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { accountsAppService, coreSettings, linuxIdentities } from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "accounts-group-relations-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
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

const all = "00000000-0000-4000-8000-000000000001";
const tech = "00000000-0000-4000-8000-000000000002";
const relations: GroupRelations = {
  focus: tech,
  depth: 2,
  managers: false,
  groupCount: 2,
  nodes: [
    { id: all, name: "All staff", provider: "local", members: 3, contains: 1, inCycle: false },
    { id: tech, name: "Engineering", provider: "ipa", members: 4, contains: 0, inCycle: false },
  ],
  columns: [{ key: "u1", items: [{ id: all, via: tech }], backs: [], hidden: 0 }],
  roots: null,
  selected: {
    id: tech,
    parents: { ids: [all], total: 1 },
    children: { ids: [], total: 0 },
    manages: null,
    managedBy: null,
    cycle: null,
    managerCycle: null,
  },
  cycles: { count: 0, first: null },
  truncated: false,
  cyclesComplete: true,
};

type App = Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>;

const serve = async (result: () => ReturnType<typeof accountsAppService.group.relations>, run: (app: App) => Promise<void>) => {
  const relationsSpy = spyOn(accountsAppService.group, "relations").mockImplementation(result);
  const spies = [
    stubRailSnapshot(),
    relationsSpy,
    spyOn(coreSettings, "get").mockResolvedValue(false),
    spyOn(linuxIdentities, "configuration").mockResolvedValue({
      enabled: false,
      rangeStart: 10000,
      rangeEnd: 20000,
      homeTemplate: "/home/{uid}",
      loginShell: "/bin/bash",
    }),
    spyOn(accountsAppService.accountRequest, "countPending").mockResolvedValue(0),
  ];
  const app: App = new Hono();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/groups/relations", ...handler);
  try {
    await run(app);
    // Read before the spies are restored, which clears their calls.
    return relationsSpy.mock.calls.map(([config]) => config);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

const html = async (app: App, path: string) => (await app.request(path, { headers: { "Accept-Language": "en" } })).text();

test("the server renders levels, details, and links that keep the URL state", async () => {
  await serve(
    async () => ({ ok: true, data: relations }),
    async (app) => {
      const page = await html(app, `/app/accounts/groups/relations?focus=${tech}&depth=3&managers=1`);
      expect(page).toContain("Contained in · level 1");
      expect(page).toContain("Focus");
      expect(page).toContain('aria-current="page"');
      // Choosing a group keeps focus, depth, and managers.
      expect(page).toContain(`href="/app/accounts/groups/relations?focus=${tech}&amp;sel=${all}&amp;depth=3&amp;managers=1"`);
      expect(page).toContain(`href="/app/accounts/groups/${tech}"`);
      expect(page).toContain("No cycles");
    },
  );
});

test("the page passes the URL state to the one admin-checked service", async () => {
  const calls = await serve(
    async () => ({ ok: true, data: relations }),
    async (app) => {
      await html(app, `/app/accounts/groups/relations?focus=${tech}&sel=${all}&depth=9&view=list&expand=d1,x2`);
    },
  );
  expect(calls[0]).toMatchObject({ focus: tech, selected: all, depth: 2, view: "list", expand: ["d1"], actor: { userId: user.id } });
});

test("an old link to a missing group starts again at the default focus", async () => {
  await serve(
    async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Group not found", status: 404 } }),
    async (app) => {
      const response = await app.request(`/app/accounts/groups/relations?focus=${tech}&depth=3`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/app/accounts/groups/relations?depth=3");
    },
  );
});

test("no relations and a failed read each say what happened and lead back to the list", async () => {
  await serve(
    async () => ({ ok: true, data: { ...relations, focus: null, columns: [], selected: null } }),
    async (app) => {
      const page = await html(app, "/app/accounts/groups/relations");
      expect(page).toContain("No relations yet");
      expect(page).toContain('href="/app/accounts/groups"');
    },
  );
  await serve(
    async () => {
      throw new Error("database unavailable");
    },
    async (app) => {
      const page = await html(app, "/app/accounts/groups/relations?depth=3");
      expect(page).toContain("Could not load relations");
      expect(page).toContain('href="/app/accounts/groups/relations?depth=3"');
    },
  );
});
