import { expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import venueApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

const insertAccount = async (name: string, venueId?: string) => {
  const [row] = venueId
    ? await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${name}, 'resource_bound', 'venue', 'venue', ${venueId}) RETURNING id`
    : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES (${name}, 'agent') RETURNING id`;
  return { id: row!.id };
};

const grant = async (venueId: string, serviceAccountId: string, permission: "read" | "write" | "admin") => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (service_account_id, permission) VALUES (${serviceAccountId}::uuid, ${permission}) RETURNING id`;
  await sql`INSERT INTO venue.venue_access (venue_id, access_id) VALUES (${venueId}::uuid, ${access!.id}::uuid)`;
};

/** Calls the real Venue API with a service-account credential carrying the given scopes. */
const apiAs = async (account: { id: string }, scopes: string[]) => {
  const created = await serviceAccountCredentials.createApiToken({
    serviceAccountId: account.id,
    name: `test ${scopes.join(" ")}`,
    scopes,
  });
  if (!created.ok) throw new Error(created.error.message);
  const authorization = `Bearer ${created.data.token}`;
  return (path: string, init?: { method?: string; body?: unknown }) =>
    venueApi.request(path, {
      method: init?.method ?? "GET",
      headers: {
        authorization,
        "x-forwarded-for": uniqueCallerAddress(),
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
};

const listedIds = async (response: Response) =>
  ((await response.json()) as { venues: { id: string }[] }).venues.map((venue) => venue.id).sort();

suite("Venue REST access for standalone agents", () => {
  test("an agent uses only its direct grants within its scopes; resource-bound keys stay bound", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const venue = (label: string) => ({ id: crypto.randomUUID(), shortId: newShortId(), slug: `agent-${label}-${suffix}` });
    const managed = venue("managed");
    const readable = venue("readable");
    const other = venue("other");
    await sql`INSERT INTO venue.venues (id, short_id, slug, name, public_enabled) VALUES
      (${managed.id}::uuid, ${managed.shortId}, ${managed.slug}, ${`Managed ${suffix}`}, false),
      (${readable.id}::uuid, ${readable.shortId}, ${readable.slug}, ${`Readable ${suffix}`}, false),
      (${other.id}::uuid, ${other.shortId}, ${other.slug}, ${`Other ${suffix}`}, false)`;
    const accountIds: string[] = [];
    try {
      const agent = await insertAccount(`Venue agent ${suffix}`);
      const stranger = await insertAccount(`Venue stranger ${suffix}`);
      const bound = await insertAccount(`Venue bound ${suffix}`, readable.id);
      accountIds.push(agent.id, stranger.id, bound.id);
      await grant(managed.id, agent.id, "admin");
      await grant(readable.id, agent.id, "read");
      await grant(readable.id, bound.id, "read");
      await grant(other.id, bound.id, "read");

      // With grants, an agent lists and reads its venues like a person with the same grants.
      const call = await apiAs(agent, ["openid", "read", "write"]);
      const venues = await call("/venues");
      expect(venues.status).toBe(200);
      expect(await listedIds(venues)).toEqual([managed.shortId, readable.shortId].sort());
      expect((await call(`/venues/${readable.shortId}/dashboard`)).status).toBe(200);
      expect((await call(`/venues/${other.shortId}/dashboard`)).status).toBe(403);
      expect((await call(`/venues/${readable.shortId}/access`)).status).toBe(403);

      // Scopes cap the grant: managing a venue needs an `admin` grant and a token with the `admin` scope.
      const rename = { name: `Renamed ${suffix}`, slug: managed.slug, publicEnabled: false };
      expect((await call(`/venues/${managed.shortId}`, { method: "PATCH", body: rename })).status).toBe(403);
      const manager = await apiAs(agent, ["read", "write", "admin"]);
      const renamed = await manager(`/venues/${managed.shortId}`, { method: "PATCH", body: rename });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({ id: managed.shortId, name: `Renamed ${suffix}` });
      expect((await manager(`/venues/${readable.shortId}`, { method: "PATCH", body: { ...rename, slug: readable.slug } })).status).toBe(
        403,
      );
      const unscoped = await apiAs(agent, ["openid"]);
      expect((await unscoped("/venues")).status).toBe(403);
      expect((await unscoped(`/venues/${readable.shortId}/dashboard`)).status).toBe(403);

      // Without a grant an agent sees nothing and cannot act.
      const denied = await apiAs(stranger, ["read", "write", "admin"]);
      expect(await listedIds(await denied("/venues"))).toEqual([]);
      expect((await denied(`/venues/${readable.shortId}/dashboard`)).status).toBe(403);
      expect((await denied(`/venues/${managed.shortId}`, { method: "PATCH", body: rename })).status).toBe(403);

      // A resource-bound key keeps seeing only its bound venue, even with a grant elsewhere.
      const boundCall = await apiAs(bound, ["read"]);
      expect(await listedIds(await boundCall("/venues"))).toEqual([readable.shortId]);
      expect((await boundCall(`/venues/${readable.shortId}/dashboard`)).status).toBe(200);
      expect((await boundCall(`/venues/${other.shortId}/dashboard`)).status).toBe(403);
    } finally {
      await sql`DELETE FROM auth.access WHERE id IN (
        SELECT access_id FROM venue.venue_access WHERE venue_id IN (${managed.id}::uuid, ${readable.id}::uuid, ${other.id}::uuid))`;
      await sql`DELETE FROM venue.venues WHERE id IN (${managed.id}::uuid, ${readable.id}::uuid, ${other.id}::uuid)`;
      for (const id of accountIds) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      }
    }
  });
});
