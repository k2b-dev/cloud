import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountDirectoryEntry, AccountDirectoryPerson, CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { accountsAppService } from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "accounts-users-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
const { default: pages } = await import("../index");

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

const SALES = { id: "33333333-3333-4333-8333-000000000001", name: "Verkauf" };
const BOARD = { id: "33333333-3333-4333-8333-000000000002", name: "Geschäftsführung" };
const entry = (index: number, name: string, groups: { id: string; name: string }[]): AccountDirectoryPerson => ({
  kind: "person",
  id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
  uid: name.toLowerCase().replace(" ", "."),
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: name.split(" ")[0]!,
  sn: name.split(" ")[1]!,
  displayName: name,
  mail: `${name.toLowerCase().replace(" ", ".")}@solberg-kramer.example`,
  avatarHash: null,
  role: "admin",
  status: "active",
  lastLogin: "2026-11-20T08:00:00.000Z",
  accountExpires: null,
  passkey: false,
  groups,
  groupCount: groups.length,
  duplicateMail: false,
});
const agent: AccountDirectoryEntry = {
  kind: "agent",
  id: "0b2f5c7e-0000-4000-8000-000000000001",
  name: "Wochenbericht",
  resource: null,
  status: "active",
  avatarHash: null,
  lastUsed: null,
  createdAt: "2026-09-22T09:14:00.000Z",
};
const apiKey: AccountDirectoryEntry = {
  ...agent,
  kind: "api-key",
  id: "0b2f5c7e-0000-4000-8000-000000000002",
  name: "Buchhaltung 2026",
  resource: { appId: "finanzen", type: "ledger", id: "2026" },
};
const people: AccountDirectoryEntry[] = [entry(1, "Milan Horvat", [BOARD, SALES]), entry(2, "Ada Renz", [SALES])];

