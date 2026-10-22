import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { decodeJwt, SignJWT } from "jose";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { freeipa } from "../server/services";
import { accounts } from "../services/accounts";
import { audit } from "../services/audit";
import * as keyRing from "../services/identity/key-ring";
import { getIdentityRuntimeConfig } from "../services/identity/runtime-config";
import * as sessionTokens from "../services/identity/session-token";
import { providers } from "../services/providers";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { session } from "../services/session";
import { requireConfirmedBrowserSignIn } from "../services/session/recent";
import { createTestAppSession, createTestSession } from "../services/session/session.test-fixture";
import * as settings from "../services/settings";
import { createAuthRoutes } from "./auth";
import me from "./me";

const suite = databaseSuite();
const issuer = "http://localhost:3000";
const unused = async (): Promise<never> => {
  throw new Error("No notification expected");
};
const router = new Hono().route("/api/me", me).route(
  "/api/auth",
  createAuthRoutes({
    sendMagicLink: unused,
    sendIpaLoginHint: unused,
    sendPasswordReset: unused,
    sendNewBrowserSignIn: async () => {},
  }),
);
const post = (path: string, token: string, body: unknown = {}) =>
  router.request(path, {
    method: "POST",
    headers: { Cookie: `session_token=${token}`, "Content-Type": "application/json", Origin: issuer },
    body: JSON.stringify(body),
  });
const change = (token: string) =>
  post("/api/me/password", token, {
    currentPassword: "Current-password-1!",
    newPassword: "New-password-2!",
    confirmPassword: "New-password-2!",
  });
