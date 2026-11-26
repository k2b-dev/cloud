import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BaseGroup, type CloudRuntime, DEFAULT_ACCOUNT_CATEGORY_POLICY, type User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as avatars from "@k2b/cloud/services/accounts/avatar";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "accounts-user-record-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
const { default: legacyAgentPage } = await import("../../agents/detail.page");

// Invented sample: an administrator opens a local full account with groups, keys, devices and a Linux identity.
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
const person = {
  ...admin,
  id: "22222222-2222-4222-8222-222222222222",
  uid: "milan.horvat",
  roles: ["user"],
  givenname: "Milan",
  sn: "Horvat",
  displayName: "Milan Horvat",
  mail: "milan.horvat@solberg-kramer.example",
  lastLoginLocal: "2026-11-20T08:00:00.000Z",
} satisfies User;
const group = (index: number, name: string, extra: Partial<BaseGroup> = {}): BaseGroup => ({
  id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
  name,
  provider: "local",
  description: `${name} im Laden`,
  gidnumber: null,
  personalOwner: null,
  ...extra,
});
const personal = group(9, "milan.horvat", { personalOwner: { id: person.id, uid: person.uid, displayName: person.displayName } });
const sales = group(1, "Verkauf");
const office = group(2, "Büro", { description: null });
const inherited = group(3, "Alle Mitarbeitenden");
const managed = group(4, "Aushilfen");
const page = <T,>(items: T[]) => ({ items, page: 1, perPage: 100, total: items.length, hasNext: false });
const key = (index: number, name: string, scopes: string[]) => ({
  id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
  serviceAccountId: "55555555-5555-4555-8555-555555555555",
  name,
  kind: "api_token" as const,
  status: "active" as const,
  tokenPrefix: `k${index}ab`,
  scopes,
  expiresAt: index === 2 ? "2027-03-01T00:00:00.000Z" : null,
  lastUsedAt: index === 1 ? "2026-11-24T10:00:00.000Z" : null,
  createdBy: person.id,
  createdAt: "2026-10-01T09:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
  serviceAccount: {
    id: "55555555-5555-4555-8555-555555555555",
    name: person.uid,
    kind: "user_delegated" as const,
    status: "active" as const,
    delegatedUserId: person.id,
    appId: null,
    resourceType: null,
    resourceId: null,
    createdBy: person.id,
    createdAt: "2026-10-01T09:00:00.000Z",
  },
  owner: {
    type: "user" as const,
    userId: person.id,
    uid: person.uid,
    displayName: person.displayName,
    mail: person.mail,
    avatarHash: null,
  },
});
const config = { enabled: true, rangeStart: 200000, rangeEnd: 200100, homeTemplate: "/home/{username}", loginShell: "/bin/bash" };

type Options = { devices?: "failed"; account?: { kind: "agent" | "standalone" | "code" | "resource_bound" | "user_delegated" } | null };
const AGENT = "88888888-8888-4888-8888-888888888888";
const serviceAccount = (kind: NonNullable<Options["account"]>["kind"]) => ({
  id: AGENT,
  name: "Wochenbericht",
  kind,
  status: "active" as const,
  delegatedUserId: null,
  appId: null,
  resourceType: null,
  resourceId: null,
  createdBy: admin.id,
  createdAt: "2026-10-01T09:00:00.000Z",
});

const server = (options: Options = {}) => {
  const spies = [
    stubRailSnapshot(),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    spyOn(services.coreSettings, "get").mockResolvedValue(false),
    spyOn(services.appApproval, "config").mockRejectedValue(new Error("Not configured")),
    spyOn(services.accountsAppService.user, "get").mockImplementation(async (input) => {
      const id = "id" in input ? input.id : null;
      return id === admin.id ? admin : options.account !== undefined ? null : person;
    }),
    spyOn(services.serviceAccounts, "get").mockResolvedValue(options.account ? serviceAccount(options.account.kind) : null),
    spyOn(avatars, "getServiceAccountAvatarState").mockResolvedValue(null),
    spyOn(services.linuxIdentities, "get").mockResolvedValue({
      config,
      user: {
        id: person.id,
        uid: person.uid,
        displayName: person.displayName,
        provider: "local",
        profile: "user",
        identity: {
          userId: person.id,
          uidNumber: 200010,
          primaryGidNumber: 200010,
          homeDirectory: "/home/milan.horvat",
          loginShell: "/bin/bash",
          managedBy: "local",
        },
        state: "ready",
      },
    }),
    spyOn(services.accountsAppService.accountRequest, "countPending").mockResolvedValue(2),
    spyOn(services.accountsAppService.group, "list").mockImplementation(async (input) =>
      page(
        input.scope?.ids
          ? [personal, sales, office]
          : input.scope?.mode === "member"
            ? [sales, office, inherited]
            : input.scope?.mode === "managed"
              ? [managed]
              : [],
      ),
    ),
    spyOn(services.accountsAppService.user.groupId, "list").mockResolvedValue([personal.id, sales.id, office.id]),
    spyOn(services.serviceAccountCredentials, "listOverview").mockResolvedValue(
      page([key(1, "Backup-Skript", ["read", "write"]), key(2, "Preis-Assistent", ["ai:inference"])]),
    ),
    options.devices === "failed"
      ? spyOn(services.appApproval, "listUserDevices").mockRejectedValue(new Error("down"))
      : spyOn(services.appApproval, "listUserDevices").mockResolvedValue([
          {
            id: "66666666-6666-4666-8666-000000000001",
            name: "Pixel 8",
            createdAt: "2026-09-01T10:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null,
            assisted: true,
          },
        ]),
    spyOn(services.pwaDevices, "listUserDevices").mockResolvedValue([
      {
        id: "77777777-7777-4777-8777-000000000001",
        name: "iPhone im Laden",
        platform: "ios",
        createdAt: "2026-09-12T10:00:00.000Z",
        lastUsedAt: "2026-11-23T08:00:00.000Z",
        current: false,
      },
    ]),
  ];
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: admin });
    c.set("user", admin);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/users/:id", ...handler);
  app.get("/app/accounts/agents/:id", ...legacyAgentPage);
  return { app, restore: () => spies.forEach((spy) => spy.mockRestore()) };
};

