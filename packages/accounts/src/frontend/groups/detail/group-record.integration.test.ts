import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { accountsAppService, audit } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../../../scripts/fixtures/caller-address";
import { meterSql } from "../../../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../../../scripts/fixtures/test-infra";
import "../../../../../../scripts/fixtures/authorization-preload";
import { stubRailSnapshot } from "../../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";
import { ssr } from "../../../config";

const root = mkdtempSync(join(tmpdir(), "accounts-group-record-integration-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: groupPage } = await import("./page");

const suite = suiteFor("database", "nats", "valkey");
const tag = crypto.randomUUID().slice(0, 8);
const users: string[] = [];
const groups: string[] = [];

const person = async (name: string, admin = false) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, admin, last_login_local)
    VALUES (${`group-record-${name.toLowerCase()}-${tag}`}, 'local', 'user', ${`${name} ${tag}`}, ${admin}, now())
    RETURNING id`;
  users.push(row!.id);
  return row!.id;
};
const group = async (name: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.groups (cn, provider, name) VALUES (${`local:${name}-${tag}`}, 'local', ${`${name}-${tag}`}) RETURNING id`;
  groups.push(row!.id);
  return row!.id;
};

/** The statements every page of a signed-in person reads, whatever it shows: they are not the record's. */
const shared: [string, (text: string) => boolean][] = [
  ["session person", (text) => text.startsWith("SELECT u.*, (SELECT cache_version::text FROM auth.rail_state")],
  ["screen preferences", (text) => text.includes("auth.screen_preferences")],
  ["setting", (text) => text.includes("settings")],
];
const sharedPurpose = (text: string) => shared.find(([, match]) => match(text))?.[0];

type Who = "admin" | "manager";
/** The changes the record's activity tells, as `page.tsx` asks the audit log for them. */
const ACTIONS = [
  "accounts.group.create",
  "accounts.group.update",
  "accounts.group.make_posix",
  "accounts.group.member.add",
  "accounts.group.member.remove",
  "accounts.group.manager.add",
  "accounts.group.manager.remove",
];
type Tab = "members" | "managers" | "member-of" | "relations";
/** One read of the page: what it is for, whether v1 made it too on this tab, and the call itself. */
/** One read: what it is for, whether v1 made it on this tab, whether v2 makes it, and the call itself. */
type Read = { purpose: string; v1: boolean; v2: boolean; run: () => Promise<unknown> };

/** `list` without one of each of `remove`; null when one of `remove` is not in `list`. */
const without = (list: string[], remove: string[]) => {
  const rest = [...list];
  for (const text of remove) {
    const at = rest.indexOf(text);
    if (at === -1) return null;
    rest.splice(at, 1);
  }
  return rest;
};

