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
type Tab = "members" | "managers" | "member-of" | "relations";
/** One read of the page: what it is for, whether v1 made it too on this tab, and the call itself. */
type Read = { purpose: string; v1: boolean; run: () => Promise<unknown> };

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
      const count = (groupKinds: ("user" | "group" | "service_account")[]) => () =>
        service.entity.list({ actor, pagination: { page: 1, perPage: 1 }, recursive: false, memberOfGroupId: teamId, kinds: groupKinds });
      return [
        // v1 showed the relations on a page of their own: the open requests and the relations, without the group frame
        { purpose: "group", v1: summary, run: () => service.group.get({ id: teamId }) },
        ...(admin ? [{ purpose: "open requests", v1: true, run: () => service.accountRequest.countPending() }] : []),
        ...(summary
          ? [
              { purpose: "parent group ids", v1: true, run: () => service.group.parent.list({ id: teamId }) },
              { purpose: "managed group ids", v1: true, run: () => service.group.managedGroup.list({ id: teamId }) },
            ]
          : []),
        ...(tab === "members"
          ? [
              {
                purpose: "members page",
                v1: true,
                run: () => service.entity.list({ actor, pagination: page, memberOfGroupId: teamId, recursive: false, kinds }),
              },
            ]
          : tab === "managers"
            ? [
                {
                  purpose: "managers page",
                  v1: true,
                  run: () => service.entity.list({ actor, pagination: page, managerOfGroupId: teamId, kinds }),
                },
              ]
            : tab === "member-of"
              ? [
                  {
                    purpose: "parent groups page",
                    v1: true,
                    run: () => service.entity.list({ actor, pagination: page, parentGroupId: teamId, kinds: ["group" as const] }),
                  },
                ]
              : []),
        // as v1: the direct members on the members tab, the direct managers on the managers tab
        ...(tab === "members"
          ? [{ purpose: "direct members", v1: true, run: () => service.group.member.list({ id: teamId, recursive: false }) }]
          : []),
        ...(tab === "managers" ? [{ purpose: "direct managers", v1: true, run: () => service.group.manager.list({ id: teamId }) }] : []),
        // new: the key figures on the tabs that do not read the members, one count each
        ...(summary && tab !== "members"
          ? [
              { purpose: "count of people and agents", v1: false, run: count(["user", "service_account"]) },
              { purpose: "count of sub-groups", v1: false, run: count(["group"]) },
            ]
          : []),
        // new: the managers' first faces and their number, where the tab does not list them
        ...(summary && tab !== "managers"
          ? [
              {
                purpose: "managers' faces",
                v1: false,
                run: () =>
                  service.entity.list({
                    actor,
                    pagination: { page: 1, perPage: 4 },
                    managerOfGroupId: teamId,
                    kinds: ["user" as const, "group" as const, "service_account" as const],
                  }),
              },
            ]
          : []),
        ...(tab === "relations"
          ? [
              {
                purpose: "relations",
                v1: true,
                run: () => service.group.relations({ actor, focus: teamId, depth: 2, managers: false, view: "graph", expand: [] }),
              },
            ]
          : []),
        ...(admin && summary
          ? [
              {
                purpose: "activity (audit)",
                v1: false,
                run: () => audit.list({ pagination: { page: 1, perPage: 10 }, filter: { target: teamId, outcome: "allowed" } }),
              },
            ]
          : []),
        ...(missing.length
          ? [
              {
                purpose: "names of faces and activity",
                v1: false,
                run: () =>
                  service.entity.list({
                    actor,
                    pagination: { page: 1, perPage: missing.length },
                    userIds: missing,
                    kinds: ["user" as const],
                  }),
              },
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
            const own = statements.filter((text) => !sharedPurpose(text));
            const rest = without(
              own,
              measured.flatMap((entry) => entry.statements),
            );
            // the page makes exactly these reads: nothing missing, nothing more
            expect({ tab: `${who} ${tab}`, rest }).toEqual({ tab: `${who} ${tab}`, rest: [] });
            counts[`${who} ${tab}`] = Object.fromEntries(measured.map((entry) => [entry.read.purpose, entry.statements.length]));
            const of = (v1: boolean) =>
              measured.filter((entry) => !v1 || entry.read.v1).reduce((sum, entry) => sum + entry.statements.length, 0);
            budget[`${who} ${tab}`] = { v1: of(true), v2: of(false) };
          } finally {
            await meter.close();
          }
        }
      }
    } finally {
      rail.mockRestore();
    }
    // The record's own statements per tab, by purpose (besides the session person, the screen preferences and the
    // settings every page reads). The local group's member and manager lists cost five statements, the parent and
    // managed group ids three each; v1 read them the same way. New in v2: the key figures (one count each, or the
    // managers' first faces), the activity for administrators (the audit log's count and rows: `audit.list` always
    // counts) and one directory read for names no row of the page carries.
    const frame = { group: 1, "parent group ids": 3, "managed group ids": 3 };
    const activity = { "activity (audit)": 2, "names of faces and activity": 1 };
    expect(counts).toEqual({
      "admin members": { ...frame, "open requests": 1, "members page": 1, "direct members": 5, "managers' faces": 1, ...activity },
      "admin managers": {
        ...frame,
        "open requests": 1,
        "managers page": 1,
        "direct managers": 5,
        "count of people and agents": 1,
        "count of sub-groups": 1,
        ...activity,
      },
      "admin member-of": {
        ...frame,
        "open requests": 1,
        "parent groups page": 1,
        "count of people and agents": 1,
        "count of sub-groups": 1,
        "managers' faces": 1,
        ...activity,
      },
      "admin relations": { group: 1, "open requests": 1, relations: 2 },
      "manager members": { ...frame, "members page": 1, "direct members": 5, "managers' faces": 1 },
      "manager managers": { ...frame, "managers page": 1, "direct managers": 5, "count of people and agents": 1, "count of sub-groups": 1 },
    });
    // v1 (the page before v2, and the relations page of its own) against v2, statements of the record alone
    expect(budget).toEqual({
      "admin members": { v1: 14, v2: 18 },
      "admin managers": { v1: 14, v2: 19 },
      "admin member-of": { v1: 9, v2: 15 },
      "admin relations": { v1: 3, v2: 4 },
      "manager members": { v1: 13, v2: 14 },
      "manager managers": { v1: 13, v2: 15 },
    });
  }, 120_000);
});
