import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { databaseSuite, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";
import { newShortId } from "./lib/short-id";
import { venueService } from "./service";

const NOW = new Date("2026-11-25T10:00:00.000Z");
const suite = databaseSuite();

suite("Venue next shifts per venue", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
  let meId: string, otherId: string, cafeId: string, barId: string, emptyId: string, templateId: string;
  beforeAll(async () => {
    database = await useMigratedDatabase("venue_next_shifts");
    const users = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`next-me-${crypto.randomUUID()}`}, 'local', 'user', 'Next me'),
             (${`next-other-${crypto.randomUUID()}`}, 'local', 'user', 'Next other')
      RETURNING id`;
    meId = users[0]!.id;
    otherId = users[1]!.id;
    const venues = await sql<{ id: string }[]>`
      INSERT INTO venue.venues (short_id, slug, name)
      VALUES (${newShortId()}, ${`next-cafe-${crypto.randomUUID()}`}, 'Next café'),
             (${newShortId()}, ${`next-bar-${crypto.randomUUID()}`}, 'Next bar'),
             (${newShortId()}, ${`next-empty-${crypto.randomUUID()}`}, 'Next empty')
      RETURNING id`;
    [cafeId, barId, emptyId] = venues.map((venue) => venue.id) as [string, string, string];
    const [template] = await sql<{ id: string }[]>`
      INSERT INTO venue.shift_templates (short_id, venue_id, weekday, title, start_time, end_time)
      VALUES (${newShortId()}, ${cafeId}::uuid, 3, 'Inventur', '14:00', '17:00') RETURNING id`;
    templateId = template!.id;
    // the café: one shift that ended, one running now, two later; someone else's earlier shift; the bar: free time
    for (const [venueId, userId, template, startsAt, endsAt] of [
      [cafeId, meId, templateId, "2026-11-24T13:00:00Z", "2026-11-24T16:00:00Z"],
      [cafeId, meId, templateId, "2026-11-25T09:00:00Z", "2026-11-25T12:00:00Z"],
      [cafeId, meId, templateId, "2026-11-26T13:00:00Z", "2026-11-26T16:00:00Z"],
      [cafeId, meId, null, "2026-12-01T10:00:00Z", "2026-12-01T12:00:00Z"],
      [cafeId, otherId, templateId, "2026-11-25T08:00:00Z", "2026-11-25T11:00:00Z"],
      [barId, meId, null, "2026-11-27T19:00:00Z", "2026-11-27T23:00:00Z"],
    ] as const)
      await sql`
        INSERT INTO venue.shift_assignments (short_id, venue_id, template_id, user_id, starts_at, ends_at)
        VALUES (${newShortId()}, ${venueId}::uuid, ${template}::uuid, ${userId}::uuid, ${startsAt}::timestamptz, ${endsAt}::timestamptz)`;
  }, 60_000);
  afterAll(async () => {
    if (database) {
      await sql.close();
      await database.drop();
    }
  });

  test("one read names each venue's next shift that has not ended, with the count from now on", async () => {
    const next = await venueService.myNextShifts([cafeId, barId, emptyId], { id: meId }, NOW);
    expect(next.get(cafeId)).toEqual({
      startsAt: "2026-11-25T09:00:00.000Z",
      endsAt: "2026-11-25T12:00:00.000Z",
      title: "Inventur",
      upcoming: 3,
    });
    expect(next.get(barId)).toEqual({ startsAt: "2026-11-27T19:00:00.000Z", endsAt: "2026-11-27T23:00:00.000Z", title: null, upcoming: 1 });
    expect(next.has(emptyId)).toBeFalse();
  });

  test("another person's shifts and venues outside the list stay out", async () => {
    const next = await venueService.myNextShifts([barId], { id: otherId }, NOW);
    expect(next.size).toBe(0);
    expect((await venueService.myNextShifts([barId], { id: meId }, NOW)).has(cafeId)).toBeFalse();
    expect((await venueService.myNextShifts([], { id: meId }, NOW)).size).toBe(0);
  });
});