const render = async (address: string, options: Options = {}) => {
  const { app, restore } = server(options);
  try {
    const response = await app.request(address, { headers: { "Accept-Language": "de" } });
    return { status: response.status, html: await response.text(), location: response.headers.get("location") };
  } finally {
    restore();
  }
};

/** Elements of the page as the server sends it, and loading signs on the first picture. */
const measure = (html: string) => ({
  elements: html.match(/<[a-zA-Z][^\s/>]*/g)?.length ?? 0,
  loaders: (html.match(/data-k2-part="Loading"|animate-spin|aria-busy="true"/g) ?? []).length,
});
const record = `/app/accounts/users/${person.id}`;

test("a person's record renders every area on the server, with no loading state on the first picture", async () => {
  const sizes: Record<string, ReturnType<typeof measure>> = {};
  for (const [tab, expected, absent] of [
    [
      "",
      ["Milan Horvat", "Überblick", "Direkte Gruppen", "Verkauf", "Linux-Identität", "/home/milan.horvat", "Datenbank-ID"],
      ["Alle Mitarbeitenden"],
    ],
    ["?tab=groups", ["Mitglied in", "Verkauf", "Aus Verkauf entfernen", "Aushilfen"], ["Alle Mitarbeitenden", "Linux-Identität"]],
    ["?tab=groups&recursive=true", ["Alle Mitarbeitenden", "Nur direkte"], []],
    ["?tab=keys", ["Backup-Skript", "Preis-Assistent", "cld_k1ab_", "Nur KI-Modelle"], []],
    ["?tab=devices", ["Pixel 8", "iPhone im Laden", "Cloud-App koppeln"], []],
  ] as const) {
    const { status, html } = await render(`${record}${tab}`);
    expect(status, html).toBe(200);
    for (const text of expected) expect(html).toContain(text);
    for (const text of absent) expect(html).not.toContain(text);
    // the personal Linux group never shows as a membership
    expect(html).not.toContain(`/app/accounts/groups/${personal.id}`);
    sizes[tab || "overview"] = measure(html);
    expect(sizes[tab || "overview"]!.loaders).toBe(0);
  }
  // evidence for the migration report: elements per area on the server (v1 rendered every area on one page: 765)
  console.log("MEASURE", JSON.stringify(sizes));
});

test("devices that could not be loaded say so with a way to try again, the rest of the record stays", async () => {
  const { status, html } = await render(`${record}?tab=devices`, { devices: "failed" });
  expect(status).toBe(200);
  expect(html).toContain("Erneut versuchen");
  expect(html).toContain("iPhone im Laden");
});

test("the record keeps the list it was opened from for the way back", async () => {
  const list = "status=active&sort=login.desc&page=2";
  const { html } = await render(`${record}?list=${encodeURIComponent(list)}&tab=groups`);
  expect(html).toContain('href="/app/accounts/users?status=active&amp;sort=login.desc&amp;page=2"');
  // the tabs carry it too
  expect(html).toContain(`/app/accounts/users/${person.id}?list=${encodeURIComponent(list)}&amp;tab=keys`);
});

test("an agent or standalone account opens as the agent kind of the same record", async () => {
  for (const kind of ["agent", "standalone"] as const) {
    const { status, html } = await render(`/app/accounts/users/${AGENT}?sort=name`, { account: { kind } });
    expect(status, html).toBe(200);
    expect(html).toContain("Wochenbericht");
    expect(html).toContain("API Keys");
    expect(measure(html).loaders).toBe(0);
  }
});

test("kinds the agent page refused and unknown ids stay a 404", async () => {
  for (const account of [{ kind: "code" as const }, { kind: "resource_bound" as const }, { kind: "user_delegated" as const }, null]) {
    const { status } = await render(`/app/accounts/users/${AGENT}`, { account });
    expect(status).toBe(404);
  }
  expect((await render("/app/accounts/users/not-a-uuid")).status).toBe(404);
});

test("an agent's page from before leads to its record with order and open key", async () => {
  const { status, location } = await render(`/app/accounts/agents/${AGENT}?sort=used&key=new&page=3`);
  expect(status).toBe(302);
  expect(location).toBe(`/app/accounts/users/${AGENT}?sort=used&key=new`);
  expect((await render("/app/accounts/agents/nope")).status).toBe(404);
});