const cookieToken = (response: Response): string => {
  const token = response.headers.get("set-cookie")?.match(/(?:^|,\s*)session_token=([^;]+)/)?.[1];
  if (!token) throw new Error("Missing rotated session cookie");
  return token;
};
const cloudLoginPhone = async (userId: string): Promise<string> => {
  const id = crypto.randomUUID();
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted,enrolled_by)
    VALUES (${id}::uuid,${issuer},${userId}::uuid,'Cloud Login',${JSON.stringify(publicKey)}::text::jsonb,false,${userId}::uuid)`;
  return id;
};
const sidOf = (token: string): string => String(decodeJwt(token).sid);
const family = async (sid: string) => {
  const [row] = await sql<
    Array<{ issued_at: Date; expires_at: Date; auth_epoch: string; signing_kid: string; revocation_reason: string | null }>
  >`
    SELECT issued_at, expires_at, auth_epoch, signing_kid, revocation_reason FROM auth.session_families WHERE sid = ${sid}::uuid
  `;
  if (!row) throw new Error("Missing session family");
  return row;
};

suite("password changes end other sign-ins", () => {
  const previous = new Map<string, unknown>();
  const values: Record<string, unknown> = {
    "app.url": issuer,
    "freeipa.enable": true,
    "user.category.freeipa.enabled": true,
    "security.rate_limit_per_second": 1000,
    "freeipa.url": "https://ipa.example.test",
    "freeipa.service_user": "fixture",
    "freeipa.service_password": "fixture-only",
    "freeipa.groups.base_sync": ["fixture"],
    "freeipa.groups.base_ipa_realm": ["fixture"],
  };
  let userId: string;
  let uid: string;
  let a: string;
  let b: string;
  let sid: string;
  let epoch: number;
  let restore: Array<() => void>;
  const watch = <T extends { mockRestore(): void }>(spy: T): T => {
    restore.push(() => spy.mockRestore());
    return spy;
  };
  beforeAll(async () => {
    for (const [key, value] of Object.entries(values)) {
      previous.set(key, await settings.get(key));
      await settings.set(key, value);
    }
  });
  beforeEach(async () => {
    const [clock] = await sql<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
    restore = [];
    userId = crypto.randomUUID();
    uid = `password-sign-out-${userId}`;
    await sql`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${userId}::uuid, ${uid}, 'ipa', 'user')`;
    a = await createTestSession(userId);
    b = await createTestSession(userId);
    sid = String(decodeJwt(a).sid);
    epoch = Number(decodeJwt(a).auth_epoch);
    watch(spyOn(providers.ipa.auth, "login").mockResolvedValue({ status: "success", session: "fixture" }));
    watch(spyOn(providers.ipa.auth, "changePassword").mockResolvedValue({ ok: true, data: undefined }));
  });
  afterEach(async () => {
    for (const undo of restore.reverse()) undo();
    setSystemTime();
    await sql`DELETE FROM audit.events WHERE actor_user_id = ${userId}::uuid OR metadata->>'targetUserId' = ${userId}`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });
  afterAll(async () => {
    for (const [key, value] of previous) await settings.set(key, value);
  });

  test("a password sign-in overlapping a password change gets no session", async () => {
    watch(
      spyOn(providers.ipa.auth, "login").mockImplementation(async () => {
        await session.endOtherSignIns(userId, { reason: "password_change" });
        return { status: "success", session: "fixture" };
      }),
    );
    watch(spyOn(providers.ipa.sync, "user").mockResolvedValue({ status: "skipped_disabled" }));
    const before = await sql`SELECT sid FROM auth.session_families WHERE user_id = ${userId}::uuid`;
    const response = await post("/api/auth/login", a, { username: uid, password: "Current-password-1!" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "You were signed out everywhere while signing in. Sign in again." });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await sql`SELECT sid FROM auth.session_families WHERE user_id = ${userId}::uuid`).toHaveLength(before.length);
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("a password sign-in succeeds when the account epoch stays current", async () => {
    watch(spyOn(providers.ipa.sync, "user").mockResolvedValue({ status: "skipped_disabled" }));
    const response = await post("/api/auth/login", a, { username: uid, password: "Current-password-1!" });
    expect(response.status).toBe(200);
    const token = cookieToken(response);
    expect(await response.json()).toMatchObject({ session_token: token, user: { uid } });
    expect(await session.authenticate(token)).toMatchObject({ data: { userId, authEpoch: epoch } });
  });

  test("a password sign-in whose account is synced in during the password check gets no session; the next attempt does", async () => {
    const lateId = crypto.randomUUID();
    const lateUid = `password-sign-out-late-${lateId}`;
    try {
      // A full sync adds the account after the sign-in read its epoch, so that sign-in is bound to none.
      const ipaLogin = watch(
        spyOn(providers.ipa.auth, "login").mockImplementationOnce(async () => {
          await sql`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${lateId}::uuid, ${lateUid}, 'ipa', 'user')`;
          return { status: "success", session: "fixture" };
        }),
      );
      watch(spyOn(providers.ipa.sync, "user").mockResolvedValue({ status: "skipped_disabled" }));
      const response = await post("/api/auth/login", a, { username: lateUid, password: "Current-password-1!" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "Your account is not yet available. Please try again in a few minutes." });
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(await sql`SELECT sid FROM auth.session_families WHERE user_id = ${lateId}::uuid`).toHaveLength(0);
      const retry = await post("/api/auth/login", a, { username: lateUid, password: "Current-password-1!" });
      expect(retry.status).toBe(200);
      expect(ipaLogin).toHaveBeenCalledTimes(2);
      expect(await retry.json()).toMatchObject({ session_token: cookieToken(retry), user: { uid: lateUid } });
      // The account has not accepted the terms yet, so the family exists but waits for them.
      expect(await sql`SELECT sid FROM auth.session_families WHERE user_id = ${lateId}::uuid AND revoked_at IS NULL`).toHaveLength(1);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${lateId}::uuid`;
    }
  });

  test("keeps only this browser under a new session id with its sign-in time and expiry; paired Cloud Login and API keys stay valid", async () => {
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing user");
    const key = await serviceAccountCredentials.createUserApiToken({ user, browserSignIn: { userId, sid }, name: "Existing key" });
    if (!key.ok) throw new Error("Cannot create fixture key");
    const app = await createTestAppSession(userId);
    const loginDeviceId = await cloudLoginPhone(userId);
    await sql`UPDATE auth.session_families SET issued_at = now() - interval '11 minutes' WHERE sid = ${sid}::uuid`;
    const before = await family(sid);
    const [loginBefore] = await sql`SELECT last_login_local FROM auth.users WHERE id = ${userId}::uuid`;
    const browserCount = await sql`SELECT id FROM auth.known_browsers WHERE user_id = ${userId}::uuid`;
    const response = await change(a);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signInAgain: false });
    const rotated = cookieToken(response);
    expect(rotated === a).toBe(false);
    const newSid = sidOf(rotated);
    expect(newSid === sid).toBe(false);
    expect(await session.authenticate(rotated)).toMatchObject({ data: { sid: newSid, userId, kind: "web" } });
    expect((await family(sid)).revocation_reason).toBe("rotated");
    const after = await family(newSid);
    expect(after.issued_at).toEqual(before.issued_at);
    expect(after.expires_at).toEqual(before.expires_at);
    expect(decodeJwt(rotated).iat).toBe(Math.floor(before.issued_at.getTime() / 1000));
    expect(decodeJwt(rotated).exp).toBe(Math.floor(before.expires_at.getTime() / 1000));
    await expect(
      requireConfirmedBrowserSignIn(sql, { userId, sid: newSid }, (code) => {
        throw new Error(code);
      }),
    ).rejects.toThrow("REAUTHENTICATE");
    for (const token of [a, b, app.token]) expect((await session.authenticate(token)) === null).toBe(true);
    const [phone] = await sql`SELECT revoked_at, revocation_reason FROM auth.pwa_devices WHERE id = ${app.deviceId}::uuid`;
    expect(phone!.revoked_at !== null).toBe(true);
    expect(phone!.revocation_reason).toBe("password_change");
    expect(
      await sql`SELECT id FROM audit.events WHERE action = 'auth.pwa.device.revoke' AND target_id = ${app.deviceId}
      AND metadata->>'reason' = 'password_change'`,
    ).toHaveLength(1);
    expect(await sql`SELECT id FROM auth.app_devices WHERE id = ${loginDeviceId}::uuid AND revoked_at IS NULL`).toHaveLength(1);
    expect((await me.request("/", { headers: { Authorization: `Bearer ${key.data.token}` } })).status).toBe(200);
    const [loginAfter] = await sql`SELECT last_login_local FROM auth.users WHERE id = ${userId}::uuid`;
    expect(loginAfter!.last_login_local).toEqual(loginBefore!.last_login_local);
    expect(await sql`SELECT id FROM auth.known_browsers WHERE user_id = ${userId}::uuid`).toEqual(browserCount);
    const maxAge = Number(response.headers.get("set-cookie")?.match(/Max-Age=(\d+)/i)?.[1]);
    expect(maxAge).toBe(Math.floor((before.expires_at.getTime() - Date.now()) / 1000));
    expect(response.headers.get("set-cookie")?.includes("HttpOnly")).toBe(true);
    expect(response.headers.get("set-cookie")?.includes("SameSite=Lax")).toBe(true);
  });

  test("the kept browser stays tied to the Cloud Login device that approved its sign-in", async () => {
    const loginDeviceId = await cloudLoginPhone(userId);
    await sql`UPDATE auth.session_families SET app_device_id = ${loginDeviceId}::uuid WHERE sid = ${sid}::uuid`;
    const response = await change(a);
    expect(response.status).toBe(200);
    const newSid = sidOf(cookieToken(response));
    const [kept] = await sql<Array<{ app_device_id: string | null }>>`
      SELECT app_device_id FROM auth.session_families WHERE sid = ${newSid}::uuid
    `;
    // Removing that device with "End its sign-ins" ends the browser sign-ins it approved, the kept one included.
    expect(kept!.app_device_id).toBe(loginDeviceId);
  });

  test("signing out with an old copy of the cookie leaves the kept browser signed in", async () => {
    const rotated = cookieToken(await change(a));
    const logout = await post("/api/auth/logout", a);
    expect(logout.status).toBe(200);
    expect(await session.authenticate(rotated)).toMatchObject({ data: { sid: sidOf(rotated) } });
    expect((await post("/api/auth/logout", rotated)).status).toBe(200);
    expect((await session.authenticate(rotated)) === null).toBe(true);
  });

  test("does not keep a browser whose signing key was revoked", async () => {
    const kid = crypto.randomUUID();
    await sql`
      INSERT INTO auth.signing_keys (
        purpose, state, kid, public_jwk, encrypted_private_jwk, encryption_key_id,
        activate_at, activated_at, sign_until, verify_until, revoked_at, revoke_reason
      ) VALUES (
        'session', 'revoked', ${kid}, ${JSON.stringify({ kty: "RSA", n: "test", e: "AQAB", kid, alg: "RS256" })}::jsonb,
        'integration-test', 'integration-test', now() - INTERVAL '1 day', now() - INTERVAL '1 day',
        now() + INTERVAL '1 day', now() + INTERVAL '1 day', now(), 'test'
      )
    `;
    try {
      // The request authenticated before the key was revoked.
      await sql`UPDATE auth.session_families SET signing_kid = ${kid} WHERE sid = ${sid}::uuid`;
      const result = await session.endOtherSignIns(userId, { keep: { sid, authEpoch: epoch }, reason: "password_change" });
      expect(result.kept === null).toBe(true);
      expect((await family(sid)).signing_kid).toBe(kid);
      for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
    } finally {
      await sql`DELETE FROM auth.session_families WHERE sid = ${sid}::uuid`;
      await sql`DELETE FROM auth.signing_keys WHERE kid = ${kid}`;
    }
  });

  test("wrong current password leaves every sign-in unchanged", async () => {
    watch(spyOn(providers.ipa.auth, "login").mockResolvedValue({ status: "failed" }));
    expect((await change(a)).status).toBe(401);
    expect((await session.authenticate(a)) !== null).toBe(true);
    expect((await session.authenticate(b)) !== null).toBe(true);
    expect(providers.ipa.auth.changePassword).not.toHaveBeenCalled();
  });

  test("a signing failure after the change ends every sign-in and asks this browser to sign in again", async () => {
    watch(
      spyOn(sessionTokens, "signSessionToken").mockImplementationOnce(() => {
        throw new Error("Fixture signing failure");
      }),
    );
    const response = await change(a);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "Password changed. You are signed out everywhere, including this browser. Sign in again.",
      signInAgain: true,
    });
    expect(response.headers.get("set-cookie")).toMatch(/session_token=;[^,]*Max-Age=0/i);
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
    expect((await family(sid)).revocation_reason).toBe("rotated");
    expect(
      await sql`SELECT sid FROM auth.session_families WHERE user_id = ${userId}::uuid
      AND revoked_at IS NOT NULL AND revocation_reason = 'issuance_failed'`,
    ).toHaveLength(1);
  });

  test("a signer that cannot be prepared still ends every sign-in and clears this browser's cookie", async () => {
    watch(spyOn(keyRing, "prepareIdentitySigner").mockRejectedValue(new Error("Fixture signer unavailable")));
    const response = await change(a);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signInAgain: true });
    expect(response.headers.get("set-cookie")).toMatch(/session_token=;[^,]*Max-Age=0/i);
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("retry records one self-service audit event and revokes mobile phones with its own reason", async () => {
    const app = await createTestAppSession(userId);
    const response = await post("/api/me/sign-ins/sign-out-others", a);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signInAgain: false });
    const rotated = cookieToken(response);
    expect(await session.authenticate(rotated)).toMatchObject({ data: { userId } });
    for (const token of [a, b, app.token]) expect((await session.authenticate(token)) === null).toBe(true);
    const rows = await sql`
      SELECT outcome, actor_user_id, actor_uid, actor_provider, target_type, target_id, metadata
      FROM audit.events WHERE action = 'auth.session.sign_out_others' AND actor_user_id = ${userId}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "allowed",
      actor_user_id: userId,
      actor_uid: uid,
      actor_provider: "ipa",
      target_type: "user",
      target_id: userId,
      metadata: { keptThisBrowser: true },
    });
    expect(
      await sql`SELECT id FROM auth.pwa_devices WHERE id = ${app.deviceId}::uuid AND revoked_at IS NOT NULL
      AND revocation_reason = 'sign_out_others'`,
    ).toHaveLength(1);
  });

  test("retry still succeeds when its post-sign-out audit write fails", async () => {
    const failed = watch(spyOn(audit, "record").mockRejectedValue(new Error("Fixture audit unavailable")));
    const response = await post("/api/me/sign-ins/sign-out-others", a);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signInAgain: false });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(await session.authenticate(cookieToken(response))).toMatchObject({ data: { userId } });
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("a signing failure on retry ends every sign-in and clears this browser's cookie", async () => {
    watch(
      spyOn(sessionTokens, "signSessionToken").mockImplementationOnce(() => {
        throw new Error("Fixture signing failure");
      }),
    );
    const response = await post("/api/me/sign-ins/sign-out-others", a);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Other sign-ins ended. Sign in again in this browser.", signInAgain: true });
    expect(response.headers.get("set-cookie")).toMatch(/session_token=;[^,]*Max-Age=0/i);
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("a refused FreeIPA change leaves every sign-in unchanged", async () => {
    watch(spyOn(providers.ipa.auth, "changePassword").mockResolvedValue({ ok: false, error: "Choose a different password.", status: 400 }));
    expect((await change(a)).status).toBe(400);
    expect((await session.authenticate(a)) !== null).toBe(true);
    expect((await session.authenticate(b)) !== null).toBe(true);
  });

  test("a failed sign-out reports the changed password and permits the browser to retry", async () => {
    const failed = watch(spyOn(session, "endOtherSignIns").mockRejectedValue(new Error("Fixture failure")));
    const response = await change(a);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "SIGN_OUT_OTHERS_FAILED",
      message: "Password changed. Signing out your other sign-ins did not work.",
    });
    expect(
      await sql`SELECT id FROM audit.events WHERE action = 'accounts.user.change_own_password' AND actor_user_id = ${userId}::uuid
      AND outcome = 'failed'`,
    ).toHaveLength(1);
    expect((await session.authenticate(b)) !== null).toBe(true);
    const retryFailure = await post("/api/me/sign-ins/sign-out-others", a);
    expect(retryFailure.status).toBe(500);
    expect(await retryFailure.json()).toMatchObject({ code: "SIGN_OUT_OTHERS_FAILED" });
    failed.mockRestore();
    const retry = await post("/api/me/sign-ins/sign-out-others", a);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ signInAgain: false });
    const retried = cookieToken(retry);
    expect(sidOf(retried) === sid).toBe(false);
    expect(await session.authenticate(retried)).toMatchObject({ data: { sid: sidOf(retried) } });
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  const oauthToken = async () => {
    const signer = await keyRing.prepareIdentitySigner("oauth");
    const { issuer } = await getIdentityRuntimeConfig();
    const [user] = await sql`SELECT auth_epoch FROM auth.users WHERE id = ${userId}::uuid`;
    return new SignJWT({
      token_use: "access",
      client_id: "cloud-cli",
      id: userId,
      auth_epoch: Number(user!.auth_epoch),
      scope: "read write",
    })
      .setProtectedHeader({ alg: "RS256", kid: signer.kid, typ: "JWT" })
      .setIssuer(issuer)
      .setAudience("cloud")
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signer.key);
  };

  test("retry requires a browser; OAuth, API keys and app sessions cannot use it", async () => {
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing user");
    const key = await serviceAccountCredentials.createUserApiToken({ user, browserSignIn: { userId, sid }, name: "Existing key" });
    if (!key.ok) throw new Error("Cannot create fixture key");
    const app = await createTestAppSession(userId);
    for (const [token, code] of [
      [await oauthToken(), "BROWSER_SIGN_IN_REQUIRED"],
      [key.data.token, "BROWSER_SIGN_IN_REQUIRED"],
      [app.token, "FORBIDDEN"],
    ]) {
      const response = await me.request("/sign-ins/sign-out-others", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code });
    }
    expect((await session.authenticate(b)) !== null).toBe(true);
  });

  test("a password change through OAuth keeps no browser or OAuth sign-in", async () => {
    const token = await oauthToken();
    const response = await me.request("/password", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "Current-password-1!", newPassword: "New-password-2!", confirmPassword: "New-password-2!" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "Password changed. You are signed out everywhere. Sign in again.",
      signInAgain: true,
    });
    expect(response.headers.has("set-cookie")).toBe(false);
    for (const old of [a, b]) expect((await session.authenticate(old)) === null).toBe(true);
    expect((await me.request("/", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  test("administrator password reset ends sessions and mobile phones, without unpairing Cloud Login", async () => {
    const app = await createTestAppSession(userId);
    watch(spyOn(freeipa.client, "call").mockResolvedValue({ id: 1, result: {}, error: null }));
    const loginDeviceId = await cloudLoginPhone(userId);
    watch(spyOn(providers.ipa.auth, "getServiceSession").mockResolvedValue("fixture"));
    const result = await accounts.users.resetPassword({ id: userId });
    expect(result.ok).toBe(true);
    expect(await sql`SELECT id FROM auth.app_devices WHERE id = ${loginDeviceId}::uuid AND revoked_at IS NULL`).toHaveLength(1);
    for (const token of [a, b, app.token]) expect((await session.authenticate(token)) === null).toBe(true);
    expect(
      await sql`SELECT id FROM auth.pwa_devices WHERE id = ${app.deviceId}::uuid AND revocation_reason = 'password_reset'`,
    ).toHaveLength(1);
  });

  test("administrator reset returns no temporary password if signing out fails", async () => {
    watch(spyOn(freeipa.client, "call").mockResolvedValue({ id: 1, result: {}, error: null }));
    watch(spyOn(session, "endOtherSignIns").mockRejectedValue(new Error("Fixture failure")));
    watch(spyOn(providers.ipa.auth, "getServiceSession").mockResolvedValue("fixture"));
    const result = await accounts.users.resetPassword({ id: userId });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect("data" in result).toBe(false);
  });

  test("expired password change ends older sessions before issuing a new browser session", async () => {
    watch(spyOn(providers.ipa.auth, "changeExpiredPassword").mockResolvedValue({ ok: true, data: undefined }));
    watch(spyOn(providers.ipa.sync, "user").mockResolvedValue({ status: "skipped_disabled" }));
    const response = await post("/api/auth/change-expired-password", a, {
      username: uid,
      currentPassword: "Temporary-password-1!",
      newPassword: "New-password-2!",
      confirmPassword: "New-password-2!",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signOutOthersFailed: false });
    expect(await session.authenticate(cookieToken(response))).toMatchObject({ data: { userId } });
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("an expired password change whose sign-in overlaps a sign-out everywhere gets no session", async () => {
    watch(spyOn(providers.ipa.auth, "changeExpiredPassword").mockResolvedValue({ ok: true, data: undefined }));
    watch(spyOn(providers.ipa.sync, "user").mockResolvedValue({ status: "skipped_disabled" }));
    watch(
      spyOn(providers.ipa.auth, "login").mockImplementation(async () => {
        await session.revokeAllForUser(userId);
        return { status: "success", session: "fixture" };
      }),
    );
    const before = await sql`SELECT sid FROM auth.session_families WHERE user_id = ${userId}::uuid`;
    const response = await post("/api/auth/change-expired-password", a, {
      username: uid,
      currentPassword: "Temporary-password-1!",
      newPassword: "New-password-2!",
      confirmPassword: "New-password-2!",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Your password was changed, but you were signed out everywhere while signing in. Sign in again.",
    });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await sql`SELECT sid FROM auth.session_families WHERE user_id = ${userId}::uuid`).toHaveLength(before.length);
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("expired password change still ends existing sessions when subsequent login fails", async () => {
    watch(spyOn(providers.ipa.auth, "changeExpiredPassword").mockResolvedValue({ ok: true, data: undefined }));
    watch(spyOn(providers.ipa.auth, "login").mockResolvedValue({ status: "failed" }));
    const response = await post("/api/auth/change-expired-password", a, {
      username: uid,
      currentPassword: "Temporary-password-1!",
      newPassword: "New-password-2!",
      confirmPassword: "New-password-2!",
    });
    expect(response.status).toBe(401);
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("expired password sign-out failure issues a browser session that can retry", async () => {
    watch(spyOn(providers.ipa.auth, "changeExpiredPassword").mockResolvedValue({ ok: true, data: undefined }));
    watch(spyOn(providers.ipa.sync, "user").mockResolvedValue({ status: "skipped_disabled" }));
    const failed = watch(spyOn(session, "endOtherSignIns").mockRejectedValue(new Error("Fixture failure")));
    const response = await post("/api/auth/change-expired-password", a, {
      username: uid,
      currentPassword: "Temporary-password-1!",
      newPassword: "New-password-2!",
      confirmPassword: "New-password-2!",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signOutOthersFailed: true });
    const fresh = cookieToken(response);
    expect(await session.authenticate(fresh)).toMatchObject({ data: { userId } });
    expect((await session.authenticate(b)) !== null).toBe(true);
    failed.mockRestore();
    const retry = await post("/api/me/sign-ins/sign-out-others", fresh);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ signInAgain: false });
    const rotated = cookieToken(retry);
    expect(sidOf(rotated)).not.toBe(sidOf(fresh));
    expect(await session.authenticate(rotated)).toMatchObject({ data: { userId } });
    for (const old of [a, b, fresh]) expect((await session.authenticate(old)) === null).toBe(true);
  });

  for (const failing of ["nothing", "the change's sign-out"] as const) {
    test(`reset link ends old sessions, unpairs Cloud Login, also a device paired meanwhile, and issues a new session when ${failing} fails`, async () => {
      const email = `${uid}@example.test`;
      await sql`UPDATE auth.users SET mail = ${email} WHERE id = ${userId}::uuid`;
      const loginDeviceId = await cloudLoginPhone(userId);
      watch(spyOn(freeipa.client, "call").mockResolvedValue({ id: 1, result: {}, error: null }));
      watch(spyOn(providers.ipa.auth, "getServiceSession").mockResolvedValue("fixture"));
      // The old password still works while FreeIPA changes it, so a first Cloud Login device can pair in that time.
      let pairedMeanwhile: string | undefined;
      watch(
        spyOn(providers.ipa.auth, "changeExpiredPassword").mockImplementation(async () => {
          pairedMeanwhile = await cloudLoginPhone(userId);
          return { ok: true, data: undefined };
        }),
      );
      watch(spyOn(providers.ipa.sync, "user").mockResolvedValue({ status: "skipped_disabled" }));
      if (failing !== "nothing") watch(spyOn(session, "endOtherSignIns").mockRejectedValue(new Error("Fixture failure")));
      const token = await providers.local.auth.createPasswordResetToken({ userId, uid, email });
      const response = await post("/api/auth/password-reset/complete", a, {
        token,
        newPassword: "New-password-2!",
        confirmPassword: "New-password-2!",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ signOutOthersFailed: false });
      const fresh = cookieToken(response);
      expect(await session.authenticate(fresh)).toMatchObject({ data: { userId } });
      for (const old of [a, b]) expect((await session.authenticate(old)) === null).toBe(true);
      expect(
        await sql`SELECT id FROM auth.app_devices WHERE id IN (${loginDeviceId}::uuid, ${pairedMeanwhile!}::uuid) AND revoked_at IS NOT NULL`,
      ).toHaveLength(2);
    });
  }

  test("a reset link whose session creation overlaps a sign-out everywhere gets no session", async () => {
    const email = `${uid}@example.test`;
    await sql`UPDATE auth.users SET mail = ${email} WHERE id = ${userId}::uuid`;
    watch(spyOn(freeipa.client, "call").mockResolvedValue({ id: 1, result: {}, error: null }));
    watch(spyOn(providers.ipa.auth, "getServiceSession").mockResolvedValue("fixture"));
    watch(spyOn(providers.ipa.auth, "changeExpiredPassword").mockResolvedValue({ ok: true, data: undefined }));
    watch(spyOn(providers.ipa.sync, "user").mockResolvedValue({ status: "skipped_disabled" }));
    const revokeAll = session.revokeAllForUser;
    let calls = 0;
    watch(
      spyOn(session, "revokeAllForUser").mockImplementation(async (id) => {
        const authEpoch = await revokeAll(id);
        // A separate sign-out lands after the flow's final sign-out, before it issues the browser session.
        if (++calls === 2) await revokeAll(id);
        return authEpoch;
      }),
    );
    const token = await providers.local.auth.createPasswordResetToken({ userId, uid, email });
    const before = await sql`SELECT sid FROM auth.session_families WHERE user_id = ${userId}::uuid`;
    const response = await post("/api/auth/password-reset/complete", a, {
      token,
      newPassword: "New-password-2!",
      confirmPassword: "New-password-2!",
    });
    expect(calls).toBe(2);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Your password was changed, but you were signed out everywhere while signing in. Sign in again.",
    });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await sql`SELECT sid FROM auth.session_families WHERE user_id = ${userId}::uuid`).toHaveLength(before.length);
    for (const old of [a, b]) expect((await session.authenticate(old)) === null).toBe(true);
  });

  test("reset link issues no session when signing out everywhere fails after the change; a new link finishes it", async () => {
    const email = `${uid}@example.test`;
    await sql`UPDATE auth.users SET mail = ${email} WHERE id = ${userId}::uuid`;
    watch(spyOn(freeipa.client, "call").mockResolvedValue({ id: 1, result: {}, error: null }));
    watch(spyOn(providers.ipa.auth, "getServiceSession").mockResolvedValue("fixture"));
    let pairedMeanwhile: string | undefined;
    watch(
      spyOn(providers.ipa.auth, "changeExpiredPassword").mockImplementation(async () => {
        pairedMeanwhile ??= await cloudLoginPhone(userId);
        return { ok: true, data: undefined };
      }),
    );
    watch(spyOn(providers.ipa.sync, "user").mockResolvedValue({ status: "skipped_disabled" }));
    // Signing out everywhere works before the change and fails after it.
    const revokeAll = session.revokeAllForUser;
    const failedRevoke = watch(
      spyOn(session, "revokeAllForUser").mockImplementationOnce(revokeAll).mockRejectedValue(new Error("Fixture failure")),
    );
    const reset = async () =>
      post("/api/auth/password-reset/complete", a, {
        token: await providers.local.auth.createPasswordResetToken({ userId, uid, email }),
        newPassword: "New-password-2!",
        confirmPassword: "New-password-2!",
      });
    const response = await reset();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      message: "Your password was changed, but signing you out everywhere did not work. Request a new reset link to finish.",
    });
    expect(response.headers.has("set-cookie")).toBe(false);
    failedRevoke.mockRestore();
    const again = await reset();
    expect(again.status).toBe(200);
    expect(await session.authenticate(cookieToken(again))).toMatchObject({ data: { userId } });
    expect(await sql`SELECT id FROM auth.app_devices WHERE id = ${pairedMeanwhile!}::uuid AND revoked_at IS NOT NULL`).toHaveLength(1);
  });

  test("reset link leaves the password and sessions unchanged when signing out everywhere fails", async () => {
    const email = `${uid}@example.test`;
    await sql`UPDATE auth.users SET mail = ${email} WHERE id = ${userId}::uuid`;
    const ipaCall = watch(spyOn(freeipa.client, "call").mockResolvedValue({ id: 1, result: {}, error: null }));
    watch(spyOn(providers.ipa.auth, "getServiceSession").mockResolvedValue("fixture"));
    watch(spyOn(session, "revokeAllForUser").mockRejectedValue(new Error("Fixture failure")));
    const token = await providers.local.auth.createPasswordResetToken({ userId, uid, email });
    const response = await post("/api/auth/password-reset/complete", a, {
      token,
      newPassword: "New-password-2!",
      confirmPassword: "New-password-2!",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      message: "Signing you out everywhere did not work, so your password was not changed. Request a new reset link.",
    });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(ipaCall.mock.calls.some(([params]) => params.method === "user_mod")).toBe(false);
    for (const old of [a, b]) expect(await session.authenticate(old)).toMatchObject({ data: { userId } });
  });

  test("retries an inactive prepared signer once without committing the first epoch change", async () => {
    const signer = await keyRing.prepareIdentitySigner("session");
    const prepare = watch(
      spyOn(keyRing, "prepareIdentitySigner")
        .mockResolvedValueOnce({ ...signer, kid: crypto.randomUUID() })
        .mockResolvedValue(signer),
    );
    const before = await family(sid);
    const { kept } = await session.endOtherSignIns(userId, { keep: { sid, authEpoch: epoch }, reason: "password_change" });
    expect(prepare).toHaveBeenCalledTimes(2);
    if (!kept) throw new Error("Missing kept family after retry");
    expect(Number((await family(sidOf(kept.token))).auth_epoch)).toBe(Number(before.auth_epoch) + 1);
    expect(await session.authenticate(kept.token)).toMatchObject({ data: { sid: sidOf(kept.token) } });
    expect((await session.authenticate(b)) === null).toBe(true);
  });

  test("repeatedly inactive prepared signers end all sign-ins after two rolled-back attempts", async () => {
    const signer = await keyRing.prepareIdentitySigner("session");
    const prepare = watch(spyOn(keyRing, "prepareIdentitySigner").mockResolvedValue({ ...signer, kid: crypto.randomUUID() }));
    const before = await family(sid);
    expect(await session.endOtherSignIns(userId, { keep: { sid, authEpoch: epoch }, reason: "password_change" })).toEqual({ kept: null });
    expect(prepare).toHaveBeenCalledTimes(2);
    const [user] = await sql`SELECT auth_epoch FROM auth.users WHERE id = ${userId}::uuid`;
    expect(Number(user!.auth_epoch)).toBe(Number(before.auth_epoch) + 1);
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("replaces the kept family when its signer becomes inactive after commit without renewing the sign-in", async () => {
    await sql`UPDATE auth.session_families
      SET issued_at = now() - interval '11 minutes', created_request_id = 'original-request', created_user_agent = 'original-browser'
      WHERE sid = ${sid}::uuid`;
    const before = await family(sid);
    const [loginBefore] = await sql`SELECT last_login_local FROM auth.users WHERE id = ${userId}::uuid`;
    const browsersBefore = await sql`SELECT id FROM auth.known_browsers WHERE user_id = ${userId}::uuid`;
    const signer = await keyRing.prepareIdentitySigner("session");
    const firstSigner = { ...signer };
    const prepare = watch(spyOn(keyRing, "prepareIdentitySigner").mockResolvedValue(signer).mockResolvedValueOnce(firstSigner));
    const sign = sessionTokens.signSessionToken;
    const signing = watch(
      spyOn(sessionTokens, "signSessionToken").mockImplementationOnce(async (...args) => {
        const signed = await sign(...args);
        // Only the prepared copy changes; the real post-commit check sees an inactive kid.
        firstSigner.kid = crypto.randomUUID();
        return signed;
      }),
    );
    const { kept } = await session.endOtherSignIns(userId, { keep: { sid, authEpoch: epoch }, reason: "password_change" });
    signing.mockRestore();
    expect(prepare).toHaveBeenCalledTimes(2);
    if (!kept) throw new Error("Missing replacement family after retry");
    const newSid = String(decodeJwt(kept.token).sid);
    expect(newSid).not.toBe(sid);
    expect(await session.authenticate(kept.token)).toMatchObject({ data: { sid: newSid, userId, kind: "web" } });
    const after = await family(newSid);
    const [user] = await sql`SELECT auth_epoch, last_login_local FROM auth.users WHERE id = ${userId}::uuid`;
    expect(Number(after.auth_epoch)).toBe(Number(before.auth_epoch) + 1);
    expect(Number(after.auth_epoch)).toBe(Number(user!.auth_epoch));
    expect(after.issued_at).toEqual(before.issued_at);
    expect(after.expires_at).toEqual(before.expires_at);
    expect(kept.expiresAt).toEqual(before.expires_at);
    expect(decodeJwt(kept.token)).toMatchObject({
      iat: Math.floor(before.issued_at.getTime() / 1000),
      exp: Math.floor(before.expires_at.getTime() / 1000),
    });
    expect((await family(sid)).revocation_reason).toBe("rotated");
    expect(
      await sql`SELECT sid FROM auth.session_families WHERE user_id = ${userId}::uuid AND sid NOT IN (${sid}::uuid, ${newSid}::uuid)
      AND revoked_at IS NOT NULL AND revocation_reason = 'signer_revoked_during_issuance'`,
    ).toHaveLength(1);
    const [original] = await sql`SELECT legal_pending FROM auth.session_families WHERE sid = ${sid}::uuid`;
    const [replacement] = await sql`SELECT created_request_id, created_user_agent, legal_pending, pwa_device_id
      FROM auth.session_families WHERE sid = ${newSid}::uuid`;
    expect(replacement).toEqual({
      created_request_id: "original-request",
      created_user_agent: "original-browser",
      legal_pending: original!.legal_pending,
      pwa_device_id: null,
    });
    expect(user!.last_login_local).toEqual(loginBefore!.last_login_local);
    expect(await sql`SELECT id FROM auth.known_browsers WHERE user_id = ${userId}::uuid`).toEqual(browsersBefore);
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
    await expect(
      requireConfirmedBrowserSignIn(sql, { userId, sid: newSid }, (code) => {
        throw new Error(code);
      }),
    ).rejects.toThrow("REAUTHENTICATE");
  });

  test("keeps no browser when its Cloud Login device is removed before the replacement", async () => {
    const loginDeviceId = await cloudLoginPhone(userId);
    await sql`UPDATE auth.session_families SET app_device_id = ${loginDeviceId}::uuid WHERE sid = ${sid}::uuid`;
    const signer = await keyRing.prepareIdentitySigner("session");
    const firstSigner = { ...signer };
    const prepare = watch(
      spyOn(keyRing, "prepareIdentitySigner")
        .mockImplementation(async () => {
          await sql`UPDATE auth.app_devices SET revoked_at = now() WHERE id = ${loginDeviceId}::uuid`;
          return signer;
        })
        .mockResolvedValueOnce(firstSigner),
    );
    const sign = sessionTokens.signSessionToken;
    watch(
      spyOn(sessionTokens, "signSessionToken").mockImplementationOnce(async (...args) => {
        const signed = await sign(...args);
        firstSigner.kid = crypto.randomUUID();
        return signed;
      }),
    );
    const response = await change(a);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signInAgain: true });
    expect(response.headers.get("set-cookie")).toMatch(/session_token=;[^,]*Max-Age=0/i);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(
      await sql`SELECT sid FROM auth.session_families WHERE app_device_id = ${loginDeviceId}::uuid AND revoked_at IS NULL`,
    ).toHaveLength(0);
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("a failed replacement transaction keeps no browser after ending other sign-ins", async () => {
    const signer = await keyRing.prepareIdentitySigner("session");
    const firstSigner = { ...signer };
    const prepare = watch(
      spyOn(keyRing, "prepareIdentitySigner")
        .mockResolvedValueOnce(firstSigner)
        .mockResolvedValueOnce({ ...signer, kid: crypto.randomUUID() }),
    );
    const sign = sessionTokens.signSessionToken;
    watch(
      spyOn(sessionTokens, "signSessionToken").mockImplementationOnce(async (...args) => {
        const signed = await sign(...args);
        firstSigner.kid = crypto.randomUUID();
        return signed;
      }),
    );
    expect(await session.endOtherSignIns(userId, { keep: { sid, authEpoch: epoch }, reason: "password_change" })).toEqual({ kept: null });
    expect(prepare).toHaveBeenCalledTimes(2);
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("does not replace a kept family logged out while its signer becomes inactive", async () => {
    const signer = await keyRing.prepareIdentitySigner("session");
    const firstSigner = { ...signer };
    watch(spyOn(keyRing, "prepareIdentitySigner").mockResolvedValue(signer).mockResolvedValueOnce(firstSigner));
    const sign = sessionTokens.signSessionToken;
    let rotatedSid = "";
    const signing = watch(
      spyOn(sessionTokens, "signSessionToken").mockImplementationOnce(async (params) => {
        const signed = await sign(params);
        rotatedSid = params.sid;
        await sql`UPDATE auth.session_families SET revoked_at = now(), revocation_reason = 'logout' WHERE sid = ${params.sid}::uuid`;
        firstSigner.kid = crypto.randomUUID();
        return signed;
      }),
    );
    const result = await session.endOtherSignIns(userId, { keep: { sid, authEpoch: epoch }, reason: "password_change" });
    signing.mockRestore();
    expect(result.kept === null).toBe(true);
    expect(await sql`SELECT sid FROM auth.session_families WHERE user_id = ${userId}::uuid`).toHaveLength(3);
    expect(await sql`SELECT sid FROM auth.session_families WHERE sid = ${rotatedSid}::uuid AND revocation_reason = 'logout'`).toHaveLength(
      1,
    );
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("a request whose sign-in a concurrent change already ended keeps nothing", async () => {
    const first = await session.endOtherSignIns(userId, { keep: { sid, authEpoch: epoch }, reason: "password_change" });
    if (!first.kept) throw new Error("Missing kept browser");
    // A copy of the cookie authenticated at the old epoch arrives after the change.
    const stale = await session.endOtherSignIns(userId, { keep: { sid, authEpoch: epoch }, reason: "password_change" });
    expect(stale.kept === null).toBe(true);
    for (const token of [a, b, first.kept.token]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("concurrent calls with the same sign-in never both keep a browser", async () => {
    const results = await Promise.all(
      [1, 2].map(() => session.endOtherSignIns(userId, { keep: { sid, authEpoch: epoch }, reason: "password_change" })),
    );
    const accepted = await Promise.all(results.map(async ({ kept }) => (kept ? (await session.authenticate(kept.token)) !== null : false)));
    expect(accepted.filter(Boolean)).toHaveLength(0);
    for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
  });

  test("the retry endpoint gives a copied cookie that a password change already ended no new cookie", async () => {
    const response = await change(a);
    const rotated = cookieToken(response);
    const signIn = await session.authenticate(a);
    expect(signIn === null).toBe(true);
    const copied = await post("/api/me/sign-ins/sign-out-others", a);
    expect(copied.status).toBe(401);
    expect(await session.authenticate(rotated)).toMatchObject({ data: { sid: sidOf(rotated) } });
  });

  for (const kind of ["missing", "other_user", "app", "revoked", "expired", "old_epoch"] as const) {
    test(`does not keep a ${kind} family`, async () => {
      let keepSid = sid;
      let otherUser: string | undefined;
      try {
        if (kind === "missing") keepSid = crypto.randomUUID();
        if (kind === "other_user") {
          otherUser = crypto.randomUUID();
          await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES (${otherUser}::uuid,${`other-${otherUser}`},'ipa','user')`;
          keepSid = String(decodeJwt(await createTestSession(otherUser)).sid);
        }
        if (kind === "app") keepSid = String(decodeJwt((await createTestAppSession(userId)).token).sid);
        if (kind === "revoked") await sql`UPDATE auth.session_families SET revoked_at = now() WHERE sid = ${sid}::uuid`;
        if (kind === "expired")
          await sql`UPDATE auth.session_families SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE sid = ${sid}::uuid`;
        if (kind === "old_epoch") await sql`UPDATE auth.users SET auth_epoch = auth_epoch + 1 WHERE id = ${userId}::uuid`;
        const result = await session.endOtherSignIns(userId, { keep: { sid: keepSid, authEpoch: epoch }, reason: "password_change" });
        expect(result.kept === null).toBe(true);
        for (const token of [a, b]) expect((await session.authenticate(token)) === null).toBe(true);
      } finally {
        if (otherUser) await sql`DELETE FROM auth.users WHERE id = ${otherUser}::uuid`;
      }
    });
  }
});
