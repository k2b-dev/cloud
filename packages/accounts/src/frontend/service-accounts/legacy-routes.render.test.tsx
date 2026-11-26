import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "accounts-legacy-key-routes-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: pages } = await import("../index");

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

// Accounts' real page router, mounted where Cloud mounts it, behind a signed-in administrator.
const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
app.use("*", async (c, next) => {
  c.set("actor", { kind: "user", user: admin });
  c.set("user", admin);
  c.set("runtime", { apps: [] });
  await next();
});
app.route("/app/accounts", pages);

test("the API key list's addresses lead permanently to the account list with the same search and kind", async () => {
  for (const [from, to] of [
    ["/app/accounts/api-keys", "/app/accounts/users"],
    ["/app/accounts/api-keys?kind=agent&q=export&status=revoked&automatic=1&page=3", "/app/accounts/users?kind=agent&q=export"],
    ["/app/accounts/api-keys?kind=user_delegated", "/app/accounts/users?kind=person"],
    ["/app/accounts/api-keys?kind=resource_bound&search=Postfach", "/app/accounts/users?kind=api-key&q=Postfach"],
    ["/app/accounts/api-keys/anything?kind=standalone", "/app/accounts/users?kind=agent"],
    ["/app/accounts/service-accounts", "/app/accounts/users"],
    ["/app/accounts/service-accounts?kind=agent&search=bot", "/app/accounts/users?kind=agent&q=bot"],
    ["/app/accounts/service-accounts/extra?kind=robot", "/app/accounts/users"],
  ] as const) {
    const response = await app.request(from);
    expect(response.status, from).toBe(301);
    expect(response.headers.get("Location"), from).toBe(to);
    // the old list's paths keep opting out of compression, as before
    if (from.includes("/api-keys")) expect(response.headers.get("Cache-Control") ?? "", from).toContain("no-transform");
  }
});
