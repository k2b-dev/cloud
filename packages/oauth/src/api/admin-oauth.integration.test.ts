import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { toPgUuidArray } from "@k2b/cloud/services";
import { z } from "zod";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { oauth } from "../service/oauth";
import routes from "./index";

suiteFor(
  "database",
  "nats",
  "valkey",
)("oauth administrator OAuth ceiling", () => {
  test("every admin mutation rejects a real read-only administrator token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders);
    }));
  test("read-only OAuth cannot rotate a secret; write/admin OAuth and browser sessions can", () =>
    withAdminOAuth(async ({ readHeaders, writeHeaders, adminHeaders, sessionHeaders }) => {
      const [client] = await sql<{ id: string }[]>`
        INSERT INTO oauth.clients (name,client_id,redirect_uris,is_public,registration_kind,client_secret_hash)
        VALUES ('Scope fixture',${`scope-${crypto.randomUUID()}`},ARRAY[]::text[],false,'managed',${await Bun.password.hash("fixture")})
        RETURNING id
      `;
      const hash = async () => {
        const [row] = await sql<
          { client_secret_hash: string }[]
        >`SELECT client_secret_hash FROM oauth.clients WHERE id=${client!.id}::uuid`;
        return row!.client_secret_hash;
      };
      try {
        for (const headers of [writeHeaders, adminHeaders, sessionHeaders]) {
          const before = await hash();
          expect((await routes.request(`/${client!.id}/regenerate-secret`, { method: "POST", headers: readHeaders })).status).toBe(403);
          expect(await hash()).toBe(before);
          const response = await routes.request(`/${client!.id}/regenerate-secret`, { method: "POST", headers });
          expect(response.status).toBe(200);
          const { clientSecret } = z.object({ clientSecret: z.string() }).parse(await response.json());
          expect(await hash()).not.toBe(before);
          expect(await Bun.password.verify(clientSecret, await hash())).toBe(true);
        }
      } finally {
        await sql`DELETE FROM oauth.clients WHERE id=${client!.id}::uuid`;
      }
    }));

  test("an administrator disconnects one person, then everyone; a revoked refresh token no longer refreshes", () =>
    withAdminOAuth(async ({ userId, writeHeaders, sessionHeaders }) => {
      const fixture = await connectedClient();
      try {
        const [ada, ben] = fixture.people;
        // sign-ins still on their way: Ben's unexchanged code and an open device sign-in end with everyone's connections
        await sql`
          INSERT INTO oauth.codes (client_id, user_id, redirect_uri, audiences)
          VALUES (${fixture.clientId}, ${ben!.userId}::uuid, 'https://client.example.test/callback', ARRAY['cloud']::text[])
        `;
        await sql`
          INSERT INTO oauth.device_authorizations (device_code_hash, user_code_hash, client_id, scopes, audiences, expires_at)
          VALUES (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${fixture.clientId}, ARRAY['offline_access']::text[], ARRAY['cloud']::text[],
            now() + INTERVAL '10 minutes')
        `;
        const open = async () => {
          const [row] = await sql<{ codes: number; devices: number }[]>`
            SELECT (SELECT count(*)::int FROM oauth.codes WHERE client_id = ${fixture.clientId} AND expires_at > now()) AS codes,
              (SELECT count(*)::int FROM oauth.device_authorizations WHERE client_id = ${fixture.clientId} AND expires_at > now()) AS devices
          `;
          return row;
        };
        expect(await open()).toEqual({ codes: 1, devices: 1 });

        const one = await routes.request(`/${fixture.id}/connections/${ada!.userId}`, { method: "DELETE", headers: writeHeaders });
        expect(one.status).toBe(200);
        expect(z.object({ revoked: z.number() }).parse(await one.json())).toEqual({ revoked: 1 });
        expect(await familyStates(fixture.clientId)).toEqual({ [ada!.userId]: "revoked", [ben!.userId]: "active" });
        // the revoked refresh token is refused; Ben's family and his sign-ins on their way stay untouched
        expect(await oauth.refreshTokens.rotate(ada!.refreshToken, fixture.client)).toEqual({ ok: false, error: "invalid_grant" });
        expect(await open()).toEqual({ codes: 1, devices: 1 });

        const all = await routes.request(`/${fixture.id}/connections`, { method: "DELETE", headers: sessionHeaders });
        expect(all.status).toBe(200);
        expect(z.object({ revoked: z.number() }).parse(await all.json())).toEqual({ revoked: 1 });
        expect(await familyStates(fixture.clientId)).toEqual({ [ada!.userId]: "revoked", [ben!.userId]: "revoked" });
        expect(await oauth.refreshTokens.rotate(ben!.refreshToken, fixture.client)).toEqual({ ok: false, error: "invalid_grant" });
        expect(await open()).toEqual({ codes: 0, devices: 0 });
        // ended for good: a token exchange whose transaction began long before the disconnect sees them expired too
        const [earlier] = await sql<{ codes: number; devices: number }[]>`
          SELECT (SELECT count(*)::int FROM oauth.codes WHERE client_id = ${fixture.clientId} AND expires_at >= now() - INTERVAL '1 day') AS codes,
            (SELECT count(*)::int FROM oauth.device_authorizations
              WHERE client_id = ${fixture.clientId} AND expires_at > now() - INTERVAL '1 day') AS devices
        `;
        expect(earlier).toEqual({ codes: 0, devices: 0 });

        // one audit entry per revoke: who, which client, which person or all
        const events = await sql<
          { actor_user_id: string; target_id: string; metadata: { userId: string | null; all: boolean; revoked: number } }[]
        >`
          SELECT actor_user_id, target_id, metadata FROM audit.events
          WHERE action = 'oauth.client.connections_revoke' AND target_id = ${fixture.id}
          ORDER BY created_at, id
        `;
        expect(events.map((event) => event.metadata)).toMatchObject([
          { userId: ada!.userId, all: false, revoked: 1 },
          { userId: null, all: true, revoked: 1 },
        ]);
        expect(events.map((event) => event.actor_user_id)).toEqual([userId, userId]);
      } finally {
        await fixture.remove();
      }
    }));

  test("disconnecting counts reserved connections, ends one person's approved device sign-in, and answers 0 or 404 where nothing is", () =>
    withAdminOAuth(async ({ userId, sessionHeaders }) => {
      const fixture = await connectedClient();
      try {
        const [ada, ben] = fixture.people;
        // Ada also has a connection Core has not activated yet, and each person an approved device sign-in
        await oauth.refreshTokens.reserve({
          userId: ada!.userId,
          authEpoch: 0,
          client: fixture.client,
          scopes: ["openid", "offline_access"],
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        for (const person of [ada!, ben!])
          await sql`
            INSERT INTO oauth.device_authorizations
              (device_code_hash, user_code_hash, client_id, scopes, audiences, status, user_id, auth_epoch, decided_at, expires_at)
            VALUES (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${fixture.clientId}, ARRAY['openid']::text[], ARRAY['cloud']::text[],
              'approved', ${person.userId}::uuid, 0, now(), now() + INTERVAL '10 minutes')
          `;
        const openDevices = async () =>
          (
            await sql<{ user_id: string }[]>`
              SELECT user_id FROM oauth.device_authorizations WHERE client_id = ${fixture.clientId} AND expires_at > now()
            `
          ).map((row) => row.user_id);
        const disconnect = async (path: string) => {
          const response = await routes.request(path, { method: "DELETE", headers: sessionHeaders });
          return { status: response.status, body: await response.json() };
        };

        expect(await disconnect(`/${fixture.id}/connections/${ada!.userId}`)).toEqual({ status: 200, body: { revoked: 2 } });
        expect(await openDevices()).toEqual([ben!.userId]);
        // a second call and a person without a connection find nothing to revoke
        expect(await disconnect(`/${fixture.id}/connections/${ada!.userId}`)).toEqual({ status: 200, body: { revoked: 0 } });
        expect(await disconnect(`/${fixture.id}/connections/${userId}`)).toEqual({ status: 200, body: { revoked: 0 } });
        expect((await disconnect(`/${crypto.randomUUID()}/connections`)).status).toBe(404);
        expect((await disconnect(`/${crypto.randomUUID()}/connections/${ada!.userId}`)).status).toBe(404);
      } finally {
        await fixture.remove();
      }
    }));

  test("a person who is not an administrator cannot disconnect anyone", () =>
    withAdminOAuth(
      async ({ adminHeaders, sessionHeaders }) => {
        const fixture = await connectedClient();
        try {
          for (const headers of [adminHeaders, sessionHeaders]) {
            for (const path of [`/${fixture.id}/connections`, `/${fixture.id}/connections/${fixture.people[0]!.userId}`]) {
              expect((await routes.request(path, { method: "DELETE", headers })).status, path).toBe(403);
            }
          }
          expect(Object.values(await familyStates(fixture.clientId))).toEqual(["active", "active"]);
        } finally {
          await fixture.remove();
        }
      },
      { admin: false },
    ));
});

