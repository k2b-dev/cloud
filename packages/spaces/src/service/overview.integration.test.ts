import { expect } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { OverviewWorkSchema } from "../overview-contracts";
import { dashboardSnapshot } from "./items";
import { loadOverviewCounts, loadOverviewWork, loadSpaceOverviewStats, loadSpacePulse, loadSpacesSidebar } from "./overview";

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
        (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Upcoming fixture', CURRENT_TIMESTAMP + INTERVAL '3 days'),
        (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Overdue fixture', CURRENT_TIMESTAMP - INTERVAL '3 days') RETURNING id`;
      await sql`INSERT INTO spaces.item_assignees (item_id, user_id)
        VALUES (${rows[0]!.id}::uuid, ${user!.id}::uuid), (${rows[2]!.id}::uuid, ${user!.id}::uuid)`;
      // A task of the reader finished just now, and one nobody finished for them: the trend counts the first only.
      const done = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title, completed_at)
        VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Done fixture', CURRENT_TIMESTAMP),
        (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Done by others fixture', CURRENT_TIMESTAMP) RETURNING id`;
      await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${done[0]!.id}::uuid, ${user!.id}::uuid)`;
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
      // Only a caller that asks for the day gets it (the PWA's "My work" does not); then every view carries the same day:
      // today's agenda as the Today view reads it, and the overdue tasks of the reader, both without the private Space.
      expect(selected.day).toBeUndefined();
      const withDay = await loadOverviewWork({ ...params, view, day: { now: new Date() } });
      expect(withDay.items).toEqual(selected.items);
      expect(withDay.day?.agenda.map((item) => item.shortId)).toEqual(full.events.map((item) => item.shortId));
      expect(withDay.day?.agenda.some((item) => item.spaceName === "Accessible overview fixture")).toBe(true);
      expect(withDay.day?.agenda.some((item) => item.spaceName === "Private overview fixture")).toBe(false);
      expect(withDay.day?.overdue).toBe(1);
      // Done per day: 14 days, today last, plain numbers as the contract says (a typed array would reach JSON as an
      // object); the private Space's finished task never counts.
      expect(OverviewWorkSchema.safeParse(JSON.parse(JSON.stringify(withDay))).success).toBe(true);
      expect(withDay.day?.done).toEqual([...Array(13).fill(0), 1]);
      expect(selected.items.some((item) => item.spaceName === "Accessible overview fixture")).toBe(true);
    }
    // A Space's pulse keeps the overview's access condition: its own work for the reachable Space, nothing for the
    // private one, however much is done or open there.
    expect(await loadSpacePulse({ ...params, spaceId: spaceIds[0]! })).toEqual({
      done: [...Array(13).fill(0), 2],
      overdue: 1,
      unassigned: 1,
    });
    expect(await loadSpacePulse({ ...params, spaceId: spaceIds[1]! })).toEqual({ done: Array(14).fill(0), overdue: 0, unassigned: 0 });
    // The Cloud app's summary counts the same work without loading any list.
    expect(await loadOverviewCounts(params)).toEqual({
      mine: full.assignedToMeCount,
      today: full.todayCount,
      upcoming: full.upcomingCount,
    });
    const sidebar = await loadSpacesSidebar({
      ...params,
      cookieHeader: `settings-app-spaces=${encodeURIComponent(JSON.stringify({ version: 2, pinnedSpaceIds: ["Pin001"], spaces: {} }))}`,
      myWorkCount: 7,
    });
    const accessibleSidebar = sidebar.spaces.find((space) => space.name === "Accessible overview fixture");
    expect(accessibleSidebar).toBeDefined();
    expect(Object.keys(accessibleSidebar!).sort()).toEqual(["color", "description", "id", "name", "openItemCount"]);
    expect(accessibleSidebar?.openItemCount).toBe(3); // today, upcoming and overdue
    expect(accessibleSidebar?.id).not.toBe(spaceIds[0]);
    expect(sidebar.spaces.some((space) => space.name === "Private overview fixture")).toBe(false);
    expect(sidebar.pinnedSpaceIds).toEqual(["Pin001"]);
    expect(sidebar.myWorkCount).toBe(7);
    expect((await loadSpacesSidebar(params)).myWorkCount).toBe(full.assignedToMeCount);
    await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    for (const view of ["mine", "today", "upcoming"] as const) {
      const selected = await loadOverviewWork({ ...params, view, day: { now: new Date() } });
      expect(selected.items.some((item) => item.spaceName.endsWith("overview fixture"))).toBe(false);
      // A revoked grant takes the day with it: no agenda, nothing next, nothing overdue.
      expect(selected.day).toEqual({ at: expect.any(String), agenda: [], next: null, overdue: 0, done: Array(14).fill(0) });
    }
  } finally {
    for (const id of spaceIds) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
  }
});

// The agenda holds today's first five entries; the next entry is read on its own, so five earlier ones never hide it.
testFor("database")("the day finds the next entry behind five earlier ones, only in the reader's Spaces", async () => {
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
    VALUES (${crypto.randomUUID()}, 'local', 'user', 'Overview next fixture') RETURNING id`;
  const spaceIds: string[] = [];
  const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
    VALUES (${user!.id}::uuid, 'read') RETURNING id`;
  try {
    // Hours of today in UTC, the reader's zone here; the day's moment is noon, so every entry stays inside today.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const at = (hours: number) => new Date(today.getTime() + hours * 3_600_000).toISOString();
    for (const name of ["Next fixture", "Private next fixture"]) {
      const [space] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name)
        VALUES (${newShortId()}, ${name}) RETURNING id`;
      spaceIds.push(space!.id);
      const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'Open') RETURNING id`;
      const entries = name === "Next fixture" ? [1, 2, 3, 4, 5, 15] : [13];
      for (const hour of entries)
        await sql`INSERT INTO spaces.items (short_id, space_id, column_id, title, starts_at, ends_at)
          VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, ${`${name} ${hour}h`}, ${at(hour)}::timestamptz,
            ${at(hour + 0.5)}::timestamptz)`;
    }
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceIds[0]!}::uuid, ${access!.id}::uuid)`;
    const work = await loadOverviewWork({
      userId: user!.id,
      view: "mine",
      dateConfig: { locale: "en", timeZone: "UTC" },
      day: { now: new Date(at(12)) },
    });
    expect(work.day?.agenda.map((item) => item.title)).toEqual([1, 2, 3, 4, 5].map((hour) => `Next fixture ${hour}h`));
    // The private Space's 13:00 comes earlier, but the reader may not see it.
    expect(work.day?.next?.title).toBe("Next fixture 15h");
    expect(work.day?.at).toBe(at(12));
    expect(work.day?.next?.startsAt && Date.parse(work.day.next.startsAt)).toBe(Date.parse(at(15)));
  } finally {
    for (const id of spaceIds) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
    await sql`DELETE FROM auth.access WHERE id = ${access!.id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
  }
});

// Each overview view costs a known number of statements: the PWA loads "My work" on every page and never shows the
// day's agenda, so only a caller that asks for the day pays for its reads.
testFor("database")("each overview view reads a pinned number of statements", async () => {
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
    VALUES (${crypto.randomUUID()}, 'local', 'user', 'Overview meter fixture') RETURNING id`;
  const [space] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name)
    VALUES (${newShortId()}, 'Metered overview fixture') RETURNING id`;
  const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
    VALUES (${user!.id}::uuid, 'write') RETURNING id`;
  const meter = await meterSql();
  try {
    const [column] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name)
      VALUES (${newShortId()}, ${space!.id}::uuid, 'Open') RETURNING id`;
    const [item] = await sql<{ id: string }[]>`INSERT INTO spaces.items (short_id, space_id, column_id, title, deadline)
      VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Metered fixture', CURRENT_TIMESTAMP) RETURNING id`;
    await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${item!.id}::uuid, ${user!.id}::uuid)`;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space!.id}::uuid, ${access!.id}::uuid)`;
    const params = { userId: user!.id, dateConfig: { locale: "en", timeZone: "UTC" } };
    const cost: Record<string, number> = {};
    for (const view of ["mine", "today", "upcoming"] as const) {
      cost[view] = (await meter.during(() => loadOverviewWork({ ...params, view }))).length;
      const day = { now: new Date() };
      cost[`${view} with day`] = (await meter.during(() => loadOverviewWork({ ...params, view, day }))).length;
    }
    // Without the day: the counts, the view's list and the writable Spaces. The day adds the next entry, and today's
    // agenda where the view does not read it already.
    // The trend of done tasks rides the counts statement, so the day costs what it did before it carried a trend.
    expect(cost).toEqual({ mine: 3, "mine with day": 5, today: 3, "today with day": 4, upcoming: 3, "upcoming with day": 5 });
    // A Space's pulse is that one aggregate statement, limited to the Space.
    expect((await meter.during(() => loadSpacePulse({ ...params, spaceId: space!.id }))).length).toBe(1);
  } finally {
    await meter.close();
    await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
    await sql`DELETE FROM auth.access WHERE id = ${access!.id}::uuid`;
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
