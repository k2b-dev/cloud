import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import api from ".";

type Listed = { id: string; name: string; permission?: string };

/**
 * The venue list is one bounded page, newest first: a person with many venues pages through them or searches by name
 * or slug, and a venue renamed between two pages is neither missed nor read twice.
 */
suiteFor(
  "database",
  "nats",
  "valkey",
)("Venue list pages", () => {
  const suffix = crypto.randomUUID();
  // oldest first; under the old order by name, renaming "Büro" to "Zelt" after the first page drops "Kühlhaus"
  const names = ["Kühlhaus", "Lager", "Halle", "Werkstatt", "Büro"];
  const venueIds: string[] = [];
  const shortIds: string[] = [];
  const userIds: string[] = [];
  let listerCookie = "";
  let singleCookie = "";

  const insertUser = async (label: string) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`venue-${label}-${suffix}`}, 'local', 'user', ${label}) RETURNING id`;
    userIds.push(row!.id);
    return row!.id;
  };
  const insertVenue = async (name: string, createdAt: string) => {
    const shortId = testShortId();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO venue.venues(short_id, slug, name, public_enabled, created_at, updated_at)
      VALUES (${shortId}, ${`${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${suffix}`}, ${`${name} ${suffix}`}, false,
        ${createdAt}::timestamptz, ${createdAt}::timestamptz)
      RETURNING id`;
    venueIds.push(row!.id);
    shortIds.push(shortId);
    return row!.id;
  };
  const grant = async (venueId: string, userId: string, permission: "read" | "write") => {
    const [access] = await sql<{ id: string }[]>`
      INSERT INTO auth.access(user_id, permission) VALUES (${userId}::uuid, ${permission}) RETURNING id`;
    await sql`INSERT INTO venue.venue_access(venue_id, access_id) VALUES (${venueId}::uuid, ${access!.id}::uuid)`;
  };

  beforeAll(async () => {
    const lister = await insertUser("Lister");
    const single = await insertUser("Single");
    for (const [index, name] of names.entries()) {
      const venueId = await insertVenue(name, `2026-01-0${index + 1}T08:00:00Z`);
      await grant(venueId, lister, "read");
    }
    // a second, higher grant on "Halle": the list answers the highest one
    await grant(venueIds[2]!, lister, "write");
    await grant(await insertVenue("Einzeln", "2026-01-06T08:00:00Z"), single, "read");
    listerCookie = `session_token=${await createTestSession(lister)}`;
    singleCookie = `session_token=${await createTestSession(single)}`;
  });
  afterAll(async () => {
    for (const id of venueIds) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM venue.venue_access WHERE venue_id = ${id}::uuid)`;
      await sql`DELETE FROM venue.venues WHERE id = ${id}::uuid`;
    }
    for (const id of userIds) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  const list = async (query: string, cookie = listerCookie) => {
    const response = await api.request(`/venues${query}`, { headers: { cookie, "x-forwarded-for": uniqueCallerAddress() } });
    const body: unknown = await response.json();
    return { status: response.status, body, venues: response.ok ? (body as { venues: Listed[] }).venues : [] };
  };
  // other test files may share venues with everyone signed in, so every read narrows to this file's venues
  const mine = `?q=${suffix}`;
  const label = (venue: Listed) => venue.name.replace(` ${suffix}`, "");

  test("the list pages newest first by limit and offset, with the highest grant of each venue", async () => {
    const first = await list(`${mine}&limit=2`);
    expect({ status: first.status, body: first.status === 200 ? null : first.body }).toEqual({ status: 200, body: null });
    const second = await list(`${mine}&limit=2&offset=2`);
    const last = await list(`${mine}&limit=2&offset=4`);
    expect([first, second, last].map((page) => page.venues.map(label))).toEqual([["Büro", "Werkstatt"], ["Halle", "Lager"], ["Kühlhaus"]]);
    expect([...first.venues, ...second.venues, ...last.venues].map((venue) => venue.id)).toEqual(shortIds.slice(0, 5).reverse());
    expect(second.venues.map((venue) => venue.permission)).toEqual(["write", "read"]);
    expect((await list(mine)).venues).toHaveLength(5);
  });

  test("q finds venues by name and by slug; a page above 100 or below 1 answers 400", async () => {
    expect((await list(`?q=${encodeURIComponent(`Lager ${suffix}`)}`)).venues.map(label)).toEqual(["Lager"]);
    expect((await list(`?q=werkstatt-${suffix}`)).venues.map(label)).toEqual(["Werkstatt"]);
    expect((await list(`${mine}&limit=101`)).status).toBe(400);
    expect((await list(`${mine}&limit=0`)).status).toBe(400);
    expect((await list(`?q=${"x".repeat(201)}`)).status).toBe(400);
  });

  test("listing 1 or 5 venues costs the same statements", async () => {
    // warm the session and public-ID caches outside the meter
    await list(mine, singleCookie);
    await list(mine);
    const meter = await meterSql();
    try {
      const single = await meter.during(() => list(mine, singleCookie));
      const five = await meter.during(() => list(mine));
      expect(five).toEqual(single);
      expect(five.filter((statement) => statement.startsWith("WITH granted AS"))).toHaveLength(1);
    } finally {
      await meter.close();
    }
  });

  test("a venue renamed between two pages is neither missed nor read twice", async () => {
    const first = await list(`${mine}&limit=2`);
    await sql`UPDATE venue.venues SET name = ${`Zelt ${suffix}`}, updated_at = '2026-02-01T08:00:00Z' WHERE id = ${venueIds[4]!}::uuid`;
    const second = await list(`${mine}&limit=2&offset=2`);
    const last = await list(`${mine}&limit=2&offset=4`);
    const ids = [...first.venues, ...second.venues, ...last.venues].map((venue) => venue.id);
    expect(ids).toEqual(shortIds.slice(0, 5).reverse());
  });
});

/**
 * The list reaches a venue through every kind of grant a single venue read honours: a group, a group nested in the
 * granted one, everyone signed in, and the public. A `none` grant never lists a venue and never outranks a `read`.
 */
suiteFor(
  "database",
  "nats",
  "valkey",
)("Venue list grants", () => {
  const suffix = crypto.randomUUID();
  const venueIds: string[] = [];
  const groupIds: string[] = [];
  let userId = "";
  let cookie = "";

  const insertVenue = async (name: string, createdAt: string) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO venue.venues(short_id, slug, name, public_enabled, created_at, updated_at)
      VALUES (${testShortId()}, ${`grant-${venueIds.length}-${suffix}`}, ${`${name} ${suffix}`}, false,
        ${createdAt}::timestamptz, ${createdAt}::timestamptz)
      RETURNING id`;
    venueIds.push(row!.id);
    return row!.id;
  };
  const insertGroup = async (label: string) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.groups(cn, name, provider) VALUES (${`local:venue-${label}-${suffix}`}, ${`venue-${label}-${suffix}`}, 'local')
      RETURNING id`;
    groupIds.push(row!.id);
    return row!.id;
  };
  type Principal = { user_id?: string; group_id?: string; authenticated_only?: boolean };
  const grant = async (venueId: string, principal: Principal, permission: "none" | "read" | "write") => {
    const [access] = await sql<{ id: string }[]>`
      INSERT INTO auth.access(user_id, group_id, authenticated_only, permission)
      VALUES (${principal.user_id ?? null}::uuid, ${principal.group_id ?? null}::uuid, ${principal.authenticated_only ?? false},
        ${permission}::auth.permission_level)
      RETURNING id`;
    await sql`INSERT INTO venue.venue_access(venue_id, access_id) VALUES (${venueId}::uuid, ${access!.id}::uuid)`;
  };

  beforeAll(async () => {
    const [person] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`venue-grantee-${suffix}`}, 'local', 'user', 'Grantee') RETURNING id`;
    userId = person!.id;
    const team = await insertGroup("team");
    const parent = await insertGroup("parent");
    const child = await insertGroup("child");
    await sql`INSERT INTO auth.user_groups_v2(user_id, group_id) VALUES (${userId}::uuid, ${team}::uuid), (${userId}::uuid, ${child}::uuid)`;
    await sql`INSERT INTO auth.group_groups_v2(parent_group_id, child_group_id) VALUES (${parent}::uuid, ${child}::uuid)`;

    await grant(await insertVenue("Gruppe", "2026-03-01T08:00:00Z"), { group_id: team }, "write");
    await grant(await insertVenue("Verschachtelt", "2026-03-02T08:00:00Z"), { group_id: parent }, "read");
    await grant(await insertVenue("Angemeldet", "2026-03-03T08:00:00Z"), { authenticated_only: true }, "read");
    await grant(await insertVenue("Öffentlich", "2026-03-04T08:00:00Z"), {}, "read");
    await grant(await insertVenue("Gesperrt", "2026-03-05T08:00:00Z"), { user_id: userId }, "none");
    const mixed = await insertVenue("Gemischt", "2026-03-06T08:00:00Z");
    await grant(mixed, { user_id: userId }, "none");
    await grant(mixed, { user_id: userId }, "read");
    cookie = `session_token=${await createTestSession(userId)}`;
  });
  afterAll(async () => {
    for (const id of venueIds) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM venue.venue_access WHERE venue_id = ${id}::uuid)`;
      await sql`DELETE FROM venue.venues WHERE id = ${id}::uuid`;
    }
    for (const id of groupIds) await sql`DELETE FROM auth.groups WHERE id = ${id}::uuid`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("group, nested-group, signed-in and public grants list a venue; a none grant neither lists one nor outranks read", async () => {
    const response = await api.request(`/venues?q=${suffix}`, { headers: { cookie, "x-forwarded-for": uniqueCallerAddress() } });
    expect(response.status).toBe(200);
    const { venues } = (await response.json()) as { venues: Listed[] };
    expect(venues.map((venue) => [venue.name.replace(` ${suffix}`, ""), venue.permission])).toEqual([
      ["Gemischt", "read"],
      ["Öffentlich", "read"],
      ["Angemeldet", "read"],
      ["Verschachtelt", "read"],
      ["Gruppe", "write"],
    ]);
  });
});
