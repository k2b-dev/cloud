import { expect } from "bun:test";
import { sql } from "bun";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { OverviewWorkSchema } from "../overview-contracts";
import { dashboardSnapshot } from "./items";
import { loadOverviewWork, loadSpaceOverviewStats, loadSpacesSidebar } from "./overview";

testFor("database")("selected overview views preserve counts, filters and access revocation", async () => {
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
    VALUES (${crypto.randomUUID()}, 'local', 'user', 'Overview test fixture') RETURNING id`;
  const spaceIds: string[] = [];
  let accessId: string | undefined;
  try {
    for (const name of ["Accessible overview fixture", "Private overview fixture"]) {
      const [space] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name)
        VALUES (${newShortId()}, ${name}) RETURNING id`;
      spaceIds.push(space!.id);
      const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'Open') RETURNING id`;
      const rows = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title, deadline)
        VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Today fixture', CURRENT_TIMESTAMP),
        (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Upcoming fixture', CURRENT_TIMESTAMP + INTERVAL '3 days') RETURNING id`;
      await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${rows[0]!.id}::uuid, ${user!.id}::uuid)`;
    }
    const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
      VALUES (${user!.id}::uuid, 'read') RETURNING id`;
    accessId = access!.id;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceIds[0]!}::uuid, ${accessId}::uuid)`;
    const params = { userId: user!.id, dateConfig: { locale: "en", timeZone: "UTC" } };
    const full = await dashboardSnapshot({ ...params, todoLimit: 30 });
    for (const view of ["mine", "today", "upcoming"] as const) {
      const selected = await loadOverviewWork({ ...params, view });
      expect(OverviewWorkSchema.safeParse(selected).success).toBe(true);
      expect(selected.items.filter((item) => item.spaceName === "Private overview fixture")).toEqual([]);
      expect(selected.counts).toEqual({ mine: full.assignedToMeCount, today: full.todayCount, upcoming: full.upcomingCount });
      if (view !== "mine")
        expect(selected.items.map((item) => item.shortId)).toEqual(
          (view === "today" ? full.events : full.todos).map((item) => item.shortId),
        );
      expect(selected.items.some((item) => item.spaceName === "Accessible overview fixture")).toBe(true);
    }
    const sidebar = await loadSpacesSidebar({
      ...params,
      cookieHeader: `settings-app-spaces=${encodeURIComponent(JSON.stringify({ version: 2, pinnedSpaceIds: ["Pin001"], spaces: {} }))}`,
      myWorkCount: 7,
    });
    const accessibleSidebar = sidebar.spaces.find((space) => space.name === "Accessible overview fixture");
    expect(accessibleSidebar).toBeDefined();
    expect(Object.keys(accessibleSidebar!).sort()).toEqual(["color", "description", "id", "name", "openItemCount"]);
    expect(accessibleSidebar?.openItemCount).toBe(2);
    expect(accessibleSidebar?.id).not.toBe(spaceIds[0]);
    expect(sidebar.spaces.some((space) => space.name === "Private overview fixture")).toBe(false);
    expect(sidebar.pinnedSpaceIds).toEqual(["Pin001"]);
    expect(sidebar.myWorkCount).toBe(7);
    expect((await loadSpacesSidebar(params)).myWorkCount).toBe(full.assignedToMeCount);
    await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    for (const view of ["mine", "today", "upcoming"] as const) {
      const selected = await loadOverviewWork({ ...params, view });
      expect(selected.items.some((item) => item.spaceName.endsWith("overview fixture"))).toBe(false);
    }
  } finally {
    for (const id of spaceIds) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
  }
});

// The overview passes every listed Space at once; binding the ids as a
// comma-joined string would fail as soon as there are two Spaces.
testFor("database")("computes sidebar stats for several Spaces in one query", async () => {
  const spaceIds: string[] = [];
  try {
    for (const name of ["Busy stats fixture", "Quiet stats fixture"]) {
      const [space] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name, updated_at)
        VALUES (${newShortId()}, ${name}, '2026-01-01T10:00:00Z') RETURNING id`;
      spaceIds.push(space!.id);
    }
    const [busy, quiet] = spaceIds as [string, string];
    const [open, done] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, is_done)
      VALUES (${newShortId()}, ${busy}::uuid, 'Open', false), (${newShortId()}, ${busy}::uuid, 'Done', true) RETURNING id`;
    await sql`INSERT INTO spaces.items (short_id, space_id, column_id, title, completed_at)
      VALUES
        (${newShortId()}, ${busy}::uuid, ${open!.id}::uuid, 'Open one', NULL),
        (${newShortId()}, ${busy}::uuid, ${open!.id}::uuid, 'Open two', NULL),
        (${newShortId()}, ${busy}::uuid, ${open!.id}::uuid, 'Completed', CURRENT_TIMESTAMP),
        (${newShortId()}, ${busy}::uuid, ${done!.id}::uuid, 'In done column', NULL)`;

    const byId = new Map((await loadSpaceOverviewStats({ spaceIds })).map((stats) => [stats.spaceId, stats]));
    expect(byId.size).toBe(2);
    expect(byId.get(busy)).toEqual({ spaceId: busy, openItemCount: 2 });
    expect(byId.get(quiet)).toEqual({ spaceId: quiet, openItemCount: 0 });
    expect(await loadSpaceOverviewStats({ spaceIds: [] })).toEqual([]);
  } finally {
    for (const id of spaceIds) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
  }
});
