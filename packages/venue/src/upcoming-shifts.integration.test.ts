import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { databaseSuite, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";
import { newShortId } from "./lib/short-id";
import { venueService } from "./service";

// Wednesday 25 Nov 2026, 11:00 in Berlin
const NOW = new Date("2026-11-25T10:00:00.000Z");
const suite = databaseSuite();

suite("Venue overview reads", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
  let meId: string, otherId: string, thirdId: string;
  let cafe: { id: string; short: string }, bar: { id: string; short: string }, garden: { id: string; short: string };
  let hiddenId: string;
  beforeAll(async () => {
    database = await useMigratedDatabase("venue_upcoming_shifts");
    const users = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`next-me-${crypto.randomUUID()}`}, 'local', 'user', 'Next me'),
             (${`next-other-${crypto.randomUUID()}`}, 'local', 'user', 'Next other'),
             (${`next-third-${crypto.randomUUID()}`}, 'local', 'user', 'Next third')
      RETURNING id`;
    [meId, otherId, thirdId] = users.map((user) => user.id) as [string, string, string];
    const shorts = [newShortId(), newShortId(), newShortId(), newShortId()];
    const venues = await sql<{ id: string }[]>`
      INSERT INTO venue.venues (short_id, slug, name, open_mode)
      VALUES (${shorts[0]!}, ${`next-cafe-${crypto.randomUUID()}`}, 'Next café', 'combined'),
             (${shorts[1]!}, ${`next-bar-${crypto.randomUUID()}`}, 'Next bar', 'combined'),
             (${shorts[2]!}, ${`next-garden-${crypto.randomUUID()}`}, 'Next garden', 'regular'),
             (${shorts[3]!}, ${`next-hidden-${crypto.randomUUID()}`}, 'Next hidden', 'combined')
      RETURNING id`;
    cafe = { id: venues[0]!.id, short: shorts[0]! };
    bar = { id: venues[1]!.id, short: shorts[1]! };
    garden = { id: venues[2]!.id, short: shorts[2]! };
    hiddenId = venues[3]!.id;
    // the person works at the café, the bar and the garden; the hidden venue keeps their old sign-up without access
    for (const venueId of [cafe.id, bar.id, garden.id]) {
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access (user_id, permission) VALUES (${meId}::uuid, 'write') RETURNING id`;
      await sql`INSERT INTO venue.venue_access (venue_id, access_id) VALUES (${venueId}::uuid, ${grant!.id}::uuid)`;
    }
    const [template] = await sql<{ id: string }[]>`
      INSERT INTO venue.shift_templates (short_id, venue_id, weekday, title, start_time, end_time)
      VALUES (${newShortId()}, ${cafe.id}::uuid, 3, 'Inventur', '10:00', '13:00') RETURNING id`;
    // the café: one shift that ended, one running now (with someone else in the same slot), one tomorrow, free time
    // next week and one beyond the 14 days; the bar: free time that someone else overlaps; the hidden venue: one
    for (const [venueId, userId, templateId, startsAt, endsAt] of [
      [cafe.id, meId, template!.id, "2026-11-24T09:00:00Z", "2026-11-24T12:00:00Z"],
      [cafe.id, meId, template!.id, "2026-11-25T09:00:00Z", "2026-11-25T12:00:00Z"],
      [cafe.id, otherId, template!.id, "2026-11-25T09:00:00Z", "2026-11-25T12:00:00Z"],
      [cafe.id, meId, template!.id, "2026-11-26T13:00:00Z", "2026-11-26T16:00:00Z"],
      [cafe.id, meId, null, "2026-12-01T10:00:00Z", "2026-12-01T12:00:00Z"],
      [cafe.id, meId, null, "2026-12-15T10:00:00Z", "2026-12-15T12:00:00Z"],
      [bar.id, meId, null, "2026-11-27T19:00:00Z", "2026-11-27T23:00:00Z"],
      [bar.id, thirdId, null, "2026-11-27T20:00:00Z", "2026-11-27T22:00:00Z"],
      [hiddenId, meId, null, "2026-11-26T08:00:00Z", "2026-11-26T09:00:00Z"],
    ] as const)
      await sql`
        INSERT INTO venue.shift_assignments (short_id, venue_id, template_id, user_id, starts_at, ends_at)
        VALUES (${newShortId()}, ${venueId}::uuid, ${templateId}::uuid, ${userId}::uuid, ${startsAt}::timestamptz, ${endsAt}::timestamptz)`;
    // hours: the café opens Wednesdays 08:00–16:00, the bar is closed today, the garden opens Saturdays 10:00–12:00
    await sql`
      INSERT INTO venue.opening_rules (short_id, venue_id, weekday, start_time, end_time)
      VALUES (${newShortId()}, ${cafe.id}::uuid, 3, '08:00', '16:00'),
             (${newShortId()}, ${bar.id}::uuid, 3, '18:00', '23:00'),
             (${newShortId()}, ${garden.id}::uuid, 6, '10:00', '12:00')`;
    await sql`
      INSERT INTO venue.date_overrides (short_id, venue_id, date, kind)
      VALUES (${newShortId()}, ${bar.id}::uuid, '2026-11-25', 'closed')`;
  }, 60_000);
  afterAll(async () => {
    if (database) {
      await sql.close();
      await database.drop();
    }
  });

  test("one read lists the next shifts over every venue the person reaches, soonest first, with who works along", async () => {
    const next = await venueService.myUpcomingShifts({ id: meId }, NOW, { days: 14, limit: 12 });
    expect(next.entries.map((shift) => [shift.venue.id, shift.startsAt, shift.title, shift.coworkers])).toEqual([
      [cafe.short, "2026-11-25T09:00:00.000Z", "Inventur", { names: ["Next other"], count: 1 }],
      [cafe.short, "2026-11-26T13:00:00.000Z", "Inventur", { names: [], count: 0 }],
      [bar.short, "2026-11-27T19:00:00.000Z", null, { names: ["Next third"], count: 1 }],
      [cafe.short, "2026-12-01T10:00:00.000Z", null, { names: [], count: 0 }],
    ]);
    expect(next.entries[0]!.venue).toMatchObject({ name: "Next café", timezone: "Europe/Berlin" });
    expect({ total: next.total, venues: next.venues, next: next.next }).toEqual({ total: 4, venues: 2, next: null });
  });

  test("past the limit it counts the rest and names the venue of the next one", async () => {
    const next = await venueService.myUpcomingShifts({ id: meId }, NOW, { days: 14, limit: 2 });
    expect(next.entries).toHaveLength(2);
    expect({ total: next.total, venues: next.venues, next: next.next }).toEqual({
      total: 4,
      venues: 2,
      next: { venueId: bar.short, venueName: "Next bar" },
    });
    // someone without shifts there, or without access, sees nothing
    expect(await venueService.myUpcomingShifts({ id: otherId }, NOW, { days: 14, limit: 12 })).toEqual({
      entries: [],
      total: 0,
      venues: 0,
      next: null,
    });
  });

  test("one read tells how each venue stands now by its hours and exceptions", async () => {
    const venues = await venueService.venues.discover({ id: meId }, { limit: 10 });
    expect(venues.map((venue) => [venue.name, venue.permission])).toEqual([
      ["Next bar", "write"],
      ["Next café", "write"],
      ["Next garden", "write"],
    ]);
    const states = await venueService.openStates(venues, NOW);
    expect(states.get(cafe.id)).toEqual({ kind: "open", until: "2026-11-25T15:00:00.000Z" });
    expect(states.get(bar.id)).toEqual({ kind: "closed" });
    expect(states.get(garden.id)).toEqual({ kind: "opens", at: "2026-11-28T09:00:00.000Z" });
  });
});
