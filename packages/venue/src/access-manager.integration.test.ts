import { afterEach, expect, test } from "bun:test";
import { sql } from "bun";
import { inLockOrder } from "../../../scripts/fixtures/lock-order";
import { databaseSuite } from "../../../scripts/fixtures/test-infra";
import { newShortId } from "./lib/short-id";
import { venueService } from "./service";

const suite = databaseSuite();
const created = { venues: [] as string[], users: [] as string[], serviceAccounts: [] as string[] };

afterEach(async () => {
  for (const venueId of created.venues.splice(0)) {
    await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM venue.venue_access WHERE venue_id = ${venueId}::uuid)`;
    await sql`DELETE FROM venue.venues WHERE id = ${venueId}::uuid`;
  }
  for (const id of created.serviceAccounts.splice(0)) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
  for (const id of created.users.splice(0)) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
});

const insertVenue = async (): Promise<string> => {
  const id = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);
  await sql`
    INSERT INTO venue.venues (id, short_id, slug, name, public_enabled)
    VALUES (${id}::uuid, ${newShortId()}, ${`manager-${suffix}`}, ${`Manager ${suffix}`}, false)
  `;
  created.venues.push(id);
  return id;
};

/** Binds an admin grant for a new person, or for a key bound to the venue; returns the grant and its principal. */
const bindAdmin = async (venueId: string, kind: "user" | "key"): Promise<{ access: string; id: string }> => {
  const suffix = crypto.randomUUID();
  const [principal] =
    kind === "user"
      ? await sql<{ id: string }[]>`
          INSERT INTO auth.users (uid, provider, profile, display_name) VALUES (${`venue-manager-${suffix}`}, 'local', 'user', 'Venue manager')
          RETURNING id`
      : await sql<{ id: string }[]>`
          INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
          VALUES ('Venue key', 'resource_bound', 'venue', 'venue', ${venueId}) RETURNING id`;
  (kind === "user" ? created.users : created.serviceAccounts).push(principal!.id);
  const [access] =
    kind === "user"
      ? await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission) VALUES (${principal!.id}::uuid, 'admin') RETURNING id`
      : await sql<{ id: string }[]>`
          INSERT INTO auth.access (service_account_id, permission) VALUES (${principal!.id}::uuid, 'admin') RETURNING id`;
  await sql`INSERT INTO venue.venue_access (venue_id, access_id) VALUES (${venueId}::uuid, ${access!.id}::uuid)`;
  return { access: access!.id, id: principal!.id };
};

/** Holds the venue row and the grants the changes write. */
const holdVenue = (venueId: string) => async (holder: typeof sql) => {
  await holder`SELECT id FROM venue.venues WHERE id = ${venueId}::uuid FOR UPDATE`;
  await holder`SELECT va.access_id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE va.venue_id = ${venueId}::uuid FOR UPDATE OF a`;
};

const expectLastManager = (result: { ok: boolean; error?: { code: string; status: number; message: string } }) => {
  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "LAST_MANAGER", status: 409 });
};

suite("Venue keeps a manager", () => {
  test("the last manager can neither be lowered nor removed, even next to a venue-bound key", async () => {
    const venueId = await insertVenue();
    const own = await bindAdmin(venueId, "user");
    await bindAdmin(venueId, "key");

    const lowered = await venueService.access.update(venueId, own.access, "write", own, "de");
    expectLastManager(lowered);
    expect(lowered.ok === false && lowered.error.message).toContain("„Admin“");
    expectLastManager(await venueService.access.revoke(venueId, own.access, own));

    const second = await bindAdmin(venueId, "user");
    expect((await venueService.access.update(venueId, own.access, "write", own)).ok).toBe(true);
    expectLastManager(await venueService.access.revoke(venueId, second.access, second));
  });

  test("of two managers removing themselves at once, exactly one succeeds", async () => {
    const venueId = await insertVenue();
    const first = await bindAdmin(venueId, "user");
    const second = await bindAdmin(venueId, "user");

    const results = await inLockOrder(holdVenue(venueId), [
      () => venueService.access.revoke(venueId, first.access, first),
      () => venueService.access.revoke(venueId, second.access, second),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expectLastManager(results.find((result) => !result.ok)!);
    expect((await venueService.access.list(venueId)).filter((entry) => entry.permission === "admin")).toHaveLength(1);
  });

  test("a manager lowered while their own change waits for the venue no longer passes", async () => {
    const venueId = await insertVenue();
    const [first, second, third] = [await bindAdmin(venueId, "user"), await bindAdmin(venueId, "user"), await bindAdmin(venueId, "user")];

    const [lowered, stale] = await inLockOrder(holdVenue(venueId), [
      () => venueService.access.update(venueId, second.access, "read", first),
      () => venueService.access.update(venueId, third.access, "read", second),
    ]);
    expect(lowered!.ok).toBe(true);
    expect(stale).toMatchObject({ ok: false, error: { status: 403 } });
    expect((await venueService.access.list(venueId)).find((entry) => entry.id === third.access)?.permission).toBe("admin");
  });
});
