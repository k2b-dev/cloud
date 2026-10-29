import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { AppApprovalError, appApproval } from "../services/app-approval";
import { authFlows } from "../services/auth-flows";
import { session } from "../services/session";
import { requireRecentWebSession } from "../services/session/recent";
import { createTestSession } from "../services/session/session.test-fixture";
import * as settings from "../services/settings";
import { webauthn } from "../services/webauthn";
import { createAppApprovalRoutes } from "./app-approval";
import { createAuthRoutes } from "./auth";

const suite = databaseSuite();
const issuer = "https://cloud.example.test";
const unused = async (): Promise<never> => {
  throw new Error("No mail in this fixture");
};
const notify = async () => {};
const routes = new Hono()
  .route(
    "/auth",
    createAuthRoutes({ sendMagicLink: unused, sendIpaLoginHint: unused, sendPasswordReset: unused, sendNewBrowserSignIn: notify }),
  )
  .route("/auth/app-approval/v1", createAppApprovalRoutes({ notify }));
const spies: Array<{ mockRestore(): void }> = [];
const ids: string[] = [];
const person = async () => {
  const id = crypto.randomUUID();
  ids.push(id);
  await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES (${id}::uuid,${`reauth-${id}`},'local','user')`;
  const token = await createTestSession(id);
  const authenticated = await session.authenticate(token);
  if (!authenticated) throw new Error("Missing fixture session");
  return { id, token, ...authenticated };
};
const fresh = (userId: string, sid: string) =>
  sql.begin((tx) =>
    requireRecentWebSession(tx, { userId, sid }, 600, (code) => {
      throw new Error(code);
    }),
  );
const post = (path: string, body: unknown, token: string, confirmation = true) =>
  routes.request(`/auth/${path}`, {
    method: "POST",
    headers: {
      Origin: issuer,
      Cookie: `session_token=${token}`,
      "Content-Type": "application/json",
      "Accept-Language": "de",
      ...(confirmation ? { "X-Cloud-Reauthenticate": "1" } : {}),
    },
    body: JSON.stringify(body),
  });

suite("confirm identity through each browser credential", () => {
  const previous = new Map<string, unknown>();
  beforeAll(async () => {
    for (const [key, value] of Object.entries({
      "app.url": issuer,
      "freeipa.enable": true,
      "user.app_approval.enabled": true,
      "security.rate_limit_per_second": 1000,
    })) {
      previous.set(key, await settings.get(key));
      await settings.set(key, value);
    }
  });
  beforeEach(async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
  });
  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const id of ids.splice(0)) await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    setSystemTime();
  });
  afterAll(async () => {
    for (const [key, value] of previous) await settings.set(key, value);
  });

  test("confirmation rejects recovery before changing credentials", async () => {
    const owner = await person();
    const reset = spyOn(authFlows.passwordReset, "complete");
    const expired = spyOn(authFlows.ipa, "changeExpiredPassword");
    spies.push(reset, expired);
    for (const path of ["password-reset/complete", "change-expired-password", "admin-login"]) {
      const response = await post(path, {}, owner.token);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "CONFIRMATION_METHOD_UNAVAILABLE" });
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    expect(reset).not.toHaveBeenCalled();
    expect(expired).not.toHaveBeenCalled();

    // Ordinary recovery remains an explicit account choice, even with another browser account open.
    const recovered = await person();
    const success = { ok: true, userId: recovered.id, user: recovered.user, authEpoch: 0, signOutOthersFailed: false } as const;
    reset.mockResolvedValue(success);
    expired.mockResolvedValue(success);
    for (const [path, body] of [
      ["password-reset/complete", { token: crypto.randomUUID(), newPassword: "fixture-password", confirmPassword: "fixture-password" }],
      [
        "change-expired-password",
        {
          username: recovered.user.uid,
          currentPassword: "fixture-old",
          newPassword: "fixture-password",
          confirmPassword: "fixture-password",
        },
      ],
    ] as const) {
      const response = await post(path, body, owner.token, false);
      expect(response.status).toBe(200);
      const token = /session_token=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
      expect((await session.authenticate(token!))?.user.id).toBe(recovered.id);
    }
    expect(reset).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  for (const path of ["login", "verify-token", "passkeys/authentication/verify", "app-approval/v1/login/complete"] as const) {
    test(`${path}: requires fresh proof of the same account`, async () => {
      const owner = await person();
      const other = await person();
      await sql`UPDATE auth.session_families SET issued_at=now()-interval '11 minutes' WHERE sid=${owner.data.sid}::uuid`;
      await expect(fresh(owner.id, owner.data.sid)).rejects.toThrow("REAUTHENTICATE");
      const ipa = spyOn(authFlows.ipa, "login");
      const email = spyOn(authFlows.magicLink, "verify");
      const passkey = spyOn(webauthn, "finishAuthentication");
      const approval = spyOn(appApproval, "consumeLogin");
      spies.push(ipa, email, passkey, approval);
      const deviceId = crypto.randomUUID();
      await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted)
        VALUES (${deviceId}::uuid,${issuer},${owner.id}::uuid,'Fixture','{}',false)`;
      const prove = (account: typeof owner) => {
        ipa.mockResolvedValue({ ok: true, userId: account.id, user: account.user, authEpoch: 0 });
        email.mockResolvedValue({ ok: true, userId: account.id, user: account.user, email: null, createdGuest: false });
        passkey.mockResolvedValue({
          ok: true,
          data: {
            user: account.user,
            passkey: {
              id: crypto.randomUUID(),
              userId: account.id,
              name: "Fixture",
              transports: [],
              deviceType: null,
              backedUp: false,
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
            },
          },
        });
        approval.mockResolvedValue({ userId: account.id, authEpoch: 0, deviceId, deviceName: "Fixture" });
      };
      const body = {
        login: { username: owner.user.uid, password: "fixture" },
        "verify-token": { token: crypto.randomUUID() },
        "passkeys/authentication/verify": { response: {} },
        "app-approval/v1/login/complete": { requestId: crypto.randomUUID(), browserSecret: "a".repeat(42) + "A" },
      }[path];
      prove(other);
      // Ordinary sign-in is an explicit account choice, outside confirmation.
      if (path !== "app-approval/v1/login/complete") {
        const ordinary = await post(path, body, owner.token, false);
        expect(ordinary.status).toBe(200);
        const ordinaryToken = /session_token=([^;]+)/.exec(ordinary.headers.get("set-cookie") ?? "")?.[1];
        expect((await session.authenticate(ordinaryToken!))?.user.id).toBe(other.id);
      }
      const before = await sql`SELECT sid FROM auth.session_families WHERE user_id=${other.id}::uuid`;
      const mismatch = await post(path, body, owner.token);
      expect(mismatch.status).toBe(403);
      expect(await mismatch.json()).toMatchObject({ code: "ACCOUNT_MISMATCH", message: expect.stringContaining("Melde dich") });
      expect(mismatch.headers.has("set-cookie")).toBe(false);
      expect((await session.authenticate(owner.token))?.user.id).toBe(owner.id);
      expect(await sql`SELECT sid FROM auth.session_families WHERE user_id=${other.id}::uuid`).toHaveLength(before.length);

      ipa.mockResolvedValue({ ok: false, reason: "invalid_credentials", message: "Invalid credentials", status: 401 });
      email.mockResolvedValue({ ok: false, message: "Invalid token", status: 401 });
      passkey.mockResolvedValue({ ok: false, error: { code: "INVALID", message: "Invalid proof", status: 401 } });
      approval.mockRejectedValue(new AppApprovalError("CONFLICT", 409));
      const invalid = await post(path, body, owner.token);
      expect(invalid.status).toBe(path.startsWith("app-approval") ? 409 : 401);
      expect(invalid.headers.has("set-cookie")).toBe(false);
      await expect(fresh(owner.id, owner.data.sid)).rejects.toThrow("REAUTHENTICATE");

      prove(owner);
      const success = await post(path, body, owner.token);
      expect(success.status).toBe(path.startsWith("app-approval") ? 204 : 200);
      const token = /session_token=([^;]+)/.exec(success.headers.get("set-cookie") ?? "")?.[1];
      expect(token).toBeDefined();
      const renewed = await session.authenticate(token!);
      expect(renewed?.user.id).toBe(owner.id);
      expect(renewed?.data.sid).not.toBe(owner.data.sid);
      await expect(fresh(owner.id, renewed!.data.sid)).resolves.toMatchObject({ id: owner.id });
      // Visiting or reusing the old session itself never refreshes its sign-in time.
      await expect(fresh(owner.id, owner.data.sid)).rejects.toThrow("REAUTHENTICATE");
    });
  }
});
