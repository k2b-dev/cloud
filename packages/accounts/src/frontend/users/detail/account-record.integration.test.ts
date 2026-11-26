import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../../../scripts/fixtures/caller-address";
import { meterSql } from "../../../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../../../scripts/fixtures/test-infra";
import "../../../../../../scripts/fixtures/authorization-preload";
import { stubRailSnapshot } from "../../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";
import { ssr } from "../../../config";

const root = mkdtempSync(join(tmpdir(), "accounts-record-integration-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: recordPage } = await import("./page");

const suite = suiteFor("database", "nats", "valkey");
const tag = crypto.randomUUID().slice(0, 8);
const users: string[] = [];
const accounts: string[] = [];

const person = async (name: string, admin = false) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, admin, last_login_local)
    VALUES (${`record-${name.toLowerCase()}-${tag}`}, 'local', 'user', ${`${name} ${tag}`}, ${admin}, now())
    RETURNING id`;
  users.push(row!.id);
  return row!.id;
};

/**
 * What a statement is for, from its first 120 characters as the meter keeps them. A statement no rule names stays its
 * own text, so a new one shows in the failure as it is.
 */
const purpose = (statement: string): string => {
  const rules: [RegExp, string][] = [
    [/auth\.rail_state/, "session: the signed-in person"],
    [/auth\.screen_preferences/, "shell: screen preferences"],
    [/auth\.account_requests/, "nav: open requests badge"],
    [/auth\.user_posix p WHERE p\.user_id = u\.id/, "a person by id"],
    [/^WITH candidates/, "Linux identity"],
    [/user\.category\./, "settings: account categories"],
    [/^SELECT value FROM settings\.entries WHERE key = \$1/, "settings: one uncached setting"],
    [/'app\.url','app\.name','user\.app_approval/, "settings: sign-in app"],
    [/auth\.app_devices/, "sign-in devices"],
    [/auth\.pwa_devices/, "Cloud app devices"],
    [/auth\.user_groups_v2/, "groups: direct group ids"],
    [/^SELECT g\.id, g\.provider, g\.name/, "groups: one page (member or managed)"],
    [/COUNT\(\*\)::text AS count, 0::text AS automatic_count FROM auth\.service_account_credentials/, "API keys: count"],
    [/^SELECT c\.id, c\.service_account_id/, "API keys: first page"],
    [/audit\.events/, "activity: newest five, no count"],
    [/^SELECT id, name, kind, status, delegated_user_id/, "a service account by id"],
    [/avatar_kind, avatar_config/, "agent picture"],
    [/kind IN \('standalone','agent'\)/, "directory access: the agent check"],
    [/auth\.directory_shares/, "directory access: count"],
    [/^SELECT share\.id/, "directory access: first page"],
  ];
  return rules.find(([pattern]) => pattern.test(statement))?.[1] ?? statement;
};

const server = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  });
  // the route as Accounts mounts it: the administrator check of the route, then the page
  app.route("/", new Hono<AuthContext>().get("/app/accounts/users/:id", auth.requireRole("admin", ssr.access), ...recordPage));
  return app;
};

/** The statements of one request to the record, after a warm-up request of the same address. */
const statementsOf = async (address: string, headers: Record<string, string>, expected: string) => {
  const app = server();
  const page = () => app.request(address, { headers });
  expect((await page()).status).toBe(200);
  const meter = await meterSql();
  try {
    return await meter.during(async () => {
      const response = await page();
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(expected);
    });
  } finally {
    await meter.close();
  }
};

suite("the account record's statement budget on its real route (integration)", () => {
  afterAll(async () => {
    for (const id of accounts) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("a person's record and an agent's record read their areas in a known list of statements", async () => {
    const adminId = await person("Ada", true);
    const personId = await person("Milan");
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind, created_by) VALUES (${`Wochenbericht ${tag}`}, 'agent', ${adminId}::uuid) RETURNING id`;
    accounts.push(agent!.id);
    const headers = { cookie: `session_token=${await createTestSession(adminId)}`, "x-forwarded-for": uniqueCallerAddress() };
    const rail = stubRailSnapshot();
    try {
      const report: Record<string, string[]> = {};
      for (const tab of ["", "?tab=groups", "?tab=keys", "?tab=devices"])
        report[`person ${tab || "overview"}`] = (await statementsOf(`/app/accounts/users/${personId}${tab}`, headers, `Milan ${tag}`))
          .map(purpose)
          .sort();
      report.agent = (await statementsOf(`/app/accounts/users/${agent!.id}`, headers, `Wochenbericht ${tag}`)).map(purpose).sort();
      expect(report).toEqual(EXPECTED);
    } finally {
      rail.mockRestore();
    }
  }, 120_000);
});

/**
 * Every tab of a person's record reads the same: the record is one page whose tabs only choose what shows. v1 read the
 * same list without the activity (16); the activity adds its one statement. An agent reads 12; v1's agent page read 8
 * (session, preferences, badge, the account, its picture, its creator, keys count and page): the record first asks
 * whether the id is a person (1), and the directory access, which v1 showed on another page, adds its check, count and
 * page (3).
 */
const PERSON = [
  "API keys: count",
  "API keys: first page",
  "Cloud app devices",
  "Linux identity",
  "a person by id",
  "activity: newest five, no count",
  "groups: direct group ids",
  "groups: one page (member or managed)",
  "groups: one page (member or managed)",
  "nav: open requests badge",
  "session: the signed-in person",
  "settings: account categories",
  "settings: one uncached setting",
  "settings: sign-in app",
  "settings: sign-in app",
  "shell: screen preferences",
  "sign-in devices",
];
const EXPECTED: Record<string, string[]> = {
  "person overview": PERSON,
  "person ?tab=groups": PERSON,
  "person ?tab=keys": PERSON,
  "person ?tab=devices": PERSON,
  agent: [
    "API keys: count",
    "API keys: first page",
    "a person by id",
    "a person by id",
    "a service account by id",
    "agent picture",
    "directory access: count",
    "directory access: first page",
    "directory access: the agent check",
    "nav: open requests badge",
    "session: the signed-in person",
    "shell: screen preferences",
  ],
};
