import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { loadJwtSessionUser, loadLegacySessionUser } from "./user";

const canUseDatabase = async (): Promise<boolean> => {
  try {
    const [row] = await sql<Array<{ families: string | null; keys: string | null }>>`
      SELECT to_regclass('auth.session_families')::text AS families,
             to_regclass('auth.signing_keys')::text AS keys
    `;
    return Boolean(row?.families && row.keys);
  } catch {
    return false;
  }
};

const suite = (await canUseDatabase()) ? describe : describe.skip;
const userId = crypto.randomUUID();
const sid = crypto.randomUUID();
const kid = crypto.randomUUID();

suite("session family actor resolution", () => {
  beforeAll(async () => {
    await sql`
      INSERT INTO auth.users (
        id, uid, provider, profile, given_name, sn, display_name, mail,
        auth_epoch, legacy_session_generation
      ) VALUES (
        ${userId}, ${`session-family-${userId}`}, 'local', 'user', 'Session', 'Family',
        'Session Family', ${`session-family-${userId}@example.test`}, 2, 4
      )
    `;
    await sql`
      INSERT INTO auth.signing_keys (
        purpose, state, kid, public_jwk, encrypted_private_jwk, encryption_key_id,
        activate_at, activated_at, sign_until, retired_at, verify_until
      ) VALUES (
        'session', 'retired', ${kid}, ${JSON.stringify({ kty: "RSA", n: "test", e: "AQAB", kid, alg: "RS256" })}::jsonb,
        'integration-test', 'integration-test', now() - INTERVAL '2 days', now() - INTERVAL '2 days',
        now() - INTERVAL '1 day', now() - INTERVAL '1 day', now() + INTERVAL '1 day'
      )
    `;
    await sql`
      INSERT INTO auth.session_families (sid, user_id, auth_epoch, signing_kid, issued_at, expires_at)
      VALUES (${sid}, ${userId}, 2, ${kid}, now(), now() + INTERVAL '1 hour')
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM auth.users WHERE id = ${userId}`;
    await sql`DELETE FROM auth.signing_keys WHERE kid = ${kid}`;
  });

  test("enforces family, epoch, key revocation, and the durable legacy floor", async () => {
    const input = { userId, sid, authEpoch: 2, groupsAdmin: ["admins"] };
    expect((await loadJwtSessionUser(input))?.id).toBe(userId);

    await sql`UPDATE auth.session_families SET revoked_at = now(), revocation_reason = 'test' WHERE sid = ${sid}`;
    expect(await loadJwtSessionUser(input)).toBeNull();
    await sql`UPDATE auth.session_families SET revoked_at = NULL, revocation_reason = NULL WHERE sid = ${sid}`;

    await sql`UPDATE auth.users SET auth_epoch = 3 WHERE id = ${userId}`;
    expect(await loadJwtSessionUser(input)).toBeNull();
    await sql`UPDATE auth.users SET auth_epoch = 2 WHERE id = ${userId}`;

    await sql`UPDATE auth.signing_keys SET state = 'revoked', revoked_at = now(), revoke_reason = 'test' WHERE kid = ${kid}`;
    expect(await loadJwtSessionUser(input)).toBeNull();

    expect(await loadLegacySessionUser({ userId, sessionGeneration: 3, groupsAdmin: ["admins"] })).toBeNull();
    expect((await loadLegacySessionUser({ userId, sessionGeneration: 4, groupsAdmin: ["admins"] }))?.id).toBe(userId);
  });
});
