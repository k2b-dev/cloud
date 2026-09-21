import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { loadJwtSessionIdentity, loadJwtSessionUser } from "./user";

const suite = databaseSuite();
const userId = crypto.randomUUID();
const sid = crypto.randomUUID();
const kid = crypto.randomUUID();

suite("session family actor resolution", () => {
  beforeAll(async () => {
    await sql`
      INSERT INTO auth.users (
        id, uid, provider, profile, given_name, sn, display_name, mail,
        auth_epoch
      ) VALUES (
        ${userId}, ${`session-family-${userId}`}, 'local', 'user', 'Session', 'Family',
        'Session Family', ${`session-family-${userId}@example.test`}, 2
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

  test("enforces family, epoch and signing-key revocation", async () => {
    const input = { userId, sid, authEpoch: 2, groupsAdmin: ["admins"] };
    expect((await loadJwtSessionUser(input))?.id).toBe(userId);
    expect((await loadJwtSessionIdentity(input))?.userId).toBe(userId);
    const invalid = async () => {
      expect(await loadJwtSessionUser(input)).toBeNull();
      expect(await loadJwtSessionIdentity(input)).toBeNull();
    };
    await sql`UPDATE auth.session_families SET legal_pending = true WHERE sid = ${sid}`;
    await invalid();
    expect((await loadJwtSessionUser({ ...input, allowPendingLegalConsent: true }))?.id).toBe(userId);
    await sql`UPDATE auth.session_families SET legal_pending = false WHERE sid = ${sid}`;
    await sql`UPDATE auth.session_families SET issued_at = now() - INTERVAL '1 hour', expires_at = now() - INTERVAL '1 second' WHERE sid = ${sid}`;
    await invalid();
    await sql`UPDATE auth.session_families SET expires_at = now() + INTERVAL '1 hour' WHERE sid = ${sid}`;
    expect(await loadJwtSessionIdentity({ ...input, userId: crypto.randomUUID() })).toBeNull();
    expect(await loadJwtSessionIdentity({ ...input, authEpoch: 3 })).toBeNull();

    await sql`UPDATE auth.session_families SET revoked_at = now(), revocation_reason = 'test' WHERE sid = ${sid}`;
    await invalid();
    await sql`UPDATE auth.session_families SET revoked_at = NULL, revocation_reason = NULL WHERE sid = ${sid}`;

    await sql`UPDATE auth.users SET auth_epoch = 3 WHERE id = ${userId}`;
    await invalid();
    await sql`UPDATE auth.users SET auth_epoch = 2 WHERE id = ${userId}`;

    await sql`UPDATE auth.signing_keys SET state = 'revoked', revoked_at = now(), revoke_reason = 'test' WHERE kid = ${kid}`;
    await invalid();
  });
});