/** A confidential client with two people connected through a live refresh token each. */
const connectedClient = async () => {
  const clientId = `connections-${crypto.randomUUID()}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO oauth.clients (name,client_id,redirect_uris,scopes,audiences,is_public,registration_kind,client_secret_hash)
    VALUES ('Connections fixture',${clientId},ARRAY[]::text[],ARRAY['openid','offline_access']::text[],ARRAY['cloud']::text[],false,'managed',
      ${await Bun.password.hash("fixture")})
    RETURNING id
  `;
  const client = await oauth.clients.get({ id: row!.id });
  if (!client) throw new Error("Missing fixture client");
  const people: { userId: string; refreshToken: string }[] = [];
  for (const name of ["ada", "ben"]) {
    const [user] = await sql<{ id: string; auth_epoch: string }[]>`
      INSERT INTO auth.users (uid,provider,profile) VALUES (${`${name}-${crypto.randomUUID()}`},'local','user') RETURNING id, auth_epoch
    `;
    const reserved = await oauth.refreshTokens.reserve({
      userId: user!.id,
      authEpoch: Number(user!.auth_epoch),
      client,
      scopes: ["openid", "offline_access"],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    // Core activates a reserved family once it issued the first token
    await sql`UPDATE oauth.refresh_token_families SET status = 'active' WHERE id = ${reserved.familyId}::uuid`;
    people.push({ userId: user!.id, refreshToken: reserved.refreshToken });
  }
  return {
    id: row!.id,
    clientId,
    client,
    people,
    remove: async () => {
      await sql`DELETE FROM oauth.clients WHERE id = ${row!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(people.map((person) => person.userId))}::uuid[])`;
    },
  };
};

const familyStates = async (clientId: string) =>
  Object.fromEntries(
    (
      await sql<{ user_id: string; status: string }[]>`
        SELECT user_id, status FROM oauth.refresh_token_families WHERE client_id = ${clientId} ORDER BY user_id
      `
    ).map((family) => [family.user_id, family.status]),
  );
