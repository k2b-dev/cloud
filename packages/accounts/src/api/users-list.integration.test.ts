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
import usersRoutes from "./users";

const root = mkdtempSync(join(tmpdir(), "accounts-users-list-integration-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: usersPage } = await import("../frontend/users/page");

const suite = suiteFor("database", "nats", "valkey");
const tag = crypto.randomUUID().slice(0, 8);
const created: string[] = [];

const person = async (name: string, admin = false) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, admin, last_login_local)
    VALUES (${`users-list-${name.toLowerCase()}-${tag}`}, 'local', 'user', ${`${name} ${tag}`}, ${admin}, now())
    RETURNING id`;
  created.push(row!.id);
  return row!.id;
};

/** The list's own statements, as the meter keeps their first 120 characters: one count and one page, as before v2. */
const listStatements = (statements: string[]) =>
  statements.filter(
    (statement) =>
      statement.startsWith("SELECT COUNT(*)::int AS count FROM auth.users u CROSS JOIN LATERAL") ||
      statement.startsWith("SELECT u.*, a.effective_admin,"),
  );

const kind = (statement: string) =>
  statement.startsWith("SELECT u.*, (SELECT cache_version::text FROM auth.rail_state")
    ? "session person"
    : statement.includes("account_requests")
      ? "open requests"
      : statement.includes("auth.screen_preferences")
        ? "screen preferences"
        : statement;

suite("the user list's statement budget on its real paths (integration)", () => {
  afterAll(async () => {
    for (const id of created) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("GET /api/accounts/users and the SSR list read the filtered list in one count and one page", async () => {
    const adminId = await person("Ada", true);
    await person("Ben");
    await person("Cleo");
    const headers = { cookie: `session_token=${await createTestSession(adminId)}`, "x-forwarded-for": uniqueCallerAddress() };
    const address = `q=${tag}&role=admin,member&status=active&login=last-30d&passkey=no&sort=name.asc`;
    const api = () => usersRoutes.request(`/?${address}`, { headers });

    // the session and the settings the list reads are warm, as on every running server
    expect((await api()).status).toBe(200);
    const meter = await meterSql();
    try {
      let body: { users: { displayName: string }[] } | undefined;
      const statements = await meter.during(async () => {
        const response = await api();
        expect(response.status).toBe(200);
        body = (await response.json()) as typeof body;
      });
      expect(body?.users.map((user) => user.displayName.split(" ")[0])).toEqual(["Ada", "Ben", "Cleo"]);
      expect(listStatements(statements)).toHaveLength(2);
      // besides the list only the signed-in person is read, as for every request
      const others = statements.filter((statement) => !listStatements([statement]).length);
      expect(others.map(kind)).toEqual(["session person"]);
    } finally {
      await meter.close();
    }

    // the SSR list: the open requests badge, then the same count and page
    const rail = stubRailSnapshot();
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      await next();
    });
    // the route as Accounts mounts it: the administrator check of the route, then the page
    app.route("/", new Hono<AuthContext>().get("/app/accounts/users", auth.requireRole("admin", ssr.access), ...usersPage));
    const page = () => app.request(`/app/accounts/users?${address}`, { headers });
    try {
      expect((await page()).status).toBe(200);
      const ssrMeter = await meterSql();
      try {
        const statements = await ssrMeter.during(async () => {
          const response = await page();
          expect(response.status).toBe(200);
          expect(await response.text()).toContain(`Ada ${tag}`);
        });
        expect(listStatements(statements)).toHaveLength(2);
        // besides the list: the signed-in person and the shell's screen preferences, as for every page, and the open
        // requests badge
        const others = statements.filter((statement) => !listStatements([statement]).length);
        expect(others.map(kind).sort()).toEqual(["open requests", "screen preferences", "session person"]);
      } finally {
        await ssrMeter.close();
      }
    } finally {
      rail.mockRestore();
    }
  }, 60_000);
});
