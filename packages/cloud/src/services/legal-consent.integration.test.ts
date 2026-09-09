import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { createAppApprovalRoutes } from "../api/app-approval";
import { createAuthRoutes } from "../api/auth";
import { type AuthContext, auth } from "../server";
import { appApproval } from "./app-approval";
import { authFlows } from "./auth-flows";
import { createIdentityPublicRoutes } from "./identity";
import { legalConsent } from "./legal-consent";
import { session } from "./session";
import { loadCurrentUser } from "./session/user";
import * as settings from "./settings";
import { webauthn } from "./webauthn";

const isolated = /^\/cloud_legal_verify_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL || "postgres://localhost/none").pathname);
const suite = isolated ? describe : describe.skip;
const issuer = "http://localhost:3000";
let server: ReturnType<typeof Bun.serve>;
let router: Hono<AuthContext>;
let userId: string;
const unused = async (): Promise<never> => {
  throw new Error("No emails in this fixture");
};
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Origin: issuer, "Content-Type": "application/json" });
const issue = async () => {
  const response = await router.request("/issue", { method: "POST" });
  expect(response.status).toBe(200);
  return (await response.json()).token as string;
};
const accept = async (token: string, body: unknown, origin = issuer) =>
  router.request("/api/auth/legal-consent", {
    method: "POST",
    headers: { ...headers(token), Origin: origin },
    body: JSON.stringify(body),
  });

