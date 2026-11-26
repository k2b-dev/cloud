import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "accounts-resource-record-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("../users/detail/page");

const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  provider: "local",
  profile: "user",
  roles: ["user", "admin"],
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const ACCOUNT_ID = "5a1b0000-0000-4000-8000-0000000000aa";
const KEY_ID = "4e3f0000-0000-4000-8000-300000000001";
const DEEP_KEY_ID = "4e3f0000-0000-4000-8000-300000000099";
type Account = NonNullable<Awaited<ReturnType<typeof services.serviceAccounts.get>>>;
type Overview = Awaited<ReturnType<typeof services.serviceAccountCredentials.listOverview>>["items"][number];

const account = (resourceType: string, status: "active" | "disabled" = "active"): Account => ({
  id: ACCOUNT_ID,
  name: resourceType === "cloud.app" ? "mail" : "Postfach Einkauf",
  kind: "resource_bound",
  status,
  delegatedUserId: null,
  appId: "mail",
  resourceType,
  resourceId: resourceType === "cloud.app" ? "mail" : "einkauf",
  createdBy: null,
  createdAt: "2026-10-01T00:00:00.000Z",
});

const key = (owner: Account, id: string, name: string): Overview => ({
  id,
  serviceAccountId: owner.id,
  name,
  kind: "api_token",
  status: "active",
  tokenPrefix: "ab12",
  scopes: ["read", "write", "admin"],
  expiresAt: null,
  lastUsedAt: "2026-11-24T06:00:00.000Z",
  createdBy: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
  serviceAccount: owner,
  owner: { type: "resource", appId: owner.appId ?? "", resourceType: owner.resourceType ?? "", resourceId: owner.resourceId ?? "" },
});

/** The record of one resource-bound account, its keys read through the stubbed service; returns the page's markup. */
const render = async (owner: Account, address = "") => {
  const lookups: string[] = [];
  const spies = [
    stubRailSnapshot(),
    spyOn(services.accountsAppService.user, "get").mockResolvedValue(null),
    spyOn(services.serviceAccounts, "get").mockResolvedValue(owner),
    spyOn(services.serviceAccountCredentials, "listOverview").mockResolvedValue({
      items: [key(owner, KEY_ID, "Schlüssel 1")],
      page: 1,
      perPage: 50,
      total: 51,
      hasNext: true,
    }),
    spyOn(services.serviceAccountCredentials, "getOverview").mockImplementation(async ({ id }) => {
      lookups.push(id);
      return id === DEEP_KEY_ID ? key(owner, DEEP_KEY_ID, "Schlüssel 51") : null;
    }),
    spyOn(services.accountsAppService.accountRequest, "countPending").mockResolvedValue(0),
    spyOn(services.coreSettings, "get").mockResolvedValue(false),
  ];
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: admin });
    c.set("user", admin);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/users/:id", ...handler);
  try {
    const response = await app.request(`/app/accounts/users/${ACCOUNT_ID}${address}`, { headers: { "Accept-Language": "de" } });
    expect(response.status).toBe(200);
    return { html: (await response.text()).replaceAll("&amp;", "&"), lookups };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

test("an app's own account shows its rotating keys read-only, with the way to where they are managed", async () => {
  const { html } = await render(account("cloud.app"));
  expect(html).toContain("Schlüssel 1");
  expect(html).toContain("Automatischer App-Schlüssel – wird unter Verwaltung › Apps verwaltet");
  expect(html).toContain('href="/admin/apps?app=mail&view=keys"');
  // no deeds on its keys: revoking one would switch the whole app off
  expect(html).not.toContain("Aktionen für Schlüssel 1");
});

test("any other API key account keeps revoke on its keys", async () => {
  const { html } = await render(account("mailbox"));
  expect(html).toContain("Aktionen für Schlüssel 1");
  expect(html).not.toContain("Automatischer App-Schlüssel");
});

test("a disabled API key account says its keys do not work", async () => {
  expect((await render(account("mailbox", "disabled"))).html).toContain("Das Konto ist deaktiviert");
  expect((await render(account("mailbox"))).html).not.toContain("Das Konto ist deaktiviert");
});

test("`?key=` on an API key account looks the key up by its id, wherever it stands", async () => {
  expect((await render(account("mailbox"), `?key=${DEEP_KEY_ID}`)).lookups).toEqual([DEEP_KEY_ID]);
  expect((await render(account("mailbox"))).lookups).toEqual([]);
});
