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
    [/^SELECT ug\.group_id FROM auth\.user_groups_v2/, "groups: direct group ids"],
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
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES (${`Inventar ${tag}`}, 'resource_bound', 'pulse', 'base', ${`inventar-${tag}`}) RETURNING id`;
    accounts.push(resource!.id);
    const headers = { cookie: `session_token=${await createTestSession(adminId)}`, "x-forwarded-for": uniqueCallerAddress() };
    const rail = stubRailSnapshot();
    try {
      const report: Record<string, string[]> = {};
      for (const tab of ["", "?tab=groups", "?tab=groups&recursive=true", "?tab=keys", "?tab=devices"])
        report[`person ${tab || "overview"}`] = (await statementsOf(`/app/accounts/users/${personId}${tab}`, headers, `Milan ${tag}`))
          .map(purpose)
          .sort();
      report.agent = (await statementsOf(`/app/accounts/users/${agent!.id}`, headers, `Wochenbericht ${tag}`)).map(purpose).sort();
      report.resource = (await statementsOf(`/app/accounts/users/${resource!.id}`, headers, `Inventar ${tag}`)).map(purpose).sort();
      expect(report).toEqual(EXPECTED);
    } finally {
      rail.mockRestore();
    }
  }, 120_000);
});

/**
 * A person's record reads the head (the person, the badge, the account categories, plus the session person and the
 * screen preferences of every page) and only the open tab, in two rounds: the person and the badge, then the rest at
 * once. v1 read every area on every load: 16 statements. The agent kind reads 12 (v1's agent page 8: the record
 * first asks whether the id is a person, and its directory access, which v1 showed elsewhere, adds three), the API key
 * kind 7; both in three rounds (person and badge, the account, its areas).
 */
const HEAD = ["a person by id", "nav: open requests badge", "session: the signed-in person", "settings: account categories", "shell: screen preferences"];
const sorted = (list: string[]) => [...list].sort();
const EXPECTED: Record<string, string[]> = {
  // 9: the direct groups' first page with their number, the Linux identity, the newest activity, one setting
  "person overview": sorted([
    ...HEAD,
    "Linux identity",
    "activity: newest five, no count",
    "groups: one page (member or managed)",
    "settings: one uncached setting",
  ]),
  // 7: one page of the direct groups and one of the managed groups
  "person ?tab=groups": sorted([...HEAD, "groups: one page (member or managed)", "groups: one page (member or managed)"]),
  // 8: with inherited groups, the memberships' page and which of them are direct
  "person ?tab=groups&recursive=true": sorted([
    ...HEAD,
    "groups: one page (member or managed)",
    "groups: one page (member or managed)",
    "groups: direct group ids",
  ]),
  // 7: the key section's first page and its count
  "person ?tab=keys": sorted([...HEAD, "API keys: count", "API keys: first page"]),
  // 9: both kinds of device and the sign-in app's settings
  "person ?tab=devices": sorted([...HEAD, "Cloud app devices", "settings: sign-in app", "settings: sign-in app", "sign-in devices"]),
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
  resource: sorted([
    "API keys: count",
    "API keys: first page",
    "a person by id",
    "a service account by id",
    "nav: open requests badge",
    "session: the signed-in person",
    "shell: screen preferences",
  ]),
};
