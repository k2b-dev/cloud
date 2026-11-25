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

const root = mkdtempSync(join(tmpdir(), "accounts-api-keys-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

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

const at = "2026-11-20T08:00:00.000Z";
const agent = {
  id: "5a1b0000-0000-4000-8000-000000000001",
  name: "Wochenbericht",
  kind: "agent",
  status: "active",
  delegatedUserId: null,
  appId: null,
  resourceType: null,
  resourceId: null,
  createdAt: at,
};
const key = {
  id: "4e3f0000-0000-4000-8000-000000000001",
  serviceAccountId: agent.id,
  name: "Alter Export-Job",
  kind: "api_token",
  status: "active",
  tokenPrefix: "0b52",
  scopes: ["read"],
  expiresAt: null,
  lastUsedAt: at,
  createdBy: null,
  createdAt: at,
  revokedAt: null,
  revokedBy: null,
  serviceAccount: agent,
  owner: { type: "standalone", serviceAccountId: agent.id, name: agent.name, kind: "agent" },
};

const withPage = async (
  total: number,
  run: (app: Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>, list: ReturnType<typeof spyOn>) => Promise<void>,
) => {
  const list = spyOn(services.serviceAccountCredentials, "listOverview").mockImplementation(async (config) => ({
    items:
      (config?.pagination?.page ?? 1) === 1
        ? ([key] as unknown as Awaited<ReturnType<typeof services.serviceAccountCredentials.listOverview>>["items"])
        : [],
    page: config?.pagination?.page ?? 1,
    perPage: 100,
    total,
    hasNext: false,
    ...(config?.filter?.automatic === "hide" ? { hiddenAutomaticCount: 32 } : {}),
  }));
  const spies = [
    list,
    stubRailSnapshot(),
    spyOn(services.coreSettings, "get").mockResolvedValue(true),
    spyOn(services.accountsAppService.accountRequest, "countPending").mockResolvedValue(0),
  ];
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: admin });
    c.set("user", admin);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/api-keys", ...handler);
  try {
    await run(app, list);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

test("the address filters the keys on the server, and the first picture comes with its rows and no loader", async () => {
  await withPage(1, async (app, list) => {
    for (const locale of ["en", "de"]) {
      const response = await app.request("/app/accounts/api-keys?kind=agent&status=revoked&q=export", {
        headers: { "Accept-Language": locale },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(list.mock.calls.at(-1)?.[0]).toEqual({
        pagination: { page: 1, perPage: 100 },
        filter: { automatic: "hide", search: "export", serviceAccountKind: ["standalone", "agent"], credentialStatus: "revoked" },
      });
      expect(html).toContain('data-k2-part="Workspace"');
      expect(html).toContain("Alter Export-Job");
      expect(html).toContain("cld_0b52_…");
      expect(html).not.toContain('data-k2-part="Loading"');
      expect(html).toContain(locale === "de" ? "Typ ist Agent" : "Type is Agent");
      // the automatic app keys the address hides, with the way to show them, the filters kept
      expect(html).toContain(locale === "de" ? "32 automatische App-Schlüssel sind ausgeblendet." : "32 automatic app keys are hidden.");
      expect(html.replaceAll("&amp;", "&")).toContain('href="/app/accounts/api-keys?kind=agent&status=revoked&automatic=1&q=export"');
      // an agent's legacy key says what it is and how to replace it
      expect(html).toContain(locale === "de" ? "Ersetzen" : "Replace");
    }
    const shown = await app.request("/app/accounts/api-keys?automatic=1", { headers: { "Accept-Language": "en" } });
    expect(list.mock.calls.at(-1)?.[0]?.filter?.automatic).toBe("include");
    const html = await shown.text();
    expect(html).toContain("Automatic app keys are visible.");
    expect(html).toContain('href="/app/accounts/api-keys"');
  });
});

test("an address from before v2 and a page past the end lead to the v2 address", async () => {
  await withPage(150, async (app) => {
    const old = await app.request("/app/accounts/api-keys?search=ci&kind=standalone&status=revoked");
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe("/app/accounts/api-keys?kind=agent&status=revoked&q=ci");
    const past = await app.request("/app/accounts/api-keys?kind=agent&page=9");
    expect(past.status).toBe(302);
    expect(past.headers.get("location")).toBe("/app/accounts/api-keys?kind=agent&page=2");
  });
});
