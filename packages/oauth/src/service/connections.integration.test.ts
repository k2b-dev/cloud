import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { CONNECTION_DAYS, figures, forClients } from "./connections";

// Connections are refresh token families. Invented clients and people; other suites may add families of their own at
// the same time, so the global figures are checked by what this suite adds, the per-client ones exactly.
databaseSuite()("OAuth connections for the admin page", () => {
  test("a page of clients reads its connections, people, days and last use in one statement", async () => {
    const tag = `conn_${crypto.randomUUID().slice(0, 8)}`;
    const people = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, display_name, provider, profile)
      VALUES (${`${tag}_ada`}, 'Ada Renz', 'local', 'user'), (${`${tag}_ben`}, 'Ben Okafor', 'local', 'user'), (${`${tag}_cem`}, '', 'local', 'user')
      RETURNING id, uid
    `;
    const [ada, ben, cem] = people;
    const clients = await sql<{ client_id: string }[]>`
      INSERT INTO oauth.clients (name, redirect_uris, scopes, created_at)
      VALUES
        (${`${tag} busy`}, ARRAY['https://busy.example/cb'], ARRAY['openid', 'offline_access'], now() - interval '90 days'),
        (${`${tag} stale`}, ARRAY['https://stale.example/cb'], ARRAY['openid', 'offline_access'], now() - interval '90 days'),
        (${`${tag} none`}, ARRAY['https://none.example/cb'], ARRAY['openid'], now() - interval '90 days')
      RETURNING client_id
    `;
    const [busy, stale, none] = clients.map((client) => client.client_id);
    try {
      const before = await figures();
      await sql`
        INSERT INTO oauth.refresh_token_families (client_id, user_id, scopes, status, expires_at, created_at, last_used_at)
        VALUES
          (${busy!}, ${ada!.id}::uuid, ARRAY['offline_access'], 'active', now() + interval '30 days', now(), now()),
          (${busy!}, ${ada!.id}::uuid, ARRAY['offline_access'], 'active', now() + interval '30 days', now() - interval '2 days', now() - interval '1 hour'),
          (${busy!}, ${ben!.id}::uuid, ARRAY['offline_access'], 'active', now() + interval '30 days', now() - interval '2 days', now() - interval '3 hours'),
          (${busy!}, ${cem!.id}::uuid, ARRAY['offline_access'], 'revoked', now() + interval '30 days', now(), NULL),
          (${busy!}, ${cem!.id}::uuid, ARRAY['offline_access'], 'reserved', now() + interval '30 days', now(), NULL),
          (${stale!}, ${ben!.id}::uuid, ARRAY['offline_access'], 'active', now() + interval '30 days', now() - interval '40 days', now() - interval '35 days')
      `;
      const meter = await meterSql();
      try {
        let page: Awaited<ReturnType<typeof forClients>> = {};
        expect(await meter.during(async () => (page = await forClients([busy!, stale!, none!])))).toHaveLength(1);
        // active and not expired; a revoked one is no connection, a reservation is none yet
        expect(page[busy!]).toMatchObject({ active: 3, peopleCount: 2, people: [{ name: "Ada Renz" }, { name: "Ben Okafor" }] });
        expect(page[busy!]!.perDay).toHaveLength(CONNECTION_DAYS);
        // made today: two (one of them revoked since); two days ago: two
        expect(page[busy!]!.perDay.at(-1)).toBe(2);
        expect(page[busy!]!.perDay.at(-3)).toBe(2);
        expect(page[stale!]).toMatchObject({ active: 1, peopleCount: 1 });
        expect(page[none!]).toMatchObject({ active: 0, peopleCount: 0, people: [], lastUsedAt: null });
        expect(page[none!]!.perDay.every((count) => count === 0)).toBe(true);

        let after: Awaited<ReturnType<typeof figures>> | null = null;
        expect(await meter.during(async () => (after = await figures()))).toHaveLength(2);
        expect(after!.perDay).toHaveLength(CONNECTION_DAYS);
        expect(after!.active - before.active).toBeGreaterThanOrEqual(4);
        expect(after!.perDay.at(-1)! - before.perDay.at(-1)!).toBeGreaterThanOrEqual(2);
        expect(after!.newLast7 - before.newLast7).toBeGreaterThanOrEqual(4);
      } finally {
        await meter.close();
      }
      // the stale client was last used 35 days ago: unused, while the busy one was used today
      const lastUse = await forClients([busy!, stale!]);
      expect(Date.now() - Date.parse(lastUse[stale!]!.lastUsedAt!)).toBeGreaterThan(30 * 24 * 60 * 60 * 1000);
      expect(Date.now() - Date.parse(lastUse[busy!]!.lastUsedAt!)).toBeLessThan(60 * 60 * 1000);
      // the global list holds it unless older unused clients of other suites fill its three places
      expect((await figures()).unused.count).toBeGreaterThanOrEqual(1);
    } finally {
      await sql`DELETE FROM oauth.clients WHERE client_id = ANY(ARRAY[${busy!}, ${stale!}, ${none!}]::text[])`;
      await sql`DELETE FROM auth.users WHERE uid LIKE ${`${tag}_%`}`;
    }
  });
});
