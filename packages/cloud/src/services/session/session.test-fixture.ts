import { afterAll } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import type { NewBrowserSignInNotifier } from "../known-browsers";
import { session } from "./index";

/** Integration fixture: run with an isolated Core authority and its public JWKS endpoint. */
export const createTestSession = async (userId: string, notify: NewBrowserSignInNotifier = async () => {}): Promise<string> => {
  // Most session fixtures represent established users, not first-use onboarding.
  await sql`INSERT INTO auth.legal_acceptances (user_id, session_id, document_version, documents)
    VALUES (${userId}::uuid, ${crypto.randomUUID()}::uuid, 'test-fixture', '[]'::jsonb) ON CONFLICT DO NOTHING`;
  const app = new Hono().post("/login", async (c) => c.json({ token: await session.create(c, userId, { method: "password", notify }) }));
  const response = await app.request("/login", { method: "POST" });
  if (response.status !== 200) throw new Error(`Session fixture login failed: ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string") {
    throw new Error("Session fixture did not return a token");
  }
  return body.token;
};

/** Integration fixture: an app session of the mobile app for a phone inserted directly, without pairing. */
export const createTestAppSession = async (userId: string): Promise<{ token: string; deviceId: string }> => {
  await sql`INSERT INTO auth.legal_acceptances (user_id, session_id, document_version, documents)
    VALUES (${userId}::uuid, ${crypto.randomUUID()}::uuid, 'test-fixture', '[]'::jsonb) ON CONFLICT DO NOTHING`;
  const deviceId = crypto.randomUUID();
  await sql`INSERT INTO auth.pwa_devices (id, user_id, name, platform, auth_epoch, secret_hash, rotated_at)
    SELECT ${deviceId}::uuid, id, 'Test phone', 'other', auth_epoch, ${"0".repeat(64)}, now() FROM auth.users WHERE id = ${userId}::uuid`;
  const app = new Hono().post("/issue", async (c) => {
    const { token } = await session.issueInTransaction(c, async (_tx, issue) => {
      await issue(userId, { ttlSeconds: 86_400, pwaDeviceId: deviceId, recordLogin: false });
    });
    return c.json({ token });
  });
  const body = (await (await app.request("/issue", { method: "POST" })).json()) as { token?: unknown };
  if (typeof body.token !== "string") throw new Error("App session fixture did not return a token");
  return { token: body.token, deviceId };
};

const browserSignInFixtures: string[] = [];
afterAll(async () => {
  for (const sid of browserSignInFixtures) {
    await sql`DELETE FROM auth.session_families WHERE sid = ${sid}::uuid`;
    await sql`DELETE FROM auth.signing_keys WHERE kid = ${sid}`;
  }
});

/** Durable web-session evidence for service tests; no signed token or running authority is needed. */
export const createTestBrowserSignIn = async (userId: string): Promise<{ userId: string; sid: string }> => {
  const sid = crypto.randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO auth.signing_keys
      (purpose, state, kid, public_jwk, encrypted_private_jwk, encryption_key_id,
       activate_at, activated_at, sign_until, retired_at, verify_until)
      VALUES ('session', 'retired', ${sid}, '{}'::jsonb, 'test', 'test',
        now() - interval '2 days', now() - interval '2 days', now() - interval '1 day',
        now() - interval '1 day', now() - interval '1 hour')`;
    const [row] = await tx`INSERT INTO auth.session_families (sid, user_id, auth_epoch, signing_kid, issued_at, expires_at)
      SELECT ${sid}::uuid, id, auth_epoch, ${sid}, now(), now() + interval '1 hour'
      FROM auth.users WHERE id = ${userId}::uuid RETURNING sid`;
    if (!row) throw new Error("Browser session fixture user was not found");
  });
  browserSignInFixtures.push(sid);
  return { userId, sid };
};
