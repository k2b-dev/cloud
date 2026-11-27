import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { loadVenueOverview, loadVenueSettings, loadVenueWorkspace } from "./page-data";
import type { VenueOverviewProps } from "./screens/VenueOverviewScreen";

/**
 * What each Venue page costs on the server: the statements of its one SSR load and the size of what its island
 * receives. The counts are pinned, so a new query per row or a second read of the same thing shows up here.
 */
suiteFor("database", "valkey")("Venue page loads", () => {
  let user: User, venueId: string, accessId: string;
  // someone at 105 venues with six shifts among people: the overview costs what it costs for one venue
  let busy: User,
    busyVenueIds: string[] = [],
    busyAccessId: string;
  const venue = newShortId();
  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`venue-page-${suffix}`}, 'local', 'user', 'Venue page member') RETURNING id`;
    user = {
      id: row!.id,
      uid: `venue-page-${suffix}`,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: "Venue",
      sn: "Page",
      displayName: "Venue page member",
      mail: null,
      avatarHash: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
      ipa: null,
    };
    const [place] = await sql<{ id: string }[]>`
      INSERT INTO venue.venues (short_id, slug, name) VALUES (${venue}, ${`page-cafe-${suffix}`}, 'Page café') RETURNING id`;
    venueId = place!.id;
    const [grant] = await sql<{ id: string }[]>`
      INSERT INTO auth.access (user_id, permission) VALUES (${user.id}::uuid, 'admin') RETURNING id`;
    accessId = grant!.id;
    await sql`INSERT INTO venue.venue_access (venue_id, access_id) VALUES (${venueId}::uuid, ${accessId}::uuid)`;
    // a week with two shifts on Wednesday, the person in one of them, three ratings and one public section
    const templates = await sql<{ id: string }[]>`
      INSERT INTO venue.shift_templates (short_id, venue_id, weekday, title, start_time, end_time, min_people)
      VALUES (${newShortId()}, ${venueId}::uuid, 3, 'Früh', '08:00', '12:00', 2),
             (${newShortId()}, ${venueId}::uuid, 3, 'Spät', '14:00', '18:00', 1)
      RETURNING id`;
    await sql`
      INSERT INTO venue.shift_assignments (short_id, venue_id, template_id, user_id, starts_at, ends_at)
      VALUES (${newShortId()}, ${venueId}::uuid, ${templates[0]!.id}::uuid, ${user.id}::uuid,
        '2026-11-25T07:00:00Z'::timestamptz, '2026-11-25T11:00:00Z'::timestamptz)`;
    for (const [rating, comment] of [
      [5, "Sehr gemütlich"],
      [2, null],
      [4, "Guter Kaffee"],
    ] as const)
      await sql`INSERT INTO venue.feedback_entries (venue_id, rating, comment, created_at)
        VALUES (${venueId}::uuid, ${rating}, ${comment}, '2026-11-24T15:00:00Z'::timestamptz)`;
    await sql`INSERT INTO venue.public_sections (short_id, venue_id, kind, title, content, position)
      VALUES (${newShortId()}, ${venueId}::uuid, 'markdown', 'Willkommen', '{"markdown":"Schön, dass du da bist."}'::jsonb, 0)`;

    const [busyRow] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`venue-page-busy-${suffix}`}, 'local', 'user', 'Venue page busy') RETURNING id`;
    busy = { ...user, id: busyRow!.id, uid: `venue-page-busy-${suffix}`, displayName: "Venue page busy" };
    const [busyGrant] = await sql<{ id: string }[]>`
      INSERT INTO auth.access (user_id, permission) VALUES (${busy.id}::uuid, 'write') RETURNING id`;
    busyAccessId = busyGrant!.id;
    // one grant shared by 105 venues, each with weekday hours; a closed day today at every tenth
    const busyVenues = await sql<{ id: string }[]>`
      INSERT INTO venue.venues (short_id, slug, name)
      SELECT substr(md5(${suffix} || n::text), 1, 6), ${`page-busy-${suffix}-`} || n, 'Ort ' || lpad(n::text, 3, '0')
      FROM generate_series(1, 105) AS n
      RETURNING id`;
    busyVenueIds = busyVenues.map((row) => row.id);
    await sql`INSERT INTO venue.venue_access (venue_id, access_id)
      SELECT unnest(${sql.array(busyVenueIds, "UUID")}::uuid[]), ${busyAccessId}::uuid`;
    await sql`INSERT INTO venue.opening_rules (short_id, venue_id, weekday, start_time, end_time)
      SELECT substr(md5(${suffix} || v::text || d::text), 1, 6), v, d, '08:00', '18:00'
      FROM unnest(${sql.array(busyVenueIds, "UUID")}::uuid[]) AS v, generate_series(1, 5) AS d`;
    await sql`INSERT INTO venue.date_overrides (short_id, venue_id, date, kind)
      SELECT substr(md5(${suffix} || v::text || 'closed'), 1, 6), v, CURRENT_DATE, 'closed'
      FROM unnest(${sql.array(
        busyVenueIds.filter((_, index) => index % 10 === 0),
        "UUID",
      )}::uuid[]) AS v`;
    // six shifts at three venues in the coming days, each with the member working along
    for (const [index, venueIndex] of [0, 0, 1, 1, 2, 2].entries())
      for (const who of [busy.id, user.id])
        await sql`
          INSERT INTO venue.shift_assignments (short_id, venue_id, user_id, starts_at, ends_at)
          VALUES (${newShortId()}, ${busyVenueIds[venueIndex]!}::uuid, ${who}::uuid,
            now() + ${`${index + 1} days`}::interval, now() + ${`${index + 1} days 3 hours`}::interval)`;
  });
  afterAll(async () => {
    if (venueId) await sql`DELETE FROM venue.venues WHERE id=${venueId}::uuid`;
    if (busyVenueIds.length) await sql`DELETE FROM venue.venues WHERE id = ANY(${sql.array(busyVenueIds, "UUID")}::uuid[])`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id=${accessId}::uuid`;
    if (busyAccessId) await sql`DELETE FROM auth.access WHERE id=${busyAccessId}::uuid`;
    if (busy) await sql`DELETE FROM auth.users WHERE id=${busy.id}::uuid`;
    if (user) await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
  });

  /**
   * Runs one loader inside a request for `path` as the member, counting its statements and its island's bytes. The
   * first request fills the caches a running Cloud keeps warm (settings, the calendar link); the second is measured,
   * as an ordinary page load costs.
   */
  const measure = async (pattern: string, path: string, loader: (c: Context<AuthContext>) => Promise<unknown>, member: User = user) => {
    let result: unknown;
    const load = () =>
      new Hono<AuthContext>()
        .use("*", async (c, next) => {
          c.set("actor", { kind: "user", user: member });
          c.set("accessSubject", { type: "user", userId: member.id });
          await next();
        })
        .get(pattern, async (c) => {
          result = await loader(c);
          return c.text("ok");
        })
        .request(`https://cloud.example.test${path}`);
    await load();
    const meter = await meterSql();
    try {
      const statements = await meter.during(async () => load());
      return { statements, bytes: JSON.stringify(result).length, result };
    } finally {
      await meter.close();
    }
  };

  test("each Venue page reads its first view in one load with a pinned number of statements", async () => {
    const week = "cv=week&cd=2026-11-25";
    const pages = {
      overview: await measure("/app/venue", "/app/venue", loadVenueOverview),
      busyOverview: await measure("/app/venue", "/app/venue", loadVenueOverview, busy),
      shifts: await measure("/app/venue/:id/:view", `/app/venue/${venue}/shifts?${week}`, loadVenueWorkspace),
      myShifts: await measure("/app/venue/:id/:view", `/app/venue/${venue}/my-shifts?${week}`, loadVenueWorkspace),
      feedback: await measure("/app/venue/:id/:view", `/app/venue/${venue}/feedback?${week}`, loadVenueWorkspace),
      public: await measure("/app/venue/:id/:view", `/app/venue/${venue}/public?${week}`, loadVenueWorkspace),
      settings: await measure("/app/venue/:id/settings", `/app/venue/${venue}/settings`, loadVenueSettings),
      access: await measure("/app/venue/:id/settings/:tab", `/app/venue/${venue}/settings/access`, loadVenueSettings),
    };
    // the statements of one load with warm caches (27.11.2026); a new read per row or a repeated read shows up here
    const pinned: Record<keyof typeof pages, number> = {
      overview: 4,
      busyOverview: 4,
      shifts: 22,
      myShifts: 22,
      feedback: 24,
      public: 29,
      settings: 16,
      access: 16,
    };
    for (const [name, page] of Object.entries(pages)) {
      expect({ name, kind: (page.result as { kind?: string } | undefined)?.kind }).toEqual({ name, kind: "ok" });
      if (page.statements.length !== pinned[name as keyof typeof pages])
        console.info(
          `venue page ${name} (${page.bytes} bytes):\n${page.statements.map((text, index) => `  ${index + 1}. ${text}`).join("\n")}`,
        );
      // what the island receives stays small: the first view, never whole lists
      expect(page.bytes).toBeLessThan(32_000);
    }
    expect(Object.fromEntries(Object.entries(pages).map(([name, page]) => [name, page.statements.length]))).toEqual(pinned);
    // the busy member sees a page of 50 venues with the way to the next, and all six shifts with who works along
    const busyProps = (pages.busyOverview.result as { props: VenueOverviewProps }).props;
    expect({ venues: busyProps.venues.length, more: busyProps.morePages, first: busyProps.venues[0]?.name }).toEqual({
      venues: 50,
      more: true,
      first: "Ort 001",
    });
    expect(busyProps.shifts.entries.map((shift) => shift.coworkers)).toEqual(
      Array.from({ length: 6 }, () => ({ names: ["Venue page member"], count: 1 })),
    );
    console.info(`venue overview: ${pages.overview.bytes} bytes for 1 venue, ${pages.busyOverview.bytes} bytes for 50 of 105 venues`);
  }, 60_000);
});
