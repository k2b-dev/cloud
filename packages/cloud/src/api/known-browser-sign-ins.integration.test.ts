import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { env } from "../config/env";
import * as requestContext from "../server/request-context";
import { AppApprovalError, appApproval } from "../services/app-approval";
import { authFlows } from "../services/auth-flows";
import {
  type NewBrowserSignInNotifier,
  type NewBrowserSignInNotice,
  type SignInMethod,
  browserHash,
  newBrowserCookie,
} from "../services/known-browsers";
import { session } from "../services/session";
import { loadCurrentUser } from "../services/session/user";
import * as settings from "../services/settings";
import { webauthn } from "../services/webauthn";
import { createAppApprovalRoutes } from "./app-approval";
import { createAuthRoutes } from "./auth";

// Same real authority and route fixtures as legal-consent.integration.test.ts.
// Only credential verification is stubbed; session.create and persistence remain real.
const suite = databaseSuite();
const issuer = "http://localhost:3000";
const NOW = new Date("2026-10-18T12:00:00Z");
const unused = async (): Promise<never> => {
  throw new Error("No messages in this fixture");
};
let notify: NewBrowserSignInNotifier = async () => {};
const handoff: NewBrowserSignInNotifier = (notice) => notify(notice);
const router = new Hono()
  .route(
    "/api/auth",
    createAuthRoutes({ sendMagicLink: unused, sendIpaLoginHint: unused, sendPasswordReset: unused, sendNewBrowserSignIn: handoff }),
  )
  .route("/api/auth/app-approval/v1", createAppApprovalRoutes({ notify: handoff }));
const cookieHeader = (cookie: string) => `${env.IS_DEVELOPMENT ? "cloud_browser" : "__Host-cloud_browser"}=${cookie}`;
const post = (path: string, body: unknown, cookie: string) =>
  router.request(`/api/auth/${path}`, {
    method: "POST",
    headers: {
      Origin: issuer,
      "Content-Type": "application/json",
      cookie: cookieHeader(cookie),
      "x-cloud-locale": "de-AT",
      "x-request-id": "known-browser-route-fixture",
    },
    body: JSON.stringify(body),
  });
const browserRows = (userId: string, cookie: string) => sql`
  SELECT * FROM auth.known_browsers WHERE user_id = ${userId}::uuid AND browser_hash = ${browserHash(userId, cookie)}
`;

const waitsForHandoff = async (start: () => Response | Promise<Response>, method: SignInMethod, device: string | null = null) => {
  const called = Promise.withResolvers<NewBrowserSignInNotice>();
  const release = Promise.withResolvers<void>();
  const received: NewBrowserSignInNotice[] = [];
  notify = async (notice) => {
    received.push(notice);
    called.resolve(notice);
    await release.promise;
  };
  let settled = false;
  const pending = Promise.resolve(start());
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const notice = await Promise.race([
      called.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("No new-browser handoff")), 3000);
      }),
    ]);
    expect(notice).toMatchObject({ method, device, locale: "de-AT", country: "AT", city: "Wien", signedInAt: NOW.toISOString() });
    // The session is committed and visible on another connection, but the response still waits.
    expect(await sql`SELECT sid FROM auth.session_families WHERE user_id = ${notice.userId}::uuid AND revoked_at IS NULL`).not.toHaveLength(
      0,
    );
    await Bun.sleep(20);
    expect(settled).toBe(false);
    expect(received).toHaveLength(1);
  } finally {
    clearTimeout(timer);
    release.resolve();
    await pending;
  }
  return pending;
};