suite("first-login legal acceptance (isolated Postgres and Valkey)", () => {
  beforeAll(async () => {
    for (const name of ["auth", "audit", "settings", "logging"])
      await (await import(`../../../core/src/migrate/core/${name}.ts`)).migrate();
    await settings.set("app.url", issuer);
    await settings.set("legal.terms.content", "Fixture terms");
    await settings.set("legal.privacy.content", "Fixture privacy");
    await settings.set("security.rate_limit_per_second", 1000);
    router = new Hono<AuthContext>()
      .route("/", createIdentityPublicRoutes())
      .route("/api/auth", createAuthRoutes({ sendMagicLink: unused, sendIpaLoginHint: unused, sendPasswordReset: unused }))
      .route("/api/auth/app-approval/v1", createAppApprovalRoutes())
      .post("/issue", async (c) => c.json({ token: await session.create(c, userId) }))
      .get("/protected", auth.requireRole("authenticated"), (c) => c.json({ id: c.get("user").id }))
      .get("/pending", async (c) => c.json({ pending: !!(await legalConsent.pending(c)) }));
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: router.fetch });
    process.env.CLOUD_IDENTITY_JWKS_ORIGIN = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server?.stop(true);
    await sql.close();
    redis.close();
  });

  test("all categories: new session cannot authorize until explicit acceptance; a later login is unrestricted", async () => {
    for (const category of ["guest", "login", "freeipa"] as const) {
      userId = crypto.randomUUID();
      await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES
        (${userId}::uuid, ${`consent-${userId}`}, ${category === "freeipa" ? "ipa" : "local"}, ${category === "guest" ? "guest" : "user"})`;
      const token = await issue();
      expect(await session.authenticate(token)).toBeNull();
      expect((await router.request("/protected", { headers: headers(token) })).status).toBe(401);
      expect(await (await router.request("/pending", { headers: headers(token) })).json()).toEqual({ pending: true });
      const { version } = await legalConsent.documents();
      expect((await accept(token, { accepted: false, version })).status).toBe(400);
      expect((await accept(token, { accepted: true, version }, "https://other.example")).status).toBe(403);
      expect((await accept(token, { accepted: true, version: "0".repeat(64) })).status).toBe(409);
      expect(await session.authenticate(token)).toBeNull();
      expect((await accept(token, { accepted: true, version })).status).toBe(204);
      expect((await session.authenticate(token))?.user.id).toBe(userId);
      expect((await router.request("/protected", { headers: headers(token) })).status).toBe(200);
      const [receipt] =
        await sql`SELECT document_version, jsonb_typeof(documents) AS kind FROM auth.legal_acceptances WHERE user_id = ${userId}::uuid`;
      expect(receipt.document_version).toBe(version);
      expect(receipt.kind).toBe("array");
      expect((await session.authenticate(await issue()))?.user.id).toBe(userId);
    }
  });

  test("cancellation, expiry and account revocation cannot be bypassed through consent", async () => {
    userId = crypto.randomUUID();
    await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${userId}::uuid, ${`pending-${userId}`}, 'local', 'user')`;
    const { version } = await legalConsent.documents();
    const cancelled = await issue();
    expect((await router.request("/api/auth/logout", { method: "POST", headers: headers(cancelled) })).status).toBe(200);
    expect((await accept(cancelled, { accepted: true, version })).status).toBe(401);
    const expired = await issue();
    await sql`UPDATE auth.session_families SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE user_id = ${userId}::uuid`;
    expect((await accept(expired, { accepted: true, version })).status).toBe(401);
    const revoked = await issue();
    await session.revokeAllForUser(userId);
    expect((await accept(revoked, { accepted: true, version })).status).toBe(401);
    const disabled = await issue();
    await settings.set("user.category.login.enabled", false);
    try {
      expect((await accept(disabled, { accepted: true, version })).status).toBe(401);
    } finally {
      await settings.set("user.category.login.enabled", true);
    }
    expect(await sql`SELECT user_id FROM auth.legal_acceptances WHERE user_id = ${userId}::uuid`).toHaveLength(0);
  });

  test("existing unflagged sessions survive the additive upgrade without fabricated acceptance", async () => {
    userId = crypto.randomUUID();
    await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${userId}::uuid, ${`existing-${userId}`}, 'local', 'user')`;
    const token = await issue();
    await sql`UPDATE auth.session_families SET legal_pending = false WHERE user_id = ${userId}::uuid`;
    expect((await session.authenticate(token))?.user.id).toBe(userId);
    expect(await sql`SELECT user_id FROM auth.legal_acceptances WHERE user_id = ${userId}::uuid`).toHaveLength(0);
    expect(await session.authenticate(await issue())).toBeNull();
  });

  test("email, FreeIPA, passkey and app API completions all issue restricted sessions despite legacy acceptedAgb", async () => {
    userId = crypto.randomUUID();
    await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${userId}::uuid, ${`api-${userId}`}, 'ipa', 'user')`;
    const user = await loadCurrentUser({ userId, groupsAdmin: [] });
    if (!user) throw new Error("Missing fixture user");
    // Only the external credential proofs are stubbed. The HTTP handlers,
    // issuance, signed sessions, family lookup and consent enforcement are real.
    const ipa = spyOn(authFlows.ipa, "login").mockResolvedValue({ ok: true, userId, user });
    const email = spyOn(authFlows.magicLink, "verify").mockResolvedValue({
      ok: true,
      userId,
      user,
      email: "fixture@example.test",
      createdGuest: false,
    });
    const passkey = spyOn(webauthn, "finishAuthentication").mockResolvedValue({
      ok: true,
      data: {
        user,
        passkey: {
          id: crypto.randomUUID(),
          userId,
          name: "Fixture",
          transports: [],
          deviceType: null,
          backedUp: false,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        },
      },
    });
    const approval = spyOn(appApproval, "consumeLogin").mockResolvedValue(userId);
    await settings.set("freeipa.enable", true);
    await settings.set("user.app_approval.enabled", true);
    try {
      for (const [path, body] of [
        ["login", { username: user.uid, password: "fixture", acceptedAgb: true }],
        ["verify-token", { token: crypto.randomUUID(), acceptedAgb: true }],
        ["passkeys/authentication/verify", { response: {}, acceptedAgb: true }],
        ["app-approval/v1/login/complete", { requestId: crypto.randomUUID(), browserSecret: "a".repeat(42) + "A" }],
      ] as const) {
        const response = await router.request(`/api/auth/${path}`, {
          method: "POST",
          headers: { Origin: issuer, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
        const token = response.headers.get("set-cookie")?.match(/session_token=([^;]+)/)?.[1];
        expect(token).toBeDefined();
        expect(await session.authenticate(token!)).toBeNull();
      }
      expect(await sql`SELECT user_id FROM auth.legal_acceptances WHERE user_id = ${userId}::uuid`).toHaveLength(0);
    } finally {
      ipa.mockRestore();
      email.mockRestore();
      passkey.mockRestore();
      approval.mockRestore();
      await settings.set("freeipa.enable", false);
      await settings.set("user.app_approval.enabled", false);
    }
  });
});
