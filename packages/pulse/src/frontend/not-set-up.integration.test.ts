import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { session } from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { settingsFixture } from "../store/settings.test-fixture";

// Pages render JSX on the server; the test installs the same SSR plugin the app uses.
const root = mkdtempSync(join(tmpdir(), "pulse-not-set-up-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: pageRoutes } = await import(".");
// The Cloud runtime middleware needs a started app; pages only read the app list from it.
const pages = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/app/pulse", pageRoutes);

const suite = suiteFor("database", "nats", "valkey");
const user = (admin: boolean): User => ({
  id: "11111111-1111-4111-8111-111111111111",
  uid: "gate-fixture",
  provider: "local",
  profile: "user",
  roles: admin ? ["user", "admin"] : ["user"],
  givenname: "Gate",
  sn: "Fixture",
  displayName: "Gate fixture",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});

suite("Pulse pages without a data store", () => {
  let settings: ReturnType<typeof settingsFixture>;
  let lookup: ReturnType<typeof spyOn<typeof session, "authenticateRequest">>;
  beforeAll(() => {
    settings = settingsFixture();
    lookup = spyOn(session, "authenticateRequest").mockImplementation(async (_c, token) =>
      token === "admin-fixture" || token === "person-fixture"
        ? {
            user: user(token === "admin-fixture"),
            data: { userId: user(false).id, sid: "gate-fixture", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
          }
        : null,
    );
  });
  afterAll(() => {
    settings.restore();
    lookup.mockRestore();
  });

  test("signed-in people see the not-set-up state; only a Cloud admin gets the link to set it up", async () => {
    for (const path of ["/app/pulse", "/app/pulse/bAs234/sources"]) {
      const admin = await pages.request(path, { headers: { cookie: "session_token=admin-fixture" } });
      expect(admin.status).toBe(503);
      const adminHtml = await admin.text();
      expect(adminHtml).toContain("Pulse is not set up yet");
      expect(adminHtml).toContain('href="/admin/pulse"');
      const person = await pages.request(path, { headers: { cookie: "session_token=person-fixture" } });
      expect(person.status).toBe(503);
      const personHtml = await person.text();
      expect(personHtml).toContain("Please contact your Cloud admin");
      expect(personHtml).not.toContain('href="/admin/pulse"');
    }
  });

  test("signed-out visitors keep the sign-in redirect, and the public display names no admin path", async () => {
    const signedOut = await pages.request("/app/pulse");
    expect(signedOut.status).toBe(302);
    const display = await pages.request("/app/pulse/display/fixture-token");
    expect(display.status).toBe(503);
    const html = await display.text();
    expect(html).toContain("Pulse is not set up yet");
    expect(html).not.toContain("/admin/pulse");
  });
});