suite("every successful web sign-in route remembers its browser", () => {
  const keys = [
    "app.url",
    "freeipa.enable",
    "user.app_approval.enabled",
    "user.category.login.enabled",
    "user.category.freeipa.enabled",
    "security.rate_limit_per_second",
  ];
  const previous = new Map<string, unknown>();
  let userId: string;
  let previousStart: Date;
  let restoreContext: () => void;
  beforeAll(async () => {
    for (const key of keys) previous.set(key, await settings.get(key));
    await settings.set("app.url", issuer);
    await settings.set("freeipa.enable", true);
    await settings.set("user.app_approval.enabled", true);
    await settings.set("user.category.login.enabled", true);
    await settings.set("user.category.freeipa.enabled", true);
    await settings.set("security.rate_limit_per_second", 1000);
  });
  beforeEach(async () => {
    setSystemTime(NOW);
    notify = async () => {};
    const [state] = await sql<{ started_at: Date }[]>`SELECT started_at FROM auth.device_trust_state`;
    previousStart = state!.started_at;
    await sql`UPDATE auth.device_trust_state SET started_at = ${new Date(NOW.getTime() - 15 * 86_400_000)}`;
    userId = crypto.randomUUID();
    await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${userId}::uuid, ${`browser-route-${userId}`}, 'ipa', 'user')`;
    const describe = requestContext.describeRequest;
    const context = spyOn(requestContext, "describeRequest").mockImplementation((c) =>
      describe(c, {
        geoIp: {
          lookup: () => ({ cityDatabase: true, asnDatabase: false, country: "AT", city: "Wien", network: null }),
          status: () => ({ city: null, asn: null }),
        },
      }),
    );
    restoreContext = () => context.mockRestore();
  });
  afterEach(async () => {
    restoreContext();
    await sql`UPDATE auth.device_trust_state SET started_at = ${previousStart}`;
    setSystemTime();
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });
  afterAll(async () => {
    for (const [key, value] of previous) await settings.set(key, value);
  });

  for (const path of [
    "login",
    "passkeys/authentication/verify",
    "verify-token",
    "password-reset/complete",
    "change-expired-password",
    "app-approval/v1/login/complete",
  ] as const) {
    test(`${path}: writes after success and leaves no rows after failed verification`, async () => {
      const user = await loadCurrentUser({ userId, groupsAdmin: [] });
      if (!user) throw new Error("Missing route fixture user");
      const success = { ok: true, userId, user } as const;
      const failure = { ok: false, status: 401, reason: "invalid_credentials", message: "Invalid credentials" } as const;
      const ipa = spyOn(authFlows.ipa, "login").mockResolvedValue(success);
      const expired = spyOn(authFlows.ipa, "changeExpiredPassword").mockResolvedValue(success);
      const email = spyOn(authFlows.magicLink, "verify").mockResolvedValue({ ...success, email: null, createdGuest: false });
      const reset = spyOn(authFlows.passwordReset, "complete").mockResolvedValue(success);
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
            createdAt: NOW.toISOString(),
            lastUsedAt: null,
          },
        },
      });
      const approval = spyOn(appApproval, "consumeLogin").mockResolvedValue({ userId, deviceName: "Jana’s phone" });
      const create = spyOn(session, "create");
      const cookie = newBrowserCookie();
      const body = {
        login: { username: user.uid, password: "fixture" },
        "passkeys/authentication/verify": { response: {} },
        "verify-token": { token: crypto.randomUUID() },
        "password-reset/complete": { token: crypto.randomUUID(), newPassword: "fixture-password", confirmPassword: "fixture-password" },
        "change-expired-password": {
          username: user.uid,
          currentPassword: "fixture-old",
          newPassword: "fixture-password",
          confirmPassword: "fixture-password",
        },
        "app-approval/v1/login/complete": { requestId: crypto.randomUUID(), browserSecret: "a".repeat(42) + "A" },
      }[path];
      try {
        const methods = {
          login: "password",
          "passkeys/authentication/verify": "passkey",
          "verify-token": "email_code",
          "password-reset/complete": "password_reset",
          "change-expired-password": "expired_password",
          "app-approval/v1/login/complete": "cloud_login",
        } as const;
        const response = await waitsForHandoff(
          () => post(path, body, cookie),
          methods[path],
          path === "app-approval/v1/login/complete" ? "Jana’s phone" : null,
        );
        if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
        expect(create).toHaveBeenCalledTimes(1);
        expect(await browserRows(userId, cookie)).toHaveLength(1);
        expect(response.headers.get("set-cookie")).toContain(cookieHeader(cookie));
        expect(await sql<{ country: string }[]>`SELECT country FROM auth.sign_in_countries WHERE user_id = ${userId}::uuid`).toEqual([
          { country: "AT" },
        ]);
        await sql`DELETE FROM auth.known_browsers WHERE user_id = ${userId}::uuid`;
        await sql`DELETE FROM auth.sign_in_countries WHERE user_id = ${userId}::uuid`;
        ipa.mockResolvedValue(failure);
        expired.mockResolvedValue(failure);
        email.mockResolvedValue({ ok: false, status: 401, message: "Invalid token" });
        reset.mockResolvedValue({ ok: false, status: 401, reason: "invalid_or_expired", message: "Invalid token" });
        passkey.mockResolvedValue({ ok: false, error: { code: "INVALID", status: 401, message: "Invalid proof" } });
        approval.mockRejectedValue(new AppApprovalError("CONFLICT", 409));
        const refused = await post(path, body, cookie);
        expect(refused.status).toBe(path === "app-approval/v1/login/complete" ? 409 : 401);
        expect(create).toHaveBeenCalledTimes(1);
        expect(refused.headers.get("set-cookie")).toBeNull();
        expect(await browserRows(userId, cookie)).toHaveLength(0);
        expect(await sql`SELECT country FROM auth.sign_in_countries WHERE user_id = ${userId}::uuid`).toHaveLength(0);
      } finally {
        for (const spy of [ipa, expired, email, reset, passkey, approval, create]) spy.mockRestore();
      }
    });
  }

  test("verify-token: a newly created guest remembers the browser without a sign-in notice", async () => {
    const user = await loadCurrentUser({ userId, groupsAdmin: [] });
    if (!user) throw new Error("Missing route fixture user");
    const email = spyOn(authFlows.magicLink, "verify").mockResolvedValue({ ok: true, userId, user, email: null, createdGuest: true });
    const sender = { notify: async () => {} };
    const notification = spyOn(sender, "notify");
    notify = sender.notify;
    const cookie = newBrowserCookie();
    try {
      const response = await post("verify-token", { token: crypto.randomUUID() }, cookie);
      expect(response.ok).toBe(true);
      expect(notification).not.toHaveBeenCalled();
      const rows = await browserRows(userId, cookie);
      expect(rows).toHaveLength(1);
      expect(rows[0].notified_at).not.toBeNull();
      expect(rows[0].notice).toBeNull();
    } finally {
      email.mockRestore();
      notification.mockRestore();
    }
  });

  test("admin-login: real emergency login remembers the browser only with the right token", async () => {
    const originalToken = process.env.ADMIN_LOGIN_TOKEN;
    const [before] = await sql<{ id: string; provider: string; profile: string; admin: boolean }[]>`
      SELECT id, provider, profile, admin FROM auth.users WHERE uid = 'admin'
    `;
    const token = "known-browser-admin-fixture";
    process.env.ADMIN_LOGIN_TOKEN = token;
    const cookie = newBrowserCookie();
    const create = spyOn(session, "create");
    const [countryBefore] = before
      ? await sql<
          { last_seen_at: Date }[]
        >`SELECT last_seen_at FROM auth.sign_in_countries WHERE user_id = ${before.id}::uuid AND country = 'AT'`
      : [];
    let adminId: string | undefined;
    try {
      const refused = await post("admin-login", { token: "wrong-token" }, cookie);
      expect(refused.status).toBe(401);
      expect(create).not.toHaveBeenCalled();
      expect(refused.headers.get("set-cookie")).toBeNull();
      expect(await sql`SELECT id FROM auth.known_browsers WHERE browser_hash = ${browserHash(before?.id ?? userId, cookie)}`).toHaveLength(
        0,
      );
      const response = await waitsForHandoff(() => post("admin-login", { token }, cookie), "admin_token");
      if (!response.ok) throw new Error(`admin-login: ${response.status} ${await response.text()}`);
      const [admin] = await sql<{ id: string }[]>`SELECT id FROM auth.users WHERE uid = 'admin'`;
      adminId = admin!.id;
      expect(create).toHaveBeenCalledTimes(1);
      expect(await browserRows(adminId, cookie)).toHaveLength(1);
      expect(response.headers.get("set-cookie")).toContain(cookieHeader(cookie));
    } finally {
      create.mockRestore();
      if (originalToken === undefined) delete process.env.ADMIN_LOGIN_TOKEN;
      else process.env.ADMIN_LOGIN_TOKEN = originalToken;
      if (before) {
        await sql`UPDATE auth.users SET provider = ${before.provider}, profile = ${before.profile}, admin = ${before.admin} WHERE id = ${before.id}::uuid`;
        if (adminId) {
          if (countryBefore)
            await sql`UPDATE auth.sign_in_countries SET last_seen_at = ${countryBefore.last_seen_at} WHERE user_id = ${adminId}::uuid AND country = 'AT'`;
          else await sql`DELETE FROM auth.sign_in_countries WHERE user_id = ${adminId}::uuid AND country = 'AT'`;
          await sql`DELETE FROM auth.known_browsers WHERE user_id = ${adminId}::uuid AND browser_hash = ${browserHash(adminId, cookie)}`;
          await sql`DELETE FROM auth.session_families WHERE user_id = ${adminId}::uuid AND created_request_id = 'known-browser-route-fixture'`;
        }
      } else await sql`DELETE FROM auth.users WHERE uid = 'admin'`;
    }
  });

  test("Cloud Login start for an unknown identifier stores no browser or country for any account", async () => {
    const [before] = await sql<{ browsers: number; countries: number }[]>`SELECT
      (SELECT count(*)::int FROM auth.known_browsers) AS browsers,
      (SELECT count(*)::int FROM auth.sign_in_countries) AS countries`;
    const create = spyOn(session, "create");
    try {
      const response = await post(
        "app-approval/v1/login/start",
        { identifier: "unknown-browser-fixture@example.test", category: "login" },
        newBrowserCookie(),
      );
      expect(response.status).toBe(202);
      expect(create).not.toHaveBeenCalled();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(
        await sql<{ browsers: number; countries: number }[]>`SELECT
        (SELECT count(*)::int FROM auth.known_browsers) AS browsers,
        (SELECT count(*)::int FROM auth.sign_in_countries) AS countries`,
      ).toEqual([before!]);
    } finally {
      create.mockRestore();
    }
  });
});
