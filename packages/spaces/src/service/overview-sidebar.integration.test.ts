import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { loadSpacesSidebar } from "./overview";

// A private database: the reader's count of reachable Spaces is exact only where no other file grants a Space to every
// signed-in person at the same time.
suiteFor("database")("the sidebar reads only what it shows (integration)", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
  beforeAll(async () => {
    database = await useMigratedDatabase("spaces_sidebar_bound");
  });
  afterAll(async () => {
    await database?.drop();
  });

  const user = async (name: string) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${crypto.randomUUID()}, 'local', 'user', ${name}) RETURNING id`;
    return row!.id;
  };
  const space = async (name: string) => {
    const shortId = newShortId();
    const [row] = await sql<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name) VALUES (${shortId}, ${name}) RETURNING id`;
    return { id: row!.id, shortId, name };
  };
  const grant = async (spaceId: string, userId: string, permission: "none" | "read" | "write") => {
    const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
      VALUES (${userId}::uuid, ${permission}::auth.permission_level) RETURNING id`;
    await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
  };
  const cookie = (settings: { pinnedSpaceIds: string[]; recentSpaceIds: string[] }) =>
    `settings-app-spaces=${encodeURIComponent(JSON.stringify({ version: 2, ...settings, spaces: {} }))}`;

  test("30 reachable Spaces: the pinned, recent and open ones beyond the first 20 come along, the rest is counted", async () => {
    const reader = await user("Sidebar reader fixture");
    const other = await user("Sidebar other fixture");
    // "Sidebar 01" … "Sidebar 30", granted to the reader; their names are their server order.
    const spaces = [];
    for (let n = 1; n <= 30; n++) {
      const entry = await space(`Sidebar ${String(n).padStart(2, "0")}`);
      await grant(entry.id, reader, n % 2 ? "read" : "write");
      spaces.push(entry);
    }
    // Two private Spaces that sort first: one only another person reaches, one where the reader's grant is `none`.
    const hidden = await space("Sidebar 00 hidden");
    await grant(hidden.id, other, "write");
    const denied = await space("Sidebar 00 denied");
    await grant(denied.id, reader, "none");
    // Open tasks of a pinned Space beyond the first 20: a done column's task and a finished one do not count.
    const pinnedLate = spaces[23]!;
    const [open, done] = await sql<{ id: string }[]>`INSERT INTO spaces.columns (short_id, space_id, name, is_done)
      VALUES (${newShortId()}, ${pinnedLate.id}::uuid, 'Open', false), (${newShortId()}, ${pinnedLate.id}::uuid, 'Done', true)
      RETURNING id`;
    await sql`INSERT INTO spaces.items (short_id, space_id, column_id, title, completed_at) VALUES
      (${newShortId()}, ${pinnedLate.id}::uuid, ${open!.id}::uuid, 'Open one', NULL),
      (${newShortId()}, ${pinnedLate.id}::uuid, ${open!.id}::uuid, 'Open two', NULL),
      (${newShortId()}, ${pinnedLate.id}::uuid, ${open!.id}::uuid, 'Finished', CURRENT_TIMESTAMP),
      (${newShortId()}, ${pinnedLate.id}::uuid, ${done!.id}::uuid, 'In done column', NULL)`;

    const pinned = [spaces[27]!.shortId, pinnedLate.shortId, hidden.shortId];
    const recent = [spaces[25]!.shortId, denied.shortId];
    const sidebar = await loadSpacesSidebar({
      userId: reader,
      cookieHeader: cookie({ pinnedSpaceIds: pinned, recentSpaceIds: recent }),
      openSpaceId: spaces[28]!.shortId,
      myWorkCount: 0,
    });
    // The first 20 by name, then the recent "Sidebar 26", the pinned "Sidebar 24" and "Sidebar 28", and the open
    // "Sidebar 29", in the server's order; a private Space is neither listed nor counted, even when the cookie names it.
    expect(sidebar.spaces.map((entry) => entry.name)).toEqual([
      ...spaces.slice(0, 20).map((entry) => entry.name),
      "Sidebar 24",
      "Sidebar 26",
      "Sidebar 28",
      "Sidebar 29",
    ]);
    expect(sidebar.spaces.map((entry) => entry.id)).not.toContain(hidden.shortId);
    expect(sidebar.spaces.map((entry) => entry.id)).not.toContain(denied.shortId);
    // "+6 more": 30 reachable, 24 listed.
    expect(sidebar.unlistedSpaceCount).toBe(6);
    expect(sidebar.spaces.find((entry) => entry.name === "Sidebar 24")).toEqual({
      id: pinnedLate.shortId,
      name: "Sidebar 24",
      color: expect.any(String),
      openItemCount: 2,
    });
    // The cookie's pins and recent Spaces reach the islands as they are; the sidebar orders them.
    expect(sidebar.pinnedSpaceIds).toEqual(pinned);
    expect(sidebar.recentSpaceIds).toEqual(recent);
    expect(JSON.parse(JSON.stringify(sidebar))).toEqual(sidebar);

    // The PWA's switcher reads every reachable Space, still without the private ones.
    const complete = await loadSpacesSidebar({
      userId: reader,
      cookieHeader: cookie({ pinnedSpaceIds: pinned, recentSpaceIds: [] }),
      myWorkCount: 0,
      complete: true,
    });
    expect(complete.spaces.map((entry) => entry.name)).toEqual(spaces.map((entry) => entry.name));
    expect(complete.unlistedSpaceCount).toBe(0);

    // Another person lists only their own Space, even when the reader's Space is named as open; one who reaches nothing
    // gets an empty sidebar and nothing to count.
    expect(await loadSpacesSidebar({ userId: other, myWorkCount: 0, openSpaceId: spaces[0]!.shortId })).toEqual({
      spaces: [{ id: hidden.shortId, name: hidden.name, color: expect.any(String), openItemCount: 0 }],
      unlistedSpaceCount: 0,
      pinnedSpaceIds: [],
      recentSpaceIds: [],
      myWorkCount: 0,
    });
    const nobody = await user("Sidebar nobody fixture");
    expect(await loadSpacesSidebar({ userId: nobody, myWorkCount: 0 })).toEqual({
      spaces: [],
      unlistedSpaceCount: 0,
      pinnedSpaceIds: [],
      recentSpaceIds: [],
      myWorkCount: 0,
    });
  });
});
