import { expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { OverviewWorkSchema } from "../overview-contracts";
import { dashboardSnapshot } from "./items";
import { loadOverviewWork } from "./overview";

const [tables] = await sql<{ items: string | null }[]>`SELECT to_regclass('spaces.items')::text AS items`.catch(() => []);

test.skipIf(!tables?.items)("selected overview views preserve counts, filters and access revocation", async () => {
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
