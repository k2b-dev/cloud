import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { loadVenueOverview, loadVenueSettings, loadVenueWorkspace } from "./page-data";

/**
 * What each Venue page costs on the server: the statements of its one SSR load and the size of what its island
 * receives. The counts are pinned, so a new query per row or a second read of the same thing shows up here.
 */
suiteFor("database", "valkey")("Venue page loads", () => {
  let user: User, venueId: string, accessId: string;
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
  });
  afterAll(async () => {
    if (venueId) await sql`DELETE FROM venue.venues WHERE id=${venueId}::uuid`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id=${accessId}::uuid`;
    if (user) await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
  });

  /**
   * Runs one loader inside a request for `path` as the member, counting its statements and its island's bytes. The
   * first request fills the caches a running Cloud keeps warm (settings, the calendar link); the second is measured,
   * as an ordinary page load costs.
   */
  const measure = async (pattern: string, path: string, loader: (c: Context<AuthContext>) => Promise<unknown>) => {
    let result: unknown;
    const load = () =>
      new Hono<AuthContext>()
        .use("*", async (c, next) => {
          c.set("actor", { kind: "user", user });
          c.set("accessSubject", { type: "user", userId: user.id });
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
      shifts: await measure("/app/venue/:id/:view", `/app/venue/${venue}/shifts?${week}`, loadVenueWorkspace),
      myShifts: await measure("/app/venue/:id/:view", `/app/venue/${venue}/my-shifts?${week}`, loadVenueWorkspace),
      feedback: await measure("/app/venue/:id/:view", `/app/venue/${venue}/feedback?${week}`, loadVenueWorkspace),
      public: await measure("/app/venue/:id/:view", `/app/venue/${venue}/public?${week}`, loadVenueWorkspace),
      settings: await measure("/app/venue/:id/settings", `/app/venue/${venue}/settings`, loadVenueSettings),
      access: await measure("/app/venue/:id/settings/:tab", `/app/venue/${venue}/settings/access`, loadVenueSettings),
    };
    // the statements of one load with warm caches (27.11.2026); a new read per row or a repeated read shows up here
    const pinned: Record<keyof typeof pages, number> = {
      overview: 5,
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
  }, 60_000);
});
