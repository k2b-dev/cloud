import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { Hono } from "hono";
import { decodeJwt } from "jose";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import "../../../../scripts/fixtures/authorization-preload";
import { sessionOriginGuard } from "../server/middleware/session-origin";
import { accounts } from "../services/accounts";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { session } from "../services/session";
import { createTestSession } from "../services/session/session.test-fixture";
import { sharedWorkstationCookieName } from "../services/session/shared-workstation";
import * as settings from "../services/settings";
import { createAuthRoutes } from "./auth";
import me from "./me";

const suite = databaseSuite();
const issuer = "http://localhost:3000";
const IDLE_MINUTES = 10;
const MARK = sharedWorkstationCookieName();
const unused = async (): Promise<never> => {
  throw new Error("No notification expected");
};
const router = new Hono()
  .use(sessionOriginGuard())
  .route("/api/me", me)
  .route(
    "/api/auth",
    createAuthRoutes({ sendMagicLink: unused, sendIpaLoginHint: unused, sendPasswordReset: unused, sendNewBrowserSignIn: async () => {} }),
  );

/** A sign-in on this browser, through the same `session.create` every sign-in method uses. */
const signIn = async (userId: string, cookie: string) => {
  const app = new Hono().post("/login", async (c) =>
    c.json({ token: await session.create(c, userId, { method: "password", notify: null }) }),
  );
  const response = await app.request("/login", { method: "POST", headers: { Cookie: cookie } });
  if (response.status !== 200) throw new Error(`Sign-in failed: ${response.status}`);
  const { token } = (await response.json()) as { token: string };
  return { token, setCookies: response.headers.getSetCookie() };
};
const request = (method: string, path: string, cookie: string, body?: unknown, origin: string | undefined = issuer) =>
  router.request(path, {
    method,
    headers: {
      Cookie: cookie,
      ...(origin ? { Origin: origin } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const sidOf = (token: string) => String(decodeJwt(token).sid);
const family = async (token: string) => {
  const [row] = await sql<Array<{ last_input_at: Date | null; revoked_at: Date | null; revocation_reason: string | null }>>`
    SELECT last_input_at, revoked_at, revocation_reason FROM auth.session_families WHERE sid = ${sidOf(token)}::uuid
  `;
  if (!row) throw new Error("Missing session family");
  return row;
};
const idleFor = (token: string, seconds: number) =>
  sql`UPDATE auth.session_families SET last_input_at = now() - ${seconds} * interval '1 second' WHERE sid = ${sidOf(token)}::uuid`;
const cookieNamed = (setCookies: string[], name: string) => setCookies.find((cookie) => cookie.startsWith(`${name}=`));

suite("shared workstation", () => {
  const previous = new Map<string, unknown>();
  const values: Record<string, unknown> = {
    "app.url": issuer,
    "security.rate_limit_per_second": 1000,
    "user.session.shared_workstation_idle_minutes": IDLE_MINUTES,
  };
  let userId: string;
  let otherId: string;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(values)) {
      previous.set(key, await settings.get(key));
      await settings.set(key, value);
    }
  });
  beforeEach(async () => {
    // The server's idle clock is the database's; the test moves `last_input_at`, never waits.
    const [clock] = await sql<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
    userId = crypto.randomUUID();
    otherId = crypto.randomUUID();
    await sql`INSERT INTO auth.users(id, uid, provider, profile) VALUES
      (${userId}::uuid, ${`shared-workstation-${userId}`}, 'local', 'user'),
      (${otherId}::uuid, ${`shared-workstation-${otherId}`}, 'local', 'user')`;
    // Most fixtures stand for established users: consent is recorded.
    await createTestSession(userId);
  });
  afterEach(async () => {
    setSystemTime();
    await sql`DELETE FROM audit.events WHERE actor_user_id IN (${userId}::uuid, ${otherId}::uuid)`;
    await sql`DELETE FROM auth.users WHERE id IN (${userId}::uuid, ${otherId}::uuid)`;
  });
  afterAll(async () => {
    for (const [key, value] of previous) await settings.set(key, value);
  });

  test("an unmarked browser signs in as before: no idle limit and a cookie with its expiry", async () => {
    const { token, setCookies } = await signIn(userId, "login_method=email");
    expect((await family(token)).last_input_at).toBeNull();
    expect(cookieNamed(setCookies, "session_token")).toMatch(/Max-Age=\d+/);
    expect(cookieNamed(setCookies, MARK)).toBeUndefined();
    expect(cookieNamed(setCookies, "login_method")).toBeUndefined();
    expect((await session.authenticate(token))?.data.idle).toBeUndefined();
    // Input reports from an unmarked browser record nothing and start no limit.
    expect((await request("POST", "/api/me/browser/activity", `session_token=${token}`)).status).toBe(200);
    expect((await family(token)).last_input_at).toBeNull();
    const state = await request("GET", "/api/me/browser", `session_token=${token}`, undefined, undefined);
    expect(await state.json()).toEqual({ sharedWorkstation: false, idle: null });
  });

  test("a marked browser signs in with an idle limit, a cookie that ends with the browser, and forgets the sign-in page's memory", async () => {
    const { token, setCookies } = await signIn(userId, `${MARK}=1; login_method=email; login_email=1; login_freeipa_app=1`);
    expect((await family(token)).last_input_at).not.toBeNull();
    expect(cookieNamed(setCookies, "session_token")).not.toMatch(/Max-Age|Expires/);
    expect(cookieNamed(setCookies, MARK)).toMatch(/Max-Age=34560000/);
    for (const name of ["login_method", "login_email", "login_freeipa_app"]) expect(cookieNamed(setCookies, name)).toMatch(/Max-Age=0/);
    const authenticated = await session.authenticate(token);
    expect(authenticated?.data.idle).toEqual({ remainingSeconds: expect.any(Number), timeoutSeconds: IDLE_MINUTES * 60 });
  });

  test("reads, background requests and live checks never extend the session; it ends after the idle limit and stays ended", async () => {
    const { token } = await signIn(userId, `${MARK}=1`);
    await idleFor(token, IDLE_MINUTES * 60 - 30);
    const before = (await family(token)).last_input_at;
    const cookie = `${MARK}=1; session_token=${token}`;
    // What apps do in the background: page and API requests, the shell's state read, stream re-checks.
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await request("GET", "/api/me", cookie, undefined, undefined)).status).toBe(200);
      const state = await request("GET", "/api/me/browser", cookie, undefined, undefined);
      expect(((await state.json()) as { idle: { remainingSeconds: number } }).idle.remainingSeconds).toBeLessThanOrEqual(30);
      expect(await session.authenticateUserId(token)).toBe(userId);
    }
    expect((await family(token)).last_input_at).toEqual(before);

    await idleFor(token, IDLE_MINUTES * 60 + 1);
    expect(await session.authenticate(token)).toBeNull();
    expect(await family(token)).toMatchObject({ revocation_reason: "idle" });
    expect((await request("GET", "/api/me", cookie, undefined, undefined)).status).toBe(401);
    // A late input never revives the session.
    expect((await request("POST", "/api/me/browser/activity", cookie)).status).toBe(401);
    expect(await session.authenticate(token)).toBeNull();
  });

  test("real input extends the session to the full limit", async () => {
    const { token } = await signIn(userId, `${MARK}=1`);
    await idleFor(token, IDLE_MINUTES * 60 - 20);
    const response = await request("POST", "/api/me/browser/activity", `${MARK}=1; session_token=${token}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sharedWorkstation: true,
      idle: { remainingSeconds: IDLE_MINUTES * 60, timeoutSeconds: IDLE_MINUTES * 60 },
    });
    await idleFor(token, IDLE_MINUTES * 60 - 20);
    const state = await request("GET", "/api/me/browser", `${MARK}=1; session_token=${token}`, undefined, undefined);
    expect(((await state.json()) as { idle: { remainingSeconds: number } }).idle.remainingSeconds).toBeGreaterThan(0);
  });

  test("input of one account neither extends nor ends another account's session", async () => {
    const mine = await signIn(userId, `${MARK}=1`);
    await createTestSession(otherId);
    const theirs = await signIn(otherId, `${MARK}=1`);
    await idleFor(theirs.token, 300);
    const before = (await family(theirs.token)).last_input_at;
    expect((await request("POST", "/api/me/browser/activity", `${MARK}=1; session_token=${mine.token}`)).status).toBe(200);
    expect((await family(theirs.token)).last_input_at).toEqual(before);
    expect(await session.authenticate(theirs.token)).not.toBeNull();
  });

  test("the switch marks and unmarks this browser and applies at once to its session", async () => {
    const { token } = await signIn(userId, "login_method=ipa; login_freeipa_app=1");
    const marked = await request("PUT", "/api/me/browser/shared-workstation", `session_token=${token}; login_method=ipa`, { shared: true });
    expect(marked.status).toBe(200);
    expect(await marked.json()).toEqual({
      sharedWorkstation: true,
      idle: { remainingSeconds: IDLE_MINUTES * 60, timeoutSeconds: IDLE_MINUTES * 60 },
    });
    const markedCookies = marked.headers.getSetCookie();
    expect(cookieNamed(markedCookies, MARK)).toMatch(/HttpOnly/);
    expect(cookieNamed(markedCookies, "session_token")).not.toMatch(/Max-Age|Expires/);
    expect(cookieNamed(markedCookies, "login_method")).toMatch(/Max-Age=0/);
    expect((await family(token)).last_input_at).not.toBeNull();

    const unmarked = await request("PUT", "/api/me/browser/shared-workstation", `${MARK}=1; session_token=${token}`, { shared: false });
    expect(unmarked.status).toBe(200);
    expect(await unmarked.json()).toEqual({ sharedWorkstation: false, idle: null });
    expect(cookieNamed(unmarked.headers.getSetCookie(), MARK)).toMatch(/Max-Age=0/);
    expect(cookieNamed(unmarked.headers.getSetCookie(), "session_token")).toMatch(/Max-Age=\d+/);
    expect((await family(token)).last_input_at).toBeNull();
  });

  test("another site cannot flip the switch", async () => {
    const { token } = await signIn(userId, "");
    for (const origin of [undefined, "null", "https://evil.example.test"]) {
      const response = await request("PUT", "/api/me/browser/shared-workstation", `session_token=${token}`, { shared: true }, origin);
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect((await family(token)).last_input_at).toBeNull();
  });

  test("the mark belongs to the browser and outlives sign-out", async () => {
    const { token } = await signIn(userId, `${MARK}=1`);
    const response = await request("POST", "/api/auth/logout", `${MARK}=1; session_token=${token}`);
    expect(response.status).toBe(200);
    expect(cookieNamed(response.headers.getSetCookie(), MARK)).toBeUndefined();
    expect(await session.authenticate(token)).toBeNull();
    // The next person's sign-in on this browser starts with the idle limit again.
    expect((await family((await signIn(userId, `${MARK}=1`)).token)).last_input_at).not.toBeNull();
  });

  test("a session token sent as a bearer can neither lift the limit nor report input", async () => {
    const { token } = await signIn(userId, `${MARK}=1`);
    const before = (await family(token)).last_input_at;
    const bearer = { Authorization: `Bearer ${token}`, Origin: issuer, "Content-Type": "application/json" };
    const unmark = await router.request("/api/me/browser/shared-workstation", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ shared: false }),
    });
    expect(unmark.status).toBe(403);
    expect((await router.request("/api/me/browser/activity", { method: "POST", headers: bearer })).status).toBe(403);
    expect((await family(token)).last_input_at).toEqual(before);
  });

  test("a session that began before the mark gets the limit on its next request on the marked browser", async () => {
    // For example signed in while another tab marked the browser.
    const { token } = await signIn(userId, "");
    expect((await family(token)).last_input_at).toBeNull();
    const response = await request("GET", "/api/me", `${MARK}=1; session_token=${token}`, undefined, undefined);
    expect(response.status).toBe(200);
    expect((await family(token)).last_input_at).not.toBeNull();
    expect(cookieNamed(response.headers.getSetCookie(), "session_token")).not.toMatch(/Max-Age|Expires/);
  });

  test("an idle sign-out ends only the session its tab left, never a newer sign-in", async () => {
    const old = await signIn(userId, `${MARK}=1`);
    const current = await signIn(userId, `${MARK}=1`);
    const headers = { "x-cloud-logout-user": userId, "x-cloud-logout-session": sidOf(old.token) };
    const refused = await router.request("/api/auth/logout", {
      method: "POST",
      headers: { ...headers, Cookie: `session_token=${current.token}`, Origin: issuer },
    });
    expect(refused.status).toBe(409);
    expect(await session.authenticate(current.token)).not.toBeNull();
    const ended = await router.request("/api/auth/logout", {
      method: "POST",
      headers: { ...headers, "x-cloud-logout-session": sidOf(current.token), Cookie: `session_token=${current.token}`, Origin: issuer },
    });
    expect(ended.status).toBe(200);
    expect(await session.authenticate(current.token)).toBeNull();
  });

  test("checks that read the session directly see the idle limit before anyone ends it", async () => {
    const { token } = await signIn(userId, `${MARK}=1`);
    await idleFor(token, IDLE_MINUTES * 60 + 1);
    // Nothing authenticated since, so the family is not revoked yet; a fresh-sign-in check still refuses it.
    expect((await family(token)).revoked_at).toBeNull();
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing user");
    const key = await serviceAccountCredentials
      .createUserApiToken({ user, browserSignIn: { userId, sid: sidOf(token) }, name: "Late key" })
      .catch(() => ({ ok: false as const }));
    expect(key.ok).toBe(false);
  });

  test("API keys and agents are not affected", async () => {
    const { token } = await signIn(userId, `${MARK}=1`);
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing user");
    const key = await serviceAccountCredentials.createUserApiToken({
      user,
      browserSignIn: { userId, sid: sidOf(token) },
      name: "Agent key",
    });
    if (!key.ok) throw new Error("Cannot create fixture key");
    const bearer = { Authorization: `Bearer ${key.data.token}` };
    for (const [method, path] of [
      ["GET", "/browser"],
      ["POST", "/browser/activity"],
    ] as const) {
      const response = await me.request(path, { method, headers: bearer });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "BROWSER_SIGN_IN_REQUIRED" });
    }
    await idleFor(token, IDLE_MINUTES * 60 + 1);
    expect(await session.authenticate(token)).toBeNull();
    expect((await me.request("/", { headers: bearer })).status).toBe(200);
  });
});
