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
import { contactDirectoryView } from "../../test/fixtures/mail-admin-mailboxes";
import { app as mailApp } from "../config";
import type { PlatformMailboxOperationSummary } from "../contracts";
import { contactDirectory, operations, storageObservability } from "../service";

// Cloud administration › Mail › Mailboxes renders on v2 from the server: its key figures, one row per mailbox with
// health and access, the contact directory as a setting, and a partial failure as a band while the rest stays.
const root = mkdtempSync(join(tmpdir(), "mail-admin-mailboxes-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: page } = await import("./admin");

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

const mailbox = (
  id: string,
  name: string,
  administrators: number,
  health: PlatformMailboxOperationSummary["health"],
): PlatformMailboxOperationSummary => ({
  mailboxId: id,
  mailboxName: name,
  health,
  syncEnabled: true,
  sync: { lastAt: "2026-11-26T09:28:00.000Z", lagSeconds: 4 },
  coverage: { hydration: { total: 10, covered: 10 }, search: { total: 10, covered: 10 }, threads: { total: 10, covered: 10 } },
  access: { total: 4, administrators },
  storage: { messageCount: 1200, logicalTotalBytes: 4_509_715_660, calculatedAt: "2026-11-26T09:18:00.000Z" },
  attentionCount: administrators ? 0 : 2,
});

const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const server = (storageOk = true) => {
  spies.push(
    stubRailSnapshot(),
    spyOn(operations, "getPlatformMailOperations").mockResolvedValue(
      ok({
        mailboxes: [mailbox("Mbx001", "Verwaltung", 2, "active"), mailbox("Mbx002", "Personal", 0, "degraded")],
        mailboxCount: 12,
        withoutAdministratorCount: 1,
        attentionCount: 2,
        generatedAt: "2026-11-26T09:30:00.000Z",
        nextCursor: "next-1",
      }),
    ),
    spyOn(storageObservability, "getMailStorageSummary").mockResolvedValue(
      storageOk
        ? ok({ mailboxes: [], physicalDatabaseBytes: 1_000, physicalBlobBytes: 2_000, calculatedAt: "2026-11-26T09:18:00.000Z" })
        : fail(err.internal("storage offline")),
    ),
    spyOn(contactDirectory, "loadContactDirectoryAdmin").mockResolvedValue(ok(contactDirectoryView())),
  );
  const hono = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  hono.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: admin, sessionKind: "app" });
    c.set("accessSubject", { type: "user", userId: admin.id });
    c.set("credentialKind", "session");
    c.set("credentialScopes", []);
    c.set("user", admin);
    // Mail is installed with its admin page (shown as to a person without app access rules, which the middleware
    // resolves in a running Cloud)
    c.set("runtime", { apps: [{ ...mailApp.meta, access: undefined, adminHref: "/admin/mail" }] });
    await next();
  });
  hono.get("/admin/mail", ...page);
  return hono;
};

test("the mailboxes render on v2 with their figures, health, access and the contact directory", async () => {
  const response = await server().request("/admin/mail?q=Ver", { headers: { "Accept-Language": "de" } });
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('data-k2-part="Band"');
  expect(html).toContain('data-k2-part="Table"');
  expect(html).toContain("Verwaltung");
  expect(html).toContain("Ohne Verwaltung");
  expect(html).toContain("Kontakte");
  expect(html).toContain('href="/admin/mail?q=Ver&amp;cursor=next-1"');
  expect(html).toMatch(/<a [^>]*aria-current="page" data-level="2" href="\/admin\/mail"/);
  expect(html).not.toContain("k2b-view-tabs");
  expect(html).not.toContain('aria-busy="true"');
  expect(operations.getPlatformMailOperations).toHaveBeenCalledWith(expect.anything(), { q: "Ver", cursor: undefined, limit: 50 });
});

test("a part that cannot load is a band, and the rest of the page stays", async () => {
  const html = await (await server(false).request("/admin/mail", { headers: { "Accept-Language": "de" } })).text();
  expect(html).toContain('data-k2-part="Notice"');
  expect(html).toContain("Verwaltung");
});

test("a person who is not an administrator gets a 403", async () => {
  const hono = server();
  spies.push(spyOn(operations, "getPlatformMailOperations").mockResolvedValue(fail(err.forbidden("no"))));
  expect((await hono.request("/admin/mail")).status).toBe(403);
});
