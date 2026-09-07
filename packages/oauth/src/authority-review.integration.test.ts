import { beforeAll, describe, expect, test } from "bun:test";
import { clearIdentityKeyCachesForTest, prepareIdentitySigner, revokeIdentitySigningKey } from "@valentinkolb/cloud/services/identity";
import { sql } from "bun";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createIdentityOAuthIssuanceRoutes } from "../../core/src/api/identity-oauth-issuance";
import { migrate as migrateAuth } from "../../core/src/migrate/core/auth";
import { migrate } from "./migrate";
import * as clients from "./service/clients";
import * as refreshTokens from "./service/refresh-tokens";
import type { OAuthUserGrantReference } from "./service/token-authority";
import * as tokens from "./service/tokens";

// This suite intentionally exercises schema upgrades and must use a disposable DB.
const suite = process.env.CLOUD_OAUTH_REVIEW_INTEGRATION === "1" ? describe : describe.skip;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
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
const coreRoutes = async (options: { beforeSign?: () => Promise<void>; onTransaction?: (pid: number) => void } = {}) => {
  const { privateKey } = await generateKeyPair("RS256");
  return createIdentityOAuthIssuanceRoutes({
    authenticate: () => true,
    issuer: async () => "https://cloud.test",
    withActiveSigner: (_purpose, callback) =>
      sql.begin(async (db) => {
        const [row] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        options.onTransaction?.(row!.pid);
        const result = await callback(
          { kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000), issuer: "https://cloud.example.test" },
          db,
        );
        await options.beforeSign?.();
        return result;
      }),
  });
};
const issue = (routes: Awaited<ReturnType<typeof coreRoutes>>, grant: OAuthUserGrantReference) =>
  routes.request("/oauth/token", {
    method: "POST",
    headers: { authorization: "Bearer workload", "content-type": "application/json" },
    body: JSON.stringify({ tokens: [{ kind: "user_access", grant, expiresIn: 3_600 }] }),
  });