suite("a group record's statements per tab (integration)", () => {
  afterAll(async () => {
    for (const id of groups) await sql`DELETE FROM auth.groups WHERE id = ${id}::uuid`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    await sql`DELETE FROM auth.users WHERE uid LIKE ${`group-record-big-%-${tag}`}`;
  });

  test("an administrator and a manager read the same group with a known set of statements on every tab", async () => {
    const adminId = await person("Ada", true);
    const managerId = await person("Milan");
    const memberIds = [await person("Jana"), await person("Ole"), managerId];
    const teamId = await group("team");
    const subId = await group("platform");
    const parentId = await group("staff");
    for (const id of memberIds) await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${id}::uuid, ${teamId}::uuid)`;
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${teamId}::uuid, ${subId}::uuid)`;
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parentId}::uuid, ${teamId}::uuid)`;
    await sql`INSERT INTO auth.group_manager_users_v2 (group_id, user_id) VALUES (${teamId}::uuid, ${managerId}::uuid)`;
    await audit.record({
      action: "accounts.group.member.add",
      outcome: "allowed",
      actor: { userId: adminId, uid: `group-record-ada-${tag}` },
      target: { type: "group", id: teamId, label: `team-${tag}`, provider: "local" },
      metadata: { userId: memberIds[0], groupId: null, serviceAccountId: null },
    });

    const actors = {
      admin: { userId: adminId, uid: `group-record-ada-${tag}`, roles: ["user", "admin"], provider: "local" as const },
      manager: { userId: managerId, uid: `group-record-milan-${tag}`, roles: ["user"], provider: "local" as const },
    };
    const service = accountsAppService;
    const page = { page: 1, perPage: 100 };
    const kinds = ["user" as const, "group" as const];
    /** The reads the record makes for one person on one tab, in the words of their purpose, as `page.tsx` calls them. */
    const reads = (who: Who, tab: Tab): Read[] => {
      const actor = actors[who];
      const admin = who === "admin";
      const summary = tab !== "relations";
      // who the page names already: the tab's own rows, and the managers' faces read beside them
      const onPage: Record<Tab, string[]> = {
        members: [...memberIds, subId, managerId],
        managers: [managerId],
        "member-of": [parentId, managerId],
        relations: [],
      };
      const wanted = admin && summary ? [adminId, memberIds[0]!] : [];
      const missing = [...new Set(wanted)].filter((id) => !onPage[tab].includes(id));
      const count = (filter: { memberOfGroupId?: string; parentGroupId?: string }, groupKinds: ("user" | "group" | "service_account")[]) => () =>
        service.entity.list({ actor, pagination: { page: 1, perPage: 1 }, recursive: false, ...filter, kinds: groupKinds });
      const both = (purpose: string, run: () => Promise<unknown>, v1 = true): Read => ({ purpose, v1, v2: true, run });
      const v1Only = (purpose: string, run: () => Promise<unknown>): Read => ({ purpose, v1: true, v2: false, run });
      const v2Only = (purpose: string, run: () => Promise<unknown>): Read => ({ purpose, v1: false, v2: true, run });
      return [
        // v1 showed the relations on a page of their own: the open requests and the relations, without the group frame
        both("group", () => service.group.get({ id: teamId }), summary),
        ...(admin ? [both("open requests", () => service.accountRequest.countPending())] : []),
        ...(summary
          ? [
              v1Only("parent group ids (all)", () => service.group.parent.list({ id: teamId })),
              both("managed group ids", () => service.group.managedGroup.list({ id: teamId })),
            ]
          : []),
        ...(tab === "members"
          ? [both("members page", () => service.entity.list({ actor, pagination: page, memberOfGroupId: teamId, recursive: false, kinds }))]
          : tab === "managers"
            ? [both("managers page", () => service.entity.list({ actor, pagination: page, managerOfGroupId: teamId, kinds }))]
            : tab === "member-of"
              ? [both("parent groups page", () => service.entity.list({ actor, pagination: page, parentGroupId: teamId, kinds: ["group" as const] }))]
              : []),
        // v1 loaded the whole direct member or manager list on its tab; v2 pages and counts in the database instead
        ...(tab === "members" ? [v1Only("direct members (all)", () => service.group.member.list({ id: teamId, recursive: false }))] : []),
        ...(tab === "managers" ? [v1Only("direct managers (all)", () => service.group.manager.list({ id: teamId }))] : []),
        ...(summary
          ? [
              v2Only("count of people", count({ memberOfGroupId: teamId }, ["user"])),
              v2Only("count of agents", count({ memberOfGroupId: teamId }, ["service_account"])),
              v2Only("count of sub-groups", count({ memberOfGroupId: teamId }, ["group"])),
              ...(tab !== "member-of" ? [v2Only("count of parent groups", count({ parentGroupId: teamId }, ["group"]))] : []),
              v2Only("managers' faces", () =>
                service.entity.list({
                  actor,
                  pagination: { page: 1, perPage: 4 },
                  managerOfGroupId: teamId,
                  kinds: ["user" as const, "group" as const, "service_account" as const],
                }),
              ),
            ]
          : []),
        ...(tab === "relations"
          ? [both("relations", () => service.group.relations({ actor, focus: teamId, depth: 2, managers: false, view: "graph", expand: [] }))]
          : []),
        ...(admin && summary
          ? [
              v2Only("activity (audit)", () =>
                audit.latest({ target: { type: "group", id: teamId }, actions: ACTIONS, outcome: "allowed", limit: 5 }),
              ),
            ]
          : []),
        ...(missing.length
          ? [
              v2Only("names of the activity", () =>
                service.entity.list({ actor, pagination: { page: 1, perPage: missing.length }, userIds: missing, kinds: ["user" as const] }),
              ),
            ]
          : []),
      ];
    };

    const rail = stubRailSnapshot();
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      await next();
    });
    // the route as Accounts mounts it: the signed-in check of the route, then the page
    app.route("/", new Hono<AuthContext>().get("/app/accounts/groups/:id", auth.requireRole("user", ssr.access), ...groupPage));
    const counts: Record<string, Record<string, number>> = {};
    const budget: Record<string, { v1: number; v2: number }> = {};
    try {
      for (const [who, id, tabs] of [
        ["admin", adminId, ["members", "managers", "member-of", "relations"]],
        ["manager", managerId, ["members", "managers"]],
      ] as const) {
        const headers = { cookie: `session_token=${await createTestSession(id)}`, "x-forwarded-for": uniqueCallerAddress() };
        for (const tab of tabs) {
          const open = () => app.request(`/app/accounts/groups/${teamId}?tab=${tab}`, { headers });
          // the session and the settings are warm, as on every running server
          expect((await open()).status).toBe(200);
          const meter = await meterSql();
          try {
            const statements = await meter.during(async () => {
              const response = await open();
              expect(response.status).toBe(200);
              await response.text();
            });
            // each read of the record alone, with the arguments the page gives it
            const measured: { read: Read; statements: string[] }[] = [];
            for (const read of reads(who, tab)) measured.push({ read, statements: await meter.during(read.run) });
            const made = measured.filter((entry) => entry.read.v2);
            const own = statements.filter((text) => !sharedPurpose(text));
            const rest = without(
              own,
              made.flatMap((entry) => entry.statements),
            );
            // the page makes exactly these reads: nothing missing, nothing more
            expect({ tab: `${who} ${tab}`, rest }).toEqual({ tab: `${who} ${tab}`, rest: [] });
            counts[`${who} ${tab}`] = Object.fromEntries(made.map((entry) => [entry.read.purpose, entry.statements.length]));
            const of = (pick: (read: Read) => boolean) =>
              measured.filter((entry) => pick(entry.read)).reduce((sum, entry) => sum + entry.statements.length, 0);
            budget[`${who} ${tab}`] = { v1: of((read) => read.v1), v2: of((read) => read.v2) };
          } finally {
            await meter.close();
          }
        }
      }
    } finally {
      rail.mockRestore();
    }
    // The record's own statements per tab, by purpose (besides the session person, the screen preferences and the
    // settings every page reads). Every list is a page from the database: the tab's page of at most 100 rows, one
    // count each for the key figures, the managers' first four faces; the managed group ids (three statements) as v1;
    // for administrators the audit log's newest rows (one statement) and one directory read for names no row carries.
    const figures = { "count of people": 1, "count of agents": 1, "count of sub-groups": 1, "managers' faces": 1 };
    const frame = { group: 1, "managed group ids": 3, ...figures };
    const activity = { "activity (audit)": 1, "names of the activity": 1 };
    expect(counts).toEqual({
      "admin members": { ...frame, "open requests": 1, "members page": 1, "count of parent groups": 1, ...activity },
      "admin managers": { ...frame, "open requests": 1, "managers page": 1, "count of parent groups": 1, ...activity },
      "admin member-of": { ...frame, "open requests": 1, "parent groups page": 1, ...activity },
      "admin relations": { group: 1, "open requests": 1, relations: 2 },
      "manager members": { ...frame, "members page": 1, "count of parent groups": 1 },
      "manager managers": { ...frame, "managers page": 1, "count of parent groups": 1 },
    });
    // v1 (the page before v2 with its whole member and manager lists, and the relations page of its own) against v2
    expect(budget).toEqual({
      "admin members": { v1: 14, v2: 13 },
      "admin managers": { v1: 14, v2: 13 },
      "admin member-of": { v1: 9, v2: 12 },
      "admin relations": { v1: 3, v2: 4 },
      "manager members": { v1: 13, v2: 10 },
      "manager managers": { v1: 13, v2: 10 },
    });
  }, 120_000);

  test("a group of 5,000 direct members costs the same statements as a small one, and none of them returns more than a page", async () => {
    const adminId = await person("Lea", true);
    const bigId = await group("big");
    const managerId = await person("Kai");
    // 5,000 people in one statement, all of them direct members
    await sql`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      SELECT 'group-record-big-' || n || '-' || ${tag}, 'local', 'user', 'Person ' || n || ' ' || ${tag}
      FROM generate_series(1, 5000) AS n`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id)
      SELECT id, ${bigId}::uuid FROM auth.users WHERE uid LIKE ${`group-record-big-%-${tag}`}`;
    await sql`INSERT INTO auth.group_manager_users_v2 (group_id, user_id) VALUES (${bigId}::uuid, ${managerId}::uuid)`;

    // the indexes the member and manager reads use. On the test database this one group holds nearly every row, so
    // its own plan is rightly a sequential scan; any group among many is found by the index:
    const lines = (rows: { "QUERY PLAN": string }[]) => rows.map((row) => row["QUERY PLAN"]).join("\n");
    await sql`ANALYZE auth.user_groups_v2`;
    const other = crypto.randomUUID();
    const membersPlan = lines(await sql<{ "QUERY PLAN": string }[]>`EXPLAIN SELECT user_id FROM auth.user_groups_v2 WHERE group_id = ${other}::uuid`);
    const managersPlan = lines(
      await sql<{ "QUERY PLAN": string }[]>`EXPLAIN SELECT user_id FROM auth.group_manager_users_v2 WHERE group_id = ${bigId}::uuid`,
    );
    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'auth' AND tablename IN ('user_groups_v2', 'group_manager_users_v2') ORDER BY indexname`;
    console.log(`GROUP-RECORD-PLANS ${JSON.stringify({ membersPlan, managersPlan, indexes: indexes.map((row) => row.indexdef) })}`);
    expect(membersPlan).toContain("idx_user_groups_v2_group");
    expect(managersPlan).toContain("group_manager_users_v2_pkey");

    // rows each read returns: before, the whole direct member list; now one page, one row per count, four faces
    const actor = { userId: adminId, uid: `group-record-lea-${tag}`, roles: ["user", "admin"], provider: "local" as const };
    const before = (await accountsAppService.group.member.list({ id: bigId, recursive: false })).items.length;
    const membersPage = await accountsAppService.entity.list({
      actor,
      pagination: { page: 1, perPage: 100 },
      memberOfGroupId: bigId,
      recursive: false,
      kinds: ["user", "group"],
    });
    const people = await accountsAppService.entity.list({
      actor,
      pagination: { page: 1, perPage: 1 },
      memberOfGroupId: bigId,
      recursive: false,
      kinds: ["user"],
    });
    expect(before).toBe(5000);
    expect(membersPage.items).toHaveLength(100);
    expect(membersPage.total).toBe(5000);
    expect(people.items).toHaveLength(1);
    expect(people.total).toBe(5000);
    console.log(`GROUP-RECORD-ROWS ${JSON.stringify({ before, after: { page: membersPage.items.length, count: people.items.length } })}`);

    const rail = stubRailSnapshot();
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      await next();
    });
    app.route("/", new Hono<AuthContext>().get("/app/accounts/groups/:id", auth.requireRole("user", ssr.access), ...groupPage));
    const headers = { cookie: `session_token=${await createTestSession(adminId)}`, "x-forwarded-for": uniqueCallerAddress() };
    const sizes: Record<string, number> = {};
    try {
      const wholeList = await (async () => {
        const meter = await meterSql();
        try {
          // the statements that load the whole list's rows (the group itself, which every page reads, is not one)
          const statements = await meter.during(() => accountsAppService.group.member.list({ id: bigId, recursive: false }));
          return statements.filter((text) => !text.startsWith("SELECT g.id, g.provider, g.name, g.description, g.gid_number, personal_owner") && !text.includes("WHERE id = $1 ::uuid"));
        } finally {
          await meter.close();
        }
      })();
      for (const tab of ["members", "managers", "member-of"]) {
        const open = () => app.request(`/app/accounts/groups/${bigId}?tab=${tab}`, { headers });
        expect((await open()).status).toBe(200);
        const meter = await meterSql();
        try {
          let html = "";
          const statements = await meter.during(async () => {
            const response = await open();
            expect(response.status).toBe(200);
            html = await response.text();
          });
          sizes[tab] = html.length;
          // the whole member list is never read: none of its statements runs
          for (const text of new Set(wholeList)) expect({ tab, text, ran: statements.includes(text) }).toEqual({ tab, text, ran: false });
          if (tab === "members") expect(html).toContain("Page 1 of 50");
          // as many statements as for three members: the small group's count without the activity, which has no events here
          expect({ tab, own: statements.filter((text) => !sharedPurpose(text)).length }).toEqual({ tab, own: tab === "member-of" ? 11 : 12 });
        } finally {
          await meter.close();
        }
      }
    } finally {
      rail.mockRestore();
    }
    // the page carries one page of rows, never the group: 100 rows on the members tab
    console.log(`GROUP-RECORD-SIZES ${JSON.stringify(sizes)}`);
    expect(sizes.members).toBeLessThan(400_000);
  }, 180_000);
});