/** Serves the users list with `total` matches; the directory answers `people` for every page that exists. */
type Spies = { directory: ReturnType<typeof spyOn>; groups: ReturnType<typeof spyOn> };
const withUsers = async (
  total: number,
  run: (app: Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>, spies: Spies) => Promise<void>,
) => {
  const directory = spyOn(accountsAppService.account, "directory").mockImplementation(async ({ pagination, kinds }) => {
    const page = pagination?.page ?? 1;
    const sample = [...people, agent, apiKey].filter((account) => !kinds || kinds.includes(account.kind));
    const items = (page - 1) * 100 < total ? sample : [];
    return { ok: true as const, data: { items, page, perPage: 100, total, hasNext: page * 100 < total } };
  });
  const groups = spyOn(accountsAppService.group, "list").mockResolvedValue({
    items: [{ ...SALES, provider: "local", description: null, gidnumber: null, personalOwner: null }],
    page: 1,
    perPage: 1,
    total: 1,
    hasNext: false,
  });
  const spies = [stubRailSnapshot(), directory, groups, spyOn(accountsAppService.accountRequest, "countPending").mockResolvedValue(2)];
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: admin });
    c.set("user", admin);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/users", ...handler);
  app.route("/app/accounts", pages);
  try {
    await run(app, { directory, groups });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

test("the address filters, sorts and groups the list on the server, and a row leads to the user with the list's address", async () => {
  let calls: unknown[] = [];
  let groupCalls: unknown[] = [];
  let html = "";
  const list = `role=admin&member-of=${SALES.id}&q=ren&sort=login.desc&group=member-of`;
  await withUsers(2, async (app, spies) => {
    const response = await app.request(`/app/accounts/users?${list}`, { headers: { "Accept-Language": "de" } });
    expect(response.status).toBe(200);
    html = await response.text();
    calls = [...spies.directory.mock.calls];
    groupCalls = [...spies.groups.mock.calls];
  });
  expect(calls).toEqual([
    [
      {
        actor: expect.objectContaining({ userId: admin.id }),
        kinds: undefined,
        search: "ren",
        roles: ["admin"],
        groupIds: [SALES.id],
        statuses: undefined,
        lastLogin: undefined,
        passkey: undefined,
        provider: undefined,
        duplicateMail: undefined,
        sort: { field: "lastLogin", direction: "desc" },
        pagination: { page: 1, perPage: 100 },
      },
    ],
  ]);
  // the chosen group is named on the first picture, not shown as its ID
  expect(groupCalls).toEqual([[{ pagination: { page: 1, perPage: 1 }, scope: { mode: "all", ids: [SALES.id] } }]]);
  expect(html).toContain("Gruppe ist Verkauf");
  // grouped by group: Milan stands under both of his groups, and the status row says so
  expect(html.match(/Milan Horvat/g)?.length).toBeGreaterThanOrEqual(2);
  expect(html).toContain("1 davon in mehreren Gruppen");
  expect(html).toContain(`/app/accounts/users/${people[1]!.id}?list=${encodeURIComponent(list)}`);
});

test("addresses from before v2 and a view named alone lead to the full v2 address", async () => {
  await withUsers(2, async (app) => {
    const old = await app.request("/app/accounts/users?search=ada&provider=ipa&profile=guest&page=2");
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe("/app/accounts/users?provider=ipa&page=2&q=ada&role=guest");
    const view = await app.request("/app/accounts/users?view=inactive-admins");
    expect(view.status).toBe(302);
    expect(view.headers.get("location")).toBe("/app/accounts/users?view=inactive-admins&role=admin&login=older-90d");
  });
});

test("a page past the end opens the last page with the same filters", async () => {
  await withUsers(150, async (app) => {
    const response = await app.request("/app/accounts/users?status=active&page=5");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/accounts/users?status=active&page=2");
  });
});

test("a list that cannot be read shows its failure in place, the page stays", async () => {
  const spies = [
    stubRailSnapshot(),
    spyOn(accountsAppService.account, "directory").mockRejectedValue(new Error("database down")),
    spyOn(accountsAppService.accountRequest, "countPending").mockResolvedValue(0),
  ];
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: admin });
    c.set("user", admin);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/users", ...handler);
  try {
    const response = await app.request("/app/accounts/users", { headers: { "Accept-Language": "de" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Die Liste konnte nicht geladen werden.");
    expect(html).toContain("Erneut versuchen");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test("people, agents and API key accounts share the list, each row opening where that account lives", async () => {
  await withUsers(4, async (app) => {
    const response = await app.request("/app/accounts/users", { headers: { "Accept-Language": "de" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("4 Konten");
    expect(html).toContain("Wochenbericht");
    expect(html).toContain(`/app/accounts/agents/${agent.id}`);
    expect(html).toContain(`/app/accounts/users/${people[0]!.id}`);
    // an API key account never had a page: it opens its keys on the API key page, its app beside its name
    expect(html).toMatch(/\/app\/accounts\/api-keys\?search=Buchhaltung\+2026&(amp;)?kind=resource_bound&(amp;)?automatic=1/);
    expect(html).toContain("finanzen · ledger");
    // the first picture comes with its data: no loading state
    expect(html).not.toContain('data-k2-part="Loading"');
    expect(html).not.toContain('aria-busy="true"');
  });
});

test("the former agent list and duplicate address page open their views of the account list, with every parameter", async () => {
  await withUsers(4, async (app, spies) => {
    const cases = [
      ["/app/accounts/agents", "/app/accounts/users?view=agents&kind=agent"],
      ["/app/accounts/agents?page=2", "/app/accounts/users?view=agents&kind=agent&page=2"],
      ["/app/accounts/duplicate-emails", "/app/accounts/users?view=duplicates&duplicate=yes&sort=mail.asc&group=mail"],
      ["/app/accounts/duplicate-emails?page=3", "/app/accounts/users?view=duplicates&duplicate=yes&sort=mail.asc&group=mail&page=3"],
    ] as const;
    for (const [from, to] of cases) {
      const moved = await app.request(from);
      expect(moved.status).toBe(301);
      expect(moved.headers.get("location")).toBe(to);
    }
    // each target renders its view of the list on the server
    const agents = await app.request("/app/accounts/users?view=agents&kind=agent", { headers: { "Accept-Language": "de" } });
    expect(agents.status).toBe(200);
    const agentsHtml = await agents.text();
    expect(agentsHtml).toContain("Art ist Agent");
    expect(agentsHtml).toContain("Wochenbericht");
    expect(spies.directory).toHaveBeenLastCalledWith(expect.objectContaining({ kinds: ["agent"] }));
    const duplicates = await app.request("/app/accounts/users?view=duplicates&duplicate=yes&sort=mail.asc&group=mail", {
      headers: { "Accept-Language": "de" },
    });
    expect(duplicates.status).toBe(200);
    expect(await duplicates.text()).toContain("E-Mail-Adresse ist doppelt");
    expect(spies.directory).toHaveBeenLastCalledWith(
      expect.objectContaining({ duplicateMail: true, sort: { field: "mail", direction: "asc" } }),
    );
  });
});
