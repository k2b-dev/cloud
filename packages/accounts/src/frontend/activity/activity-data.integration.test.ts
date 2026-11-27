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

// What one SSR load of each kind of the activity page costs the database, and which index its main query reads. The
// page reads the open requests for the sidebar badge and then only its kind's list: never another kind's.
const root = mkdtempSync(join(tmpdir(), "accounts-activity-data-integration-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: activityPage } = await import("./page");

const suite = suiteFor("database", "nats", "valkey");
const tag = crypto.randomUUID().slice(0, 8);
const created: string[] = [];

/** Each statement by what it reads, as the meter keeps its first 120 characters. */
const kind = (statement: string) =>
  statement.startsWith("SELECT u.*, (SELECT cache_version::text FROM auth.rail_state")
    ? "session person"
    : statement.includes("account_requests")
      ? "open requests"
      : statement.includes("auth.screen_preferences")
        ? "screen preferences"
        : statement.startsWith("SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE (metadata->>'provenance' = 'system'")
          ? "audit count"
          : statement.includes("audit.events")
            ? "audit page"
          : statement.includes("notifications.batches")
            ? "batches page"
            : statement.includes("account_lifecycle_reminders") || statement.startsWith("SELECT r.id, r.user_id, r.uid AS reminder_uid")
              ? statement.includes("COUNT(*)") || statement.includes("count(*)")
                ? "reminders count"
                : "reminders page"
              : statement.includes("deleted_accounts") || statement.startsWith("SELECT id, deleted_user_id, uid, mail")
                ? statement.includes("COUNT(*)") || statement.includes("count(*)")
                  ? "deleted count"
                  : "deleted page"
                : statement;

/** The plan of a query as one text, for the index it reads. */
const plan = async (query: string) =>
  (await sql.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${query}`)).map((row) => row["QUERY PLAN"]).join("\n");

suite("the activity page's data on its real path (integration)", () => {
  afterAll(async () => {
    await sql`DELETE FROM audit.events WHERE target_label LIKE ${`activity-data-${tag}%`}`;
    for (const id of created) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("each kind loads in a fixed number of statements; the audit page's plan is logged for the Daten line", async () => {
    const [admin] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin, last_login_local)
      VALUES (${`activity-data-${tag}`}, 'local', 'user', ${`Ada ${tag}`}, true, now())
      RETURNING id`;
    created.push(admin!.id);
    // a realistic log: 20,000 events over 60 days, one in ten an automatic entry of a rotating app key
    await sql`
      INSERT INTO audit.events (created_at, action, outcome, actor_user_id, actor_uid, target_type, target_id, target_label, metadata)
      SELECT now() - (n * interval '259 seconds'), 'accounts.user.update', 'allowed', ${admin!.id}::uuid, ${`activity-data-${tag}`},
             'user', ${admin!.id}, ${`activity-data-${tag}`} || '-' || n,
             CASE WHEN n % 10 = 0 THEN '{"provenance":"system","service":"app-workload"}'::jsonb ELSE '{}'::jsonb END
      FROM generate_series(1, 20000) AS n`;
    await sql`ANALYZE audit.events`.simple();

    const headers = { cookie: `session_token=${await createTestSession(admin!.id)}`, "x-forwarded-for": uniqueCallerAddress() };
    const rail = stubRailSnapshot();
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      await next();
    });
    // the route as Accounts mounts it: the administrator check of the route, then the page
    app.route("/", new Hono<AuthContext>().get("/app/accounts/activity", auth.requireRole("admin", ssr.access), ...activityPage));
    const page = (address: string) => app.request(`/app/accounts/activity${address}`, { headers });
    const budget: Record<string, string[]> = {
      "": ["audit count", "audit page"],
      "?kind=notifications": ["batches page"],
      "?kind=reminders": ["reminders count", "reminders page"],
      "?kind=deleted": ["deleted count", "deleted page"],
    };
    try {
      for (const [address, own] of Object.entries(budget)) {
        // the session and the settings are warm, as on every running server
        expect((await page(address)).status).toBe(200);
        const meter = await meterSql();
        try {
          const statements = await meter.during(async () => {
            const response = await page(address);
            expect(response.status).toBe(200);
          });
          // besides the kind's own list: the signed-in person and the shell's screen preferences, as for every page,
          // and the open requests badge of the sidebar
          expect(statements.map(kind).sort(), address || "audit").toEqual(
            ["open requests", "screen preferences", "session person", ...own].sort(),
          );
          console.info(`activity${address || "?kind=audit"}: ${statements.length} statements`);
        } finally {
          await meter.close();
        }
      }
    } finally {
      rail.mockRestore();
    }

    // the page of the log as `audit.list` reads it with automatic entries hidden: today from the time index, the
    // visibility filter checked per row; a partial index for it comes with the audit service's cursor paging (lane S2)
    const visible = await plan(`
      SELECT * FROM audit.events
      WHERE TRUE AND created_at >= now() - '30 days'::interval
        AND NOT ((metadata->>'provenance' = 'system' AND metadata->>'service' = 'app-workload') IS TRUE)
      ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET 0`);
    console.info(`audit page plan:\n${visible}`);
  }, 120_000);
});
