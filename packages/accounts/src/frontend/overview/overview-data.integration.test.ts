import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../../scripts/fixtures/caller-address";
import { meterSql } from "../../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { ssr } from "../../config";

const root = mkdtempSync(join(tmpdir(), "accounts-overview-data-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: overviewPage } = await import("../page");

const suite = suiteFor("database", "nats", "valkey");
const tag = crypto.randomUUID().slice(0, 8);
const created: string[] = [];

const person = async (name: string, admin: boolean) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, admin, last_login_local)
    VALUES (${`overview-${name.toLowerCase()}-${tag}`}, 'local', 'user', ${`${name} ${tag}`}, ${admin}, now())
    RETURNING id`;
  created.push(row!.id);
  return row!.id;
};

/** What a statement reads, by the start of its text as the meter keeps it (first 120 characters). */
const kind = (statement: string) =>
  statement.startsWith("SELECT u.*, (SELECT cache_version::text FROM auth.rail_state")
    ? "session person"
    : statement.includes("auth.screen_preferences")
      ? "screen preferences"
      : statement.startsWith("WITH latest_sync AS")
        ? "dashboard"
        : statement.includes("FROM audit.events")
          ? "audit latest"
          : statement.startsWith("SELECT g.id, g.provider, g.name")
            ? "groups"
            : statement;

suite("the Accounts overview's statements per SSR load (integration)", () => {
  afterAll(async () => {
    for (const id of created) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("an administrator's overview reads a pinned, small number of statements", async () => {
    const adminId = await person("Ada", true);
    const rail = stubRailSnapshot();
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      await next();
    });
    // the route as Accounts mounts it: every signed-in person, then the page (which sends everyone else to the groups)
    app.route("/", new Hono<AuthContext>().get("/app/accounts", auth.requireRole("user", ssr.access), ...overviewPage));
    const load = async (userId: string) => {
      const headers = { cookie: `session_token=${await createTestSession(userId)}`, "x-forwarded-for": uniqueCallerAddress() };
      const page = () => app.request("/app/accounts", { headers });
      // the session and the settings the page reads are warm, as on every running server
      expect((await page()).status).toBe(200);
      const meter = await meterSql();
      try {
        return await meter.during(async () => {
          const response = await page();
          expect(response.status).toBe(200);
          expect(await response.text()).toContain(tag);
        });
      } finally {
        await meter.close();
      }
    };
    try {
      const admin = await load(adminId);
      console.info(`overview statements: admin ${admin.length}`);
      // administrators (6): the dashboard figures, the newest audit events, and their own managed and member groups (one
      // statement each, the count rides along); the number of all groups comes with the dashboard
      expect(admin.map(kind).sort()).toEqual(["audit latest", "dashboard", "groups", "groups", "screen preferences", "session person"]);
    } finally {
      rail.mockRestore();
    }
  }, 60_000);
});
