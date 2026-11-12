import { afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { migrate as migrateAuth } from "../../core/src/migrate/core/auth";
import { migrate as migrateSettings } from "../../core/src/migrate/core/settings";
import { migrate } from "./migrate";
import * as clients from "./service/clients";
import { stageOAuthAuthority } from "./service/issuer-authority";
import * as refreshTokens from "./service/refresh-tokens";
import { OAuthAuthorityRejectedError } from "./service/token-authority";
import * as tokens from "./service/tokens";

// This suite exercises schema upgrades on the shared `_test` database and restores the schema itself.
const suite = suiteFor("database");
const fixture = async () => {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile) VALUES (${crypto.randomUUID()}, 'local', 'user') RETURNING id
  `;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO oauth.clients (name, redirect_uris, scopes, audiences)
    VALUES (${crypto.randomUUID()}, ARRAY['https://client.test/callback'], ARRAY['openid', 'offline_access'], ARRAY['cloud', 'mail'])
    RETURNING id
  `;
  const client = await clients.get({ id: row!.id });
  if (!client || !user) throw new Error("Missing OAuth fixture");
  return { userId: user.id, client };
};
const activeRefreshFamily = async (params: Omit<Parameters<typeof refreshTokens.reserve>[0], "authEpoch">) => {
  const [user] = await sql<{ auth_epoch: string | number }[]>`SELECT auth_epoch FROM auth.users WHERE id = ${params.userId}::uuid`;
  if (!user) throw new Error("Missing test user");
  const reserved = await refreshTokens.reserve({ ...params, authEpoch: Number(user.auth_epoch) });
  await sql`UPDATE oauth.refresh_token_families SET status = 'active' WHERE id = ${reserved.familyId}::uuid`;
  return reserved;
};
const waitForBlockedBy = async (pid: number) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [row] = await sql<{ waiting: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS waiting
    `;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected reservation release to wait for the Core claim transaction");
};

suite("OAuth external review regressions", () => {
  beforeAll(async () => {
    await migrateAuth();
    await migrateSettings();
    await migrate();
  }, 60_000);

  beforeEach(async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
  });
  afterEach(() => setSystemTime());

  test.each([400, 403, 500, 503])("a definitive Core rejection releases a refresh reservation: %s", async (status) => {
    const { userId, client } = await fixture();
    const token = await activeRefreshFamily({
      userId,
      client,
      scopes: ["openid", "offline_access"],
      audiences: ["cloud", client.clientId],
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await expect(
      refreshTokens.rotate(token.refreshToken, client, undefined, undefined, async () => {
        throw new OAuthAuthorityRejectedError(status);
      }),
    ).rejects.toBeInstanceOf(OAuthAuthorityRejectedError);
    const [released] = await sql`SELECT status,authority_issued_at FROM oauth.refresh_tokens WHERE family_id=${token.familyId}::uuid`;
    expect(released).toMatchObject({ status: "active", authority_issued_at: null });
    const result = await refreshTokens.rotate(token.refreshToken, client, undefined, undefined, async ({ authorityGrant }) => {
      await sql`UPDATE oauth.refresh_tokens SET authority_issued_at=now() WHERE id=${authorityGrant.tokenId}::uuid`;
    });
    expect(result.ok).toBe(true);
  });

  test("an uncertain transport outcome keeps the refresh consumed without retry", async () => {
    const { userId, client } = await fixture();
    const token = await activeRefreshFamily({
      userId,
      client,
      scopes: ["openid", "offline_access"],
      audiences: ["cloud", client.clientId],
      expiresAt: new Date(Date.now() + 3600_000),
    });
    let calls = 0;
    await expect(
      refreshTokens.rotate(token.refreshToken, client, undefined, undefined, async ({ authorityGrant }) => {
        calls++;
        await stageOAuthAuthority(
          [{ kind: "user_access", grant: authorityGrant, expiresIn: 60 }],
          "https://cloud.test",
          new Date(Date.now() + 3600_000),
        );
        throw new TypeError("Core response was lost");
      }),
    ).rejects.toThrow("Core response was lost");
    expect(calls).toBe(1);
    const [state] = await sql`SELECT t.status,t.authority_issued_at,f.status AS family_status
      FROM oauth.refresh_tokens t JOIN oauth.refresh_token_families f ON f.id=t.family_id WHERE f.id=${token.familyId}::uuid`;
    expect(state).toMatchObject({ status: "revoked", family_status: "revoked", authority_issued_at: expect.any(Date) });
    expect((await refreshTokens.rotate(token.refreshToken, client)).ok).toBe(false);
  });

  test("refresh reservation waits for the family without locking its token", async () => {
    const { userId, client } = await fixture();
    const token = await activeRefreshFamily({
      expiresAt: new Date(Date.now() + refreshTokens.DEFAULT_LOGIN_LIFETIME_SECONDS * 1000),
      userId,
      client,
      scopes: ["openid", "offline_access"],
      audiences: ["cloud", client.clientId],
    });
    let rotation: ReturnType<typeof refreshTokens.rotate> | undefined;
    await sql.begin(async (db) => {
      await db`SELECT id FROM oauth.refresh_token_families WHERE id = ${token.familyId}::uuid FOR UPDATE`;
      const [backend] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      rotation = refreshTokens.rotate(token.refreshToken, client, undefined, undefined, async ({ authorityGrant }) => {
        await sql`UPDATE oauth.refresh_tokens SET authority_issued_at = now() WHERE id = ${authorityGrant.tokenId}::uuid`;
      });
      await waitForBlockedBy(backend!.pid);
      // A token-first reservation deadlocks against this finalizer lock order.
      await db`SELECT id FROM oauth.refresh_tokens WHERE family_id = ${token.familyId}::uuid FOR UPDATE NOWAIT`;
    });
    expect((await rotation)?.ok).toBe(true);
  }, 30_000);

  test("audience upgrade rolls back atomically, preserves grants and rejects old writers", async () => {
    const { userId, client } = await fixture();
    // The test database keeps codes from earlier runs; name and read only this client's codes.
    const code = (name: string) => `${client.clientId}:${name}`;
    await sql`ALTER TABLE oauth.codes DROP COLUMN audiences`.simple();
    await sql`INSERT INTO oauth.codes (code, client_id, user_id, redirect_uri, resource)
      VALUES (${code("before-upgrade")}, ${client.clientId}, ${userId}::uuid, 'https://client.test/callback', 'mail')`;
    await sql`CREATE FUNCTION oauth.reject_audience_backfill() RETURNS trigger AS $$ BEGIN
      RAISE EXCEPTION 'injected audience migration failure'; END; $$ LANGUAGE plpgsql`.simple();
    await sql`CREATE TRIGGER reject_audience_backfill BEFORE UPDATE ON oauth.codes
      FOR EACH ROW EXECUTE FUNCTION oauth.reject_audience_backfill()`.simple();
    try {
      await expect(migrate()).rejects.toThrow("injected audience migration failure");
      const [column] = await sql<{ present: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'oauth' AND table_name = 'codes' AND column_name = 'audiences') AS present
      `;
      expect(column?.present).toBe(false);
    } finally {
      await sql`DROP TRIGGER reject_audience_backfill ON oauth.codes`.simple();
      await sql`DROP FUNCTION oauth.reject_audience_backfill()`.simple();
    }
    await migrate();
    // Also repair grants written with the previous migration's incorrect default.
    await sql`ALTER TABLE oauth.codes ALTER COLUMN audiences SET DEFAULT ARRAY['cloud']::text[]`.simple();
    await sql`INSERT INTO oauth.codes (code, client_id, user_id, redirect_uri, resource)
      VALUES (${code("previous-default")}, ${client.clientId}, ${userId}::uuid, 'https://client.test/callback', 'mail')`;
    await migrate();
    const oldWriter = async () => {
      await sql`INSERT INTO oauth.codes (code, client_id, user_id, redirect_uri, resource)
        VALUES (${code("old-writer")}, ${client.clientId}, ${userId}::uuid, 'https://client.test/callback', 'mail')`;
    };
    await expect(oldWriter()).rejects.toThrow('null value in column "audiences"');
    await sql`INSERT INTO oauth.codes (code, client_id, user_id, redirect_uri, audiences)
      VALUES (${code("new-writer")}, ${client.clientId}, ${userId}::uuid, 'https://client.test/callback', ARRAY['cloud', ${client.clientId}])`;
    await migrate();
    const rows = await sql<{ code: string; audiences: string[] }[]>`
      SELECT code, audiences FROM oauth.codes WHERE client_id = ${client.clientId} ORDER BY code
    `;
    expect(rows).toEqual([
      { code: code("before-upgrade"), audiences: ["mail"] },
      { code: code("new-writer"), audiences: ["cloud", client.clientId] },
      { code: code("previous-default"), audiences: ["mail"] },
    ]);
  }, 60_000);

  test("unknown OAuth keys cannot poison a warm local verifier during a storage outage", async () => {
    const originalOrigin = process.env.CLOUD_OAUTH_JWKS_ORIGIN;
    const kid = crypto.randomUUID();
    const pair = await generateKeyPair("RS256", { extractable: true });
    const publicKey = await exportJWK(pair.publicKey);
    let renamed = false;
    try {
      delete process.env.CLOUD_OAUTH_JWKS_ORIGIN;
      tokens.clearOAuthVerifierCacheForTest();
      await sql`INSERT INTO auth.signing_keys (
        purpose, state, kid, alg, public_jwk, encrypted_private_jwk, encryption_key_id,
        created_at, activate_at, activated_at, sign_until, retired_at, verify_until
      ) VALUES ('oauth', 'retired', ${kid}, 'RS256', ${JSON.stringify(publicKey)}::jsonb, 'unused', 'test',
        now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours',
        now() - interval '1 hour', now() - interval '30 minutes', now() + interval '1 hour')`;
      const sign = (keyId: string) =>
        new SignJWT({ token_use: "access" })
          .setProtectedHeader({ alg: "RS256", kid: keyId })
          .setIssuer("https://cloud.test")
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(pair.privateKey);
      const valid = await sign(kid);
      expect(await tokens.verifyAccessToken({ token: valid, issuer: "https://cloud.test" })).not.toBeNull();
      // The suite is opt-in and asserts its `_test` database before running.
      await sql`ALTER TABLE auth.signing_keys RENAME TO signing_keys_cache_outage`.simple();
      renamed = true;
      expect(await tokens.verifyAccessToken({ token: await sign(crypto.randomUUID()), issuer: "https://cloud.test" })).toBeNull();
      expect(await tokens.verifyAccessToken({ token: valid, issuer: "https://cloud.test" })).not.toBeNull();
    } finally {
      if (renamed) await sql`ALTER TABLE auth.signing_keys_cache_outage RENAME TO signing_keys`.simple();
      await sql`DELETE FROM auth.signing_keys WHERE kid = ${kid}`;
      tokens.clearOAuthVerifierCacheForTest();
      if (originalOrigin === undefined) delete process.env.CLOUD_OAUTH_JWKS_ORIGIN;
      else process.env.CLOUD_OAUTH_JWKS_ORIGIN = originalOrigin;
    }
  });
});
