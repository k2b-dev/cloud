import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudRuntime, DEFAULT_ACCOUNT_CATEGORY_POLICY, type User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "accounts-new-user-render-"));
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
const REQUEST_ID = "8a000000-0000-4000-8000-000000000001";
type Request = Awaited<ReturnType<typeof services.accountsAppService.accountRequest.get>>;

const withPage = async (status: string, run: (app: Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>) => Promise<void>) => {
  const spies = [
    stubRailSnapshot(),
    spyOn(services.coreSettings, "get").mockResolvedValue(true),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    spyOn(services.accountsAppService.accountRequest, "countPending").mockResolvedValue(1),
    spyOn(services.accountsAppService.accountRequest, "get").mockResolvedValue({
      ok: true,
      data: {
        id: REQUEST_ID,
        email: "ida.berg@kramer-lager.example",
        firstName: "Ida",
        lastName: "Berg",
        displayName: null,
        phone: "+49 761 123456",
        comment: "Ich fange am 1. Dezember an.",
        status,
      },
    } as unknown as Request),
  ];
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: admin });
    c.set("user", admin);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/users/new", ...handler);
  try {
    await run(app);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

test("the form stands on the server's page with every account type on offer and no loader", async () => {
  await withPage("pending", async (app) => {
    for (const locale of ["en", "de"]) {
      const response = await app.request("/app/accounts/users/new", { headers: { "Accept-Language": locale } });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-k2-part="Workspace"');
      expect(html).toContain('data-k2-part="Choice"');
      for (const type of ["FreeIPA", "Login", locale === "de" ? "Gast" : "Guest"]) expect(html).toContain(`>${type}<`);
      expect(html).toContain(locale === "de" ? "Konto erstellen" : "Create account");
      expect(html).not.toContain("Ida");
      expect(html).not.toContain('data-k2-part="Loading"');
    }
  });
});

test("an open request fills the form for FreeIPA and can be denied; a closed one leaves an empty form", async () => {
  await withPage("pending", async (app) => {
    const html = await (
      await app.request(`/app/accounts/users/new?request=${REQUEST_ID}`, { headers: { "Accept-Language": "de" } })
    ).text();
    expect(html).toContain("FreeIPA-Kontoanfrage");
    expect(html).toContain("ida.berg@kramer-lager.example");
    expect(html).toContain("Ich fange am 1. Dezember an.");
    expect(html).toContain(">Ablehnen<");
    expect(html).toContain('value="Ida"');
    expect(html).not.toContain(">Login<");
  });
  await withPage("denied", async (app) => {
    const html = await (
      await app.request(`/app/accounts/users/new?request=${REQUEST_ID}`, { headers: { "Accept-Language": "de" } })
    ).text();
    expect(html).not.toContain("FreeIPA-Kontoanfrage");
    expect(html).not.toContain('value="Ida"');
  });
});