suite("OAuth external review regressions", () => {
  beforeAll(async () => {
    if (!new URL(process.env.DATABASE_URL!).pathname.startsWith("/oauth_review_fix_")) {
      throw new Error("OAuth review integration requires an isolated oauth_review_fix_ database");
    }
    await migrateAuth();
    await migrate();
  }, 60_000);

  test("transport failure releases an unclaimed attempt and fences late Core even after re-reservation", async () => {
    const { userId, client } = await fixture();
    const token = await refreshTokens.create({
      userId,
      client,
      scopes: ["openid", "offline_access"],
      audiences: ["cloud", client.clientId],
    });
    const routes = await coreRoutes();
    const references: OAuthUserGrantReference[] = [];
    await expect(
      refreshTokens.rotate(token.refreshToken, client, undefined, undefined, async ({ authorityGrant }) => {
        references.push(authorityGrant);
        throw new Error("Core unavailable");
      }),
    ).rejects.toThrow("Core unavailable");
    const [released] = await sql<{ status: string; authority_nonce: string | null; authority_issued_at: Date | null }[]>`
      SELECT status, authority_nonce, authority_issued_at FROM oauth.refresh_tokens WHERE family_id = ${token.familyId}::uuid
    `;
    expect(released).toMatchObject({ status: "active", authority_nonce: null, authority_issued_at: null });
    const result = await refreshTokens.rotate(token.refreshToken, client, undefined, undefined, async ({ authorityGrant }) => {
      expect(authorityGrant.nonce).not.toBe(references[0]!.nonce);
      expect((await issue(routes, references[0]!)).status).toBe(403);
      expect((await issue(routes, authorityGrant)).status).toBe(200);
    });
    expect(result.ok).toBe(true);
  }, 30_000);

  test("Core claim wins concurrent release: lost response revokes the family without reissuance", async () => {
    const { userId, client } = await fixture();
    const token = await refreshTokens.create({
      userId,
      client,
      scopes: ["openid", "offline_access"],
      audiences: ["cloud", client.clientId],
    });
    const entered = deferred();
    const finish = deferred();
    let corePid = 0;
    const routes = await coreRoutes({
      onTransaction: (pid) => {
        corePid = pid;
      },
      beforeSign: async () => {
        entered.resolve();
        await finish.promise;
      },
    });
    let coreResponse: Promise<Response> | undefined;
    const rotation = refreshTokens.rotate(token.refreshToken, client, undefined, undefined, async ({ authorityGrant }) => {
      coreResponse = Promise.resolve(issue(routes, authorityGrant));
      await entered.promise;
      throw new Error("response lost while Core signs");
    });
    const outcome = rotation.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      await waitForBlockedBy(corePid);
    } finally {
      finish.resolve();
    }
    expect((await coreResponse)?.status).toBe(200);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) expect(error.message).toBe("response lost while Core signs");
    const [state] = await sql<{ status: string; issued: boolean; family_status: string }[]>`
      SELECT token.status, token.authority_issued_at IS NOT NULL AS issued, family.status AS family_status
      FROM oauth.refresh_tokens token JOIN oauth.refresh_token_families family ON family.id = token.family_id
      WHERE family.id = ${token.familyId}::uuid
    `;
    expect(state).toEqual({ status: "revoked", issued: true, family_status: "revoked" });
    expect((await refreshTokens.rotate(token.refreshToken, client)).ok).toBe(false);
  }, 30_000);

  test("refresh reservation waits for the family without locking its token", async () => {
    const { userId, client } = await fixture();
    const token = await refreshTokens.create({
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
    await sql`ALTER TABLE oauth.codes DROP COLUMN audiences`.simple();
    await sql`INSERT INTO oauth.codes (code, client_id, user_id, redirect_uri, resource)
      VALUES ('before-upgrade', ${client.clientId}, ${userId}::uuid, 'https://client.test/callback', 'mail')`;
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
      VALUES ('previous-default', ${client.clientId}, ${userId}::uuid, 'https://client.test/callback', 'mail')`;
    await migrate();
    const oldWriter = async () => {
      await sql`INSERT INTO oauth.codes (code, client_id, user_id, redirect_uri, resource)
        VALUES ('old-writer', ${client.clientId}, ${userId}::uuid, 'https://client.test/callback', 'mail')`;
    };
    await expect(oldWriter()).rejects.toThrow();
    await sql`INSERT INTO oauth.codes (code, client_id, user_id, redirect_uri, audiences)
      VALUES ('new-writer', ${client.clientId}, ${userId}::uuid, 'https://client.test/callback', ARRAY['cloud', ${client.clientId}])`;
    await migrate();
    const rows = await sql<{ code: string; audiences: string[] }[]>`SELECT code, audiences FROM oauth.codes ORDER BY code`;
    expect(rows).toEqual([
      { code: "before-upgrade", audiences: ["mail"] },
      { code: "new-writer", audiences: ["cloud", client.clientId] },
      { code: "previous-default", audiences: ["mail"] },
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
      // The suite is opt-in and asserts its disposable database before running.
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

  test("emergency OAuth revoke eagerly prepares a usable replacement", async () => {
    const originalApp = process.env.APP_ID;
    const originalKey = process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY;
    try {
      process.env.APP_ID = "core";
      process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = "12".repeat(32);
      clearIdentityKeyCachesForTest();
      const signer = await prepareIdentitySigner("oauth");
      expect(await revokeIdentitySigningKey({ kid: signer.kid, reason: "OAuth review test" })).toBe(true);
      const active = await sql<
        { kid: string }[]
      >`SELECT kid FROM auth.signing_keys WHERE purpose = 'oauth' AND state = 'active' AND sign_until > now()`;
      expect(active).toHaveLength(1);
      expect(active[0]!.kid).not.toBe(signer.kid);
    } finally {
      if (originalApp === undefined) delete process.env.APP_ID;
      else process.env.APP_ID = originalApp;
      if (originalKey === undefined) delete process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY;
      else process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = originalKey;
      clearIdentityKeyCachesForTest();
    }
  }, 30_000);
});
