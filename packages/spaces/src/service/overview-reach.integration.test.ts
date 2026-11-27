import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite, testInfra, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";

// A private database: the counts below are exact, with no Space of a parallel suite in reach.
const database = testInfra.database ? await useMigratedDatabase("spaces_reach") : undefined;
const { newShortId } = await import("../lib/short-id");
const activity = await import("./activity");
const { loadOverviewCounts, loadOverviewWork, loadReachableSpaces, loadSpacesSidebar } = await import("./overview");

const NOW = new Date("2026-11-27T12:00:00.000Z");
const dateConfig = { locale: "en", timeZone: "UTC" };
const views = ["mine", "today", "upcoming"] as const;

const insertUser = async (name: string) => {
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
    VALUES (${crypto.randomUUID()}, 'local', 'user', ${name}) RETURNING id`;
  return row!.id;
};

/** A Space with one grant, two open tasks for the reader (due today and in three days) and one activity row. */
const insertSpace = async (name: string, grant: { userId?: string; groupId?: string; permission: string }, readerId: string) => {
  const [space] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, ${name}) RETURNING id`;
  const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name)
    VALUES (${newShortId()}, ${space!.id}::uuid, 'Open') RETURNING id`;
  const items = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title, deadline)
    VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, ${`${name} today`}, '2026-11-27T15:00:00Z'),
      (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, ${`${name} later`}, '2026-11-30T12:00:00Z') RETURNING id`;
  for (const item of items) await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${item.id}::uuid, ${readerId}::uuid)`;
  await sql`INSERT INTO spaces.activity_events (space_id, item_id, actor_kind, actor_id, action, created_at, last_occurred_at)
    VALUES (${space!.id}::uuid, ${items[0]!.id}::uuid, 'user', ${readerId}::uuid, 'item.created', '2026-11-27T09:00:00Z', '2026-11-27T09:00:00Z')`;
  const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, group_id, permission)
    VALUES (${grant.userId ?? null}::uuid, ${grant.groupId ?? null}::uuid, ${grant.permission}) RETURNING id`;
  await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space!.id}::uuid, ${access!.id}::uuid)`;
  return { id: space!.id, accessId: access!.id };
};

let reader = "";
let nobody = "";
let direct = { id: "", accessId: "" };

beforeAll(async () => {
  if (!database) return;
  setSystemTime(NOW);
  reader = await insertUser("Reach reader");
  nobody = await insertUser("Reach nobody");
  const stranger = await insertUser("Reach stranger");
  const groupId = crypto.randomUUID();
  const parentGroupId = crypto.randomUUID();
  await sql`INSERT INTO auth.groups (id, provider, name, cn) VALUES (${groupId}::uuid, 'local', ${groupId}, ${groupId}), (${parentGroupId}::uuid, 'local', ${parentGroupId}, ${parentGroupId})`;
  await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parentGroupId}::uuid, ${groupId}::uuid)`;
  await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${reader}::uuid, ${groupId}::uuid)`;
  direct = await insertSpace("Direct", { userId: reader, permission: "read" }, reader);
  // The grant goes to the parent group: the reader reaches it through nested membership.
  await insertSpace("Group", { groupId: parentGroupId, permission: "write" }, reader);
  await insertSpace("Private", { userId: stranger, permission: "admin" }, reader);
  await insertSpace("Denied", { userId: reader, permission: "none" }, reader);
});

afterAll(async () => {
  setSystemTime();
  await database?.drop();
});

const suite = databaseSuite();

suite("overview reads across the reachable Spaces", () => {
  // With the grants checked per row, main spent 3 statements per view, 1 for the counts, 4 for the sidebar,
  // 1 for the activity and 7 for the overview page. The resolution adds one statement to a read on its own
  // and none to the page, whose sidebar listing is the resolution.
  test("pin the statements per overview path", async () => {
    const userId = reader;
    const subject = { type: "user" as const, userId };
    const meter = await meterSql();
    try {
      const count = async (run: () => Promise<unknown>) => {
        await run();
        return (await meter.during(run)).length;
      };
      for (const view of views) expect(await count(() => loadOverviewWork({ userId, view, dateConfig }))).toBe(4);
      expect(await count(() => loadOverviewCounts({ userId, dateConfig }))).toBe(2);
      expect(await count(() => loadSpacesSidebar({ userId, dateConfig }))).toBe(4);
      expect(await count(() => activity.list({ subject, limit: 30 }))).toBe(2);
      // The overview page: one resolution shared by work, sidebar and activity.
      const page = async () => {
        const spaces = loadReachableSpaces(userId);
        const spaceIds = (await spaces).map((space) => space.id);
        const work = await loadOverviewWork({ userId, view: "mine", dateConfig, spaceIds });
        await Promise.all([
          loadSpacesSidebar({ userId, dateConfig, spaces, myWorkCount: work.counts.mine }),
          activity.list({ subject, limit: 30, spaceIds }),
        ]);
      };
      expect(await count(page)).toBe(7);
    } finally {
      await meter.close();
    }
  });

  test("keep to direct and nested group grants, skip private and `none` Spaces, and empty on revocation", async () => {
    const subject = { type: "user" as const, userId: reader };
    expect((await loadReachableSpaces(reader)).map((space) => space.name)).toEqual(["Direct", "Group"]);
    expect(await loadOverviewCounts({ userId: reader, dateConfig })).toEqual({ mine: 4, today: 2, upcoming: 4 });
    const lists = { mine: 4, today: 2, upcoming: 4 };
    for (const view of views) {
      const work = await loadOverviewWork({ userId: reader, view, dateConfig });
      expect(work.counts).toEqual({ mine: 4, today: 2, upcoming: 4 });
      expect(work.items).toHaveLength(lists[view]);
      expect(new Set(work.items.map((item) => item.spaceName))).toEqual(new Set(["Direct", "Group"]));
      expect(work.items.every((item) => item.canWrite === (item.spaceName === "Group"))).toBe(true);
    }
    const sidebar = await loadSpacesSidebar({ userId: reader, dateConfig });
    expect(sidebar.spaces.map((space) => [space.name, space.openItemCount])).toEqual([
      ["Direct", 2],
      ["Group", 2],
    ]);
    expect(sidebar.myWorkCount).toBe(4);
    expect((await activity.list({ subject })).items.map((event) => event.space.name).sort()).toEqual(["Direct", "Group"]);

    await sql`DELETE FROM auth.access WHERE id = ${direct.accessId}::uuid`;
    await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${reader}::uuid`;
    expect(await loadReachableSpaces(reader)).toEqual([]);
    expect(await loadOverviewCounts({ userId: reader, dateConfig })).toEqual({ mine: 0, today: 0, upcoming: 0 });
    for (const view of views) expect((await loadOverviewWork({ userId: reader, view, dateConfig })).items).toEqual([]);
    expect(await loadSpacesSidebar({ userId: reader, dateConfig })).toMatchObject({ spaces: [], myWorkCount: 0 });
    expect((await activity.list({ subject })).items).toEqual([]);
  });

  test("a person without Spaces reads zero and empty lists", async () => {
    expect(await loadOverviewCounts({ userId: nobody, dateConfig })).toEqual({ mine: 0, today: 0, upcoming: 0 });
    for (const view of views) expect((await loadOverviewWork({ userId: nobody, view, dateConfig })).items).toEqual([]);
    expect(await loadSpacesSidebar({ userId: nobody, dateConfig })).toMatchObject({ spaces: [], myWorkCount: 0 });
    expect((await activity.list({ subject: { type: "user", userId: nobody } })).items).toEqual([]);
  });

  test("a Space-bound account reads activity only of its own Space, also when the caller names no binding", async () => {
    // Bound to "Direct", with grants on "Direct" and on a second Space: the binding, not the grants, limits its reach.
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('Reach bound account', 'resource_bound', 'spaces', 'space', ${direct.id}) RETURNING id`;
    const subject = { type: "service_account" as const, serviceAccountId: account!.id };
    const [other] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Bound other') RETURNING id`;
    await sql`INSERT INTO spaces.activity_events (space_id, actor_kind, actor_id, action, created_at, last_occurred_at)
      VALUES (${other!.id}::uuid, 'user', ${reader}::uuid, 'space.updated', '2026-11-27T10:00:00Z', '2026-11-27T10:00:00Z')`;
    for (const spaceId of [direct.id, other!.id]) {
      const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access (service_account_id, permission)
        VALUES (${account!.id}::uuid, 'read') RETURNING id`;
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${grant!.id}::uuid)`;
    }
    // A path that does not pass the binding (no getScopedSpaceAccess in front of it) reads nothing across Spaces.
    expect((await activity.list({ subject })).items).toEqual([]);
    // With its binding it reads its own Space alone.
    const bound = await activity.list({ subject, boundSpaceId: direct.id });
    expect(bound.items.length).toBeGreaterThan(0);
    expect(new Set(bound.items.map((entry) => entry.space.id))).toEqual(new Set([direct.id]));
  });
});
