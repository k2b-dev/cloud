import { expect, test } from "bun:test";
import { meterSql } from "../../../../../scripts/fixtures/sql-meter";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { createAccess, getEffectivePermissions } from "../../server/services/access";
import { accountsAppService } from "./app";
import type { AccountsActor } from "./authz";

const suite = databaseSuite();

const insertGroup = async (suffix: string, label: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.groups (cn, provider, name)
    VALUES (${`relations-${label}-${suffix}`}, 'local', ${`Relations ${label} ${suffix}`})
    RETURNING id
  `;
  return row!.id;
};

const insertUser = async (suffix: string, label: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`relations-${label}-${suffix}`}, 'local', 'user', ${`Relations ${label}`}, ${`relations-${label}-${suffix}@example.test`})
    RETURNING id
  `;
  return row!.id;
};

// FreeIPA can bring cycles that local editing refuses; the view must show them, so the fixture writes edges directly.
const contains = (parent: string, child: string) =>
  sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent}::uuid, ${child}::uuid)`;
const manages = (manager: string, group: string) =>
  sql`INSERT INTO auth.group_manager_groups_v2 (group_id, manager_group_id) VALUES (${group}::uuid, ${manager}::uuid)`;

const admin = (userId: string): AccountsActor => ({ userId, uid: "relations-admin", roles: ["admin", "user"], provider: "local" });

suite("group relations (integration)", () => {
  test("levels, back edges, and cycles around one group, in two statements at any depth", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [all, tech, platform, oncall, sales, north, lead] = await Promise.all(
      ["all", "tech", "platform", "oncall", "sales", "north", "lead"].map((label) => insertGroup(suffix, label)),
    );
    for (const [parent, child] of [
      [all, tech],
      [all, sales],
      [tech, platform],
      [platform, oncall],
      [oncall, tech],
      [sales, north],
    ] as const)
      await contains(parent!, child!);
    await manages(lead!, sales!);
    await manages(sales!, lead!);
    const member = await insertUser(suffix, "member");
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${member}::uuid, ${tech}::uuid)`;
    const actor = admin(await insertUser(suffix, "admin"));

    const meter = await meterSql();
    try {
      let result: Awaited<ReturnType<typeof accountsAppService.group.relations>> | undefined;
      const statements = await meter.during(async () => {
        result = await accountsAppService.group.relations({ actor, focus: tech, depth: 2, managers: false, view: "graph" });
      });
      expect(statements).toHaveLength(2);
      if (!result?.ok) throw new Error("relations failed");
      const relations = result.data;
      const name = (id: string) => relations.nodes.find((node) => node.id === id)?.name;
      expect(relations.focus).toBe(tech!);
      expect(relations.columns.map((column) => column.key)).toEqual(["u1", "d1", "d2"]);
      expect(relations.columns[0]).toEqual({
        key: "u1",
        items: [{ id: all!, via: tech! }],
        backs: [{ from: tech!, to: oncall!, closesCycle: true }],
        hidden: 0,
      });
      expect(relations.columns[1]!.items).toEqual([{ id: platform!, via: tech! }]);
      expect(relations.columns[2]!.items).toEqual([{ id: oncall!, via: platform! }]);
      expect(relations.nodes.find((node) => node.id === tech)).toMatchObject({ members: 1, contains: 1, inCycle: true });
      expect(relations.nodes.find((node) => node.id === all)).toMatchObject({ contains: 2, inCycle: false });
      expect(relations.selected?.cycle).toEqual({ path: [tech!, platform!, oncall!, tech!], size: 3 });
      expect(relations.selected?.parents.ids.map(name)).toEqual([name(all!), name(oncall!)]);
      expect(relations.selected?.manages).toBeNull();
      expect(relations.cycles.count).toBeGreaterThanOrEqual(1);
      expect(relations.truncated).toBe(false);
      expect(relations.cyclesComplete).toBe(true);

      // Deeper levels, managers, and a selection: still two statements.
      const deeper = await meter.during(async () => {
        result = await accountsAppService.group.relations({ actor, focus: all, selected: sales, depth: 4, managers: true, view: "graph" });
      });
      expect(deeper).toHaveLength(2);
      if (!result?.ok) throw new Error("relations failed");
      expect(result.data.columns.map((column) => column.key)).toEqual(["d1", "d2", "d3", "d4"]);
      expect(result.data.columns[3]!.backs).toEqual([{ from: oncall!, to: tech!, closesCycle: true }]);
      expect(result.data.selected?.manages?.ids).toEqual([lead!]);
      expect(result.data.selected?.managedBy?.ids).toEqual([lead!]);
      expect(result.data.selected?.managerCycle).toEqual({ path: [sales!, lead!, sales!], size: 2 });
      expect(result.data.selected?.cycle).toBeNull();

      const list = await meter.during(async () => {
        result = await accountsAppService.group.relations({ actor, focus: tech, depth: 2, managers: false, view: "list" });
      });
      expect(list).toHaveLength(2);
      if (!result?.ok) throw new Error("relations failed");
      const roots = await accountsAppService.group.relations({ actor, depth: 2, managers: false, view: "list", expand: ["roots"] });
      if (!roots.ok) throw new Error("relations failed");
      expect(roots.data.roots?.ids).toContain(all!);
      expect(roots.data.roots?.ids).not.toContain(tech!);
      expect(roots.data.roots?.hidden).toBe(0);
    } finally {
      await meter.close();
    }
  });

  test("only administrators see relations, and an unknown focus is not found", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const userId = await insertUser(suffix, "plain");
    const denied = await accountsAppService.group.relations({
      actor: { userId, uid: "relations-plain", roles: ["user"], provider: "local" },
      depth: 2,
      managers: false,
      view: "graph",
    });
    expect(denied.ok ? null : denied.error.status).toBe(403);
    const missing = await accountsAppService.group.relations({
      actor: admin(userId),
      focus: crypto.randomUUID(),
      depth: 2,
      managers: false,
      view: "graph",
    });
    expect(missing.ok ? null : missing.error.status).toBe(404);
  });

  test("a cut edge read says so for each kind and gives the same answer on every reload", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [a, b, c, d] = await Promise.all(["a", "b", "c", "d"].map((label) => insertGroup(suffix, label)));
    await contains(a!, b!);
    await contains(b!, c!);
    await contains(c!, d!);
    await manages(a!, b!);
    await manages(b!, a!);
    const actor = admin(await insertUser(suffix, "admin"));
    const read = async (edgeLimit: number) => {
      const result = await accountsAppService.group.relations({ actor, focus: a, depth: 4, managers: true, view: "graph", edgeLimit });
      if (!result.ok) throw new Error("relations failed");
      return result.data;
    };
    const cut = await read(1);
    expect(cut).toMatchObject({ truncated: true, cyclesComplete: false, managerCyclesComplete: false });
    expect(await read(1)).toEqual(cut);
    // Management edges have their own limit: they never push out membership edges.
    const whole = await read(1_000_000);
    expect(whole).toMatchObject({ truncated: false, cyclesComplete: true, managerCyclesComplete: true });
    expect(whole.columns.map((column) => column.items.map((item) => item.id))).toEqual([[b!], [c!], [d!]]);
  });

  test("a personal group is never a focus and never a neighbour", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [team, personal] = await Promise.all(["team", "personal"].map((label) => insertGroup(suffix, label)));
    const owner = await insertUser(suffix, "owner");
    const gid = 400_000 + Math.floor(Math.random() * 500_000);
    await sql`INSERT INTO auth.personal_groups (group_id, owner_id, group_name, gid_number)
      VALUES (${personal}::uuid, ${owner}::uuid, ${`relations-personal-${suffix}`}, ${gid})`;
    await contains(team!, personal!);
    await contains(personal!, team!);
    const actor = admin(await insertUser(suffix, "admin"));
    const asFocus = await accountsAppService.group.relations({ actor, focus: personal, depth: 2, managers: false, view: "graph" });
    expect(asFocus.ok ? null : asFocus.error.status).toBe(404);
    const around = await accountsAppService.group.relations({ actor, focus: team, depth: 2, managers: false, view: "graph" });
    if (!around.ok) throw new Error("relations failed");
    expect(around.data.columns).toEqual([]);
    expect(around.data.nodes.map((node) => node.id)).not.toContain(personal);
    expect(around.data.selected).toMatchObject({ parents: { total: 0 }, children: { total: 0 } });
    // The cycle runs through the personal group, so it is not one here.
    expect(around.data.selected?.cycle).toBeNull();
  });

  test("a column shows 10 groups and the next level grows only from those, unless it is expanded", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const parent = await insertGroup(suffix, "parent");
    // Zero-padded labels keep the name order equal to the number order.
    for (let index = 0; index < 12; index += 1) {
      const label = `child-${String(index).padStart(2, "0")}`;
      const child = await insertGroup(suffix, label);
      await contains(parent, child);
      await contains(child, await insertGroup(suffix, `${label}-grandchild`));
    }
    const actor = admin(await insertUser(suffix, "admin"));
    const read = async (expand: string[]) => {
      const result = await accountsAppService.group.relations({ actor, focus: parent, depth: 2, managers: false, view: "graph", expand });
      if (!result.ok) throw new Error("relations failed");
      return result.data;
    };
    const budgeted = await read([]);
    expect(budgeted.columns.map((column) => [column.key, column.items.length, column.hidden])).toEqual([
      ["d1", 10, 2],
      ["d2", 10, 0],
    ]);
    const shown = new Set(budgeted.columns[0]!.items.map((item) => item.id));
    expect(budgeted.columns[1]!.items.every((item) => shown.has(item.via))).toBe(true);
    const expanded = await read(["d1"]);
    expect(expanded.columns.map((column) => [column.key, column.items.length, column.hidden])).toEqual([
      ["d1", 12, 0],
      ["d2", 10, 2],
    ]);
  });

  test("a check and a member list cost the same statements for a direct and a nested membership", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [top, middle, lower, bottom, flat] = await Promise.all(
      ["top", "middle", "lower", "bottom", "flat"].map((label) => insertGroup(suffix, label)),
    );
    await contains(top!, middle!);
    await contains(middle!, lower!);
    await contains(lower!, bottom!);
    const nestedUser = await insertUser(suffix, "nested");
    const directUser = await insertUser(suffix, "direct");
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${nestedUser}::uuid, ${bottom}::uuid)`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${directUser}::uuid, ${flat}::uuid)`;
    const nestedGrant = await createAccess({ principal: { type: "group", groupId: top! }, permission: "read" });
    const flatGrant = await createAccess({ principal: { type: "group", groupId: flat! }, permission: "read" });
    if (!nestedGrant.ok || !flatGrant.ok) throw new Error("grant failed");

    const meter = await meterSql();
    try {
      const check = (accessId: string, userId: string) => () =>
        getEffectivePermissions({ accessIds: [accessId], subjects: [{ type: "user", userId }] }).then((levels) =>
          expect(levels).toEqual(["read"]),
        );
      const flatCheck = await meter.during(check(flatGrant.data.id, directUser));
      const nestedCheck = await meter.during(check(nestedGrant.data.id, nestedUser));
      expect(flatCheck).toHaveLength(1);
      expect(nestedCheck).toHaveLength(flatCheck.length);

      const members = (id: string, expected: number) => () =>
        accountsAppService.group.member
          .list({ id, recursive: true, filter: { type: "user" } })
          .then((page) => expect(page.total).toBe(expected));
      const flatMembers = await meter.during(members(flat!, 1));
      const nestedMembers = await meter.during(members(top!, 1));
      // Group, local group, member tree, nested groups, service accounts: five, however deep the nesting.
      expect(flatMembers).toHaveLength(5);
      expect(nestedMembers).toHaveLength(flatMembers.length);
    } finally {
      await meter.close();
    }
  });
});
