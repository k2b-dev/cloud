import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { ssr } from "../config";
import { migrate } from "../migrate";

const root = mkdtempSync(join(tmpdir(), "dashboard-page-integration-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: dashboardPage } = await import("./page");

const created: string[] = [];

suiteFor(
  "database",
  "nats",
  "valkey",
)("the dashboard page's statement budget (integration)", () => {
  afterAll(async () => {
    for (const id of created) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("the server renders the board with the person's settings in one statement besides the shell's; widgets load in the browser", async () => {
    await migrate();
    const [person] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, last_login_local)
      VALUES (${`dashboard-page-${crypto.randomUUID().slice(0, 8)}`}, 'local', 'user', 'Mara', now())
      RETURNING id`;
    created.push(person!.id);
    const headers = { cookie: `session_token=${await createTestSession(person!.id)}`, "x-forwarded-for": uniqueCallerAddress() };
    const rail = stubRailSnapshot();
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      await next();
    });
    // the route as the dashboard mounts it
    app.route(
      "/",
      new Hono<AuthContext>().get(
        "/app/dashboard",
        auth.requireRole("authenticated", ssr.access),
        auth.requireUser(ssr.access),
        ...dashboardPage,
      ),
    );
    const page = () => app.request("/app/dashboard", { headers });
    try {
      // the first request warms the caches every running server has warm
      expect((await page()).status).toBe(200);
      const meter = await meterSql();
      try {
        let html = "";
        const statements = await meter.during(async () => {
          const response = await page();
          expect(response.status).toBe(200);
          html = await response.text();
        });
        expect(html).toContain("Mara");
        // the signed-in person and the shell's screen preferences, as for every page, and the person's board; the
        // widgets themselves are not read here but streamed to the browser in one call per visit
        const kind = (statement: string) =>
          statement.startsWith("SELECT u.*, (SELECT cache_version::text FROM auth.rail_state")
            ? "session person"
            : statement.includes("auth.screen_preferences")
              ? "screen preferences"
              : statement.includes("dashboard.user_settings")
                ? "dashboard settings"
                : statement;
        expect(statements.map(kind).sort()).toEqual(["dashboard settings", "screen preferences", "session person"]);
      } finally {
        await meter.close();
      }
    } finally {
      rail.mockRestore();
    }
  }, 60_000);
});
