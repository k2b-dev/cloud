import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { securityIdentities, securityPolicies, securityReports } from "../../test/fixtures/mail-admin-security";
import { app as mailApp } from "../config";
import { security } from "../service";

// Cloud administration › Mail › Security renders on v2 from the server: the figures, the tab of the address with its
// own search, the other tabs keeping theirs, and a list that cannot load as a failure in its place.
const root = mkdtempSync(join(tmpdir(), "mail-admin-security-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: page } = await import("./admin-security");

const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  roles: ["user", "admin"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: "admin@example.org",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const server = (policiesOk = true) => {
  spies.push(
    stubRailSnapshot(),
    spyOn(security, "countReportsPerDay").mockResolvedValue(
      ok(Array.from({ length: 30 }, (_, index) => ({ day: `2026-11-${index}`, count: index % 5 === 0 ? 2 : 0 }))),
    ),
    spyOn(security, "listReports").mockResolvedValue(ok(securityReports)),
    spyOn(security, "listPolicies").mockResolvedValue(policiesOk ? ok(securityPolicies) : fail(err.internal("offline"))),
    spyOn(security, "listProtectedIdentities").mockResolvedValue(ok(securityIdentities)),
    spyOn(security, "getSettings").mockResolvedValue(
      ok({ trustedAuthservIds: ["mx.werkstatt.example.org"], updatedAt: "2026-11-26T08:10:00.000Z" }),
    ),
  );
  const hono = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  hono.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: admin });
    c.set("user", admin);
    // Mail is installed with its admin page (shown as to a person without app access rules)
    c.set("runtime", { apps: [{ ...mailApp.meta, access: undefined, adminHref: "/admin/mail" }] });
    await next();
  });
  hono.get("/admin/mail/security", ...page);
  return hono;
};

const html = async (hono: Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>, path: string) => {
  const response = await hono.request(path, { headers: { "Accept-Language": "de" } });
  expect(response.status).toBe(200);
  return response.text();
};

test("the reports tab renders with the figures, filtered by its own search, and nothing loading", async () => {
  const page = await html(server(), "/admin/mail/security?reports=paypal&rules=kern");
  expect(page).toContain('data-k2-part="Cells"');
  // the open reports carry their real trend: reports received per day
  expect(page).toContain('data-k2-part="Spark"');
  expect(page).toContain("rechnung@paypal-konto-sicherheit.example.org");
  expect(page).not.toContain("lieferung@dhl-zustellung.example.org");
  expect(page).toContain('href="/admin/mail/security?view=rules&amp;reports=paypal&amp;rules=kern"');
  expect(page).toMatch(/<a [^>]*aria-current="page" data-level="2" href="\/admin\/mail\/security"/);
  expect(page).not.toContain('aria-busy="true"');
});

test("the rules tab shows its rules, and a list that cannot load fails in its place", async () => {
  const rules = await html(server(), "/admin/mail/security?view=rules");
  expect(rules).toContain("login-microsoft-verify.example.org");
  expect(rules).not.toContain("rechnung@paypal-konto-sicherheit.example.org");
  for (const spy of spies.splice(0)) spy.mockRestore();
  const failed = await html(server(false), "/admin/mail/security?view=rules");
  expect(failed).toContain('data-k2-part="Failed"');
});
