import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, GroupRelations, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { accountsAppService, coreSettings } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
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
const relations = (focus: string | null): GroupRelations => ({
  focus,
  depth: 2,
  managers: false,
  groupCount: 2,
  nodes: [],
  columns: [],
  roots: null,
  selected: null,
  cycles: { count: 0, first: null },
  truncated: false,
  cyclesComplete: true,
  managerCyclesComplete: true,
});

type App = Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>;

const serve = async (result: () => ReturnType<typeof accountsAppService.group.relations>, run: (app: App) => Promise<void>) => {
  const relationsSpy = spyOn(accountsAppService.group, "relations").mockImplementation(result);
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
    return relationsSpy.mock.calls.map(([config]) => config);
  } finally {
    relationsSpy.mockRestore();
  }
};

test("an old relations address leads to the focus group's record with the relations view and every parameter", async () => {
  const calls = await serve(
    async () => ({ ok: true, data: relations(tech) }),
    async (app) => {
      const response = await app.request(`/app/accounts/groups/relations?focus=${tech}&sel=${all}&depth=3&view=list&managers=1`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/app/accounts/groups/${tech}?tab=relations&sel=${all}&depth=3&view=list&managers=1`);
    },
  );
  // A named focus needs no reading.
  expect(calls).toEqual([]);
});

test("without a focus the service's default group is the record; without any relation the list opens", async () => {
  const calls = await serve(
    async () => ({ ok: true, data: relations(all) }),
    async (app) => {
      const response = await app.request("/app/accounts/groups/relations?depth=3&managers=1");
      expect(response.headers.get("location")).toBe(`/app/accounts/groups/${all}?tab=relations&depth=3&managers=1`);
    },
  );
  expect(calls[0]).toMatchObject({ actor: { userId: user.id }, depth: 2, managers: false, view: "graph", expand: [] });
  expect(calls[0]).not.toHaveProperty("focus");
  await serve(
    async () => ({ ok: true, data: relations(null) }),
    async (app) => {
      const response = await app.request("/app/accounts/groups/relations");
      expect(response.headers.get("location")).toBe("/app/accounts/groups");
    },
  );
  await serve(
    async () => {
      throw new Error("database unavailable");
    },
    async (app) => {
      const response = await app.request("/app/accounts/groups/relations?depth=3");
      expect(response.headers.get("location")).toBe("/app/accounts/groups");
    },
  );
});

test("people without the admin role get no relations address and no Relations tab", async () => {
  const { default: accountsPages } = await import("../../index");
  const person = { ...user, roles: ["user"] } satisfies User;
  const relationsSpy = spyOn(accountsAppService.group, "relations");
  const spies = [
    stubRailSnapshot(),
    relationsSpy,
    spyOn(session, "getToken").mockReturnValue("test-session"),
    spyOn(session, "authenticateRequest").mockResolvedValue({
      user: person,
      data: { userId: person.id, sid: "test-session", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
    }),
    spyOn(coreSettings, "get").mockResolvedValue(false),
    spyOn(accountsAppService.accountRequest, "countPending").mockResolvedValue(0),
    spyOn(accountsAppService.group, "list").mockResolvedValue({ items: [], page: 1, perPage: 100, total: 0, hasNext: false }),
  ];
  const app: App = new Hono();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: person });
    c.set("user", person);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.route("/app/accounts", accountsPages);
  try {
    const denied = await app.request("/app/accounts/groups/relations", { headers: { "Accept-Language": "en" } });
    expect(denied.status).toBe(403);
    expect(relationsSpy).not.toHaveBeenCalled();
    const list = await app.request("/app/accounts/groups", { headers: { "Accept-Language": "en" } });
    expect(list.status).toBe(200);
    expect(await list.text()).not.toContain("/app/accounts/groups/relations");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
