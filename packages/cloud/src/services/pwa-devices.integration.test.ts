import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { createAppApprovalRoutes } from "../api/app-approval";
import meRoutes from "../api/me";
import { createPwaRoutes } from "../api/pwa";
import { createPwaPhoneRoutes } from "../api/pwa-phone";
import { APP_APPROVAL_PATH } from "../contracts/app-approval";
import { PWA_API_PATH, PWA_AUTH_PATH, PWA_LIMITS } from "../contracts/pwa";
import { type AuthContext, auth } from "../server";
import { resolveInvocationAuthority } from "./identity/invocation-actor";
import { invocationAuthorityFromRequest } from "./identity/invocation-authority";
import { revokeIdentitySigningKey } from "./identity/key-ring";
import { invalidateIdentityRuntimeConfig } from "./identity/runtime-config";
import { toPgUuidArray } from "./postgres";
import { pwaDevices } from "./pwa-devices";
import { session } from "./session";
import { requireRecentWebSession } from "./session/recent";
import { createTestAppSession, createTestSession } from "./session/session.test-fixture";
import * as settings from "./settings";

// Never migrate or mutate the development installation.
const suite = suiteFor("database", "nats", "valkey");
const ORIGIN = "https://cloud.example.test";

let shell = true;
const routes = new Hono<AuthContext>()
  .route(PWA_API_PATH, createPwaRoutes({ shellAvailable: () => shell }))
  .route(PWA_AUTH_PATH, createPwaPhoneRoutes({ shellAvailable: () => shell }))
  .route("/api/me", meRoutes)
  .route(APP_APPROVAL_PATH, createAppApprovalRoutes())
  // Another application's validator: the ordinary auth middleware of any app.
  .get("/pwa/probe", auth.requireRole("authenticated"), (c) =>
    c.json({ userId: c.get("user").id, kind: c.get("sessionKind"), roles: c.get("user").roles }),
  )
  .get("/api/probe", auth.requireRole("authenticated"), (c) => c.json({ userId: c.get("user").id, kind: c.get("sessionKind") }));

/** One cookie jar: a phone's Home Screen app, or a browser. Honours paths, Max-Age=0 and deletion. */
class Jar {
  readonly cookies = new Map<string, { value: string; path: string; attributes: string }>();
  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) this.cookies.set(name, { value, path: "/", attributes: "" });
  }
  header(path: string) {
    return [...this.cookies]
      .filter(([, cookie]) => cookie.path === "/" || path === cookie.path || path.startsWith(`${cookie.path}/`))
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join("; ");
  }
  store(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map((part) => part.trim());
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      const path = attributes.find((attribute) => attribute.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
      if (!value || attributes.some((attribute) => /^max-age=0$/i.test(attribute))) this.cookies.delete(name!);
      else this.cookies.set(name!, { value, path, attributes: attributes.join("; ") });
    }
  }
  get(name: string) {
    return this.cookies.get(name)?.value;
  }
}

const call = async (
  jar: Jar,
  method: string,
  path: string,
  options: { body?: unknown; origin?: string | null; headers?: Record<string, string> } = {},
) => {
  const headers: Record<string, string> = { "x-forwarded-for": uniqueCallerAddress(), ...options.headers };
  const cookie = jar.header(path.split("?")[0]!);
  if (cookie) headers.cookie = cookie;
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await routes.request(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  jar.store(response);
  return response;
};
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const typed = async <T>(response: Response) => (await response.json()) as T;

const users: string[] = [];
const person = async (options: { admin?: boolean; name?: string } = {}) => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, admin)
    VALUES (${id}::uuid, ${`pwa-${id}`}, 'local', 'user', ${options.name ?? "Ada Example"}, ${options.admin ?? false})`;
  users.push(id);
  const token = await createTestSession(id);
  const [family] = await sql<
    { sid: string }[]
  >`SELECT sid FROM auth.session_families WHERE user_id = ${id}::uuid ORDER BY issued_at DESC LIMIT 1`;
  return { id, token, sid: family!.sid, web: new Jar({ session_token: token }) };
};
type Person = Awaited<ReturnType<typeof person>>;

const startPairing = async (owner: Person) => {
  const response = await call(owner.web, "POST", `${PWA_API_PATH}/pairings`);
  expect(response.status).toBe(201);
  return typed<{ id: string; secret: string; claimUntil: string; expiresAt: string }>(response);
};
const claim = (phone: Jar, secret: string, platform: "ios" | "android" | "other" = "ios") =>
  call(phone, "POST", `${PWA_AUTH_PATH}/pairings/claim`, { body: { secret, platform }, headers: { "user-agent": "Mozilla/5.0 (iPhone)" } });
const complete = (phone: Jar) => call(phone, "POST", `${PWA_AUTH_PATH}/pairings/complete`);
const confirm = (owner: Person, id: string, code: string) =>
  call(owner.web, "POST", `${PWA_API_PATH}/pairings/${id}/confirm`, { body: { code } });
const renew = (phone: Jar) => call(phone, "POST", `${PWA_AUTH_PATH}/session/renew`);
const probe = (phone: Jar) => call(phone, "GET", "/pwa/probe", { origin: null, headers: { "sec-fetch-mode": "navigate" } });
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

/** A complete link pairing with the typed code. */
const pair = async (owner: Person, phone = new Jar(), platform: "ios" | "android" | "other" = "ios") => {
  const started = await startPairing(owner);
  const claimed = await typed<{ code: string }>(await claim(phone, started.secret, platform));
  expect((await confirm(owner, started.id, claimed.code)).status).toBe(204);
  const completed = await complete(phone);
  expect(completed.status).toBe(200);
  const deviceId = phone.get("pwa_device")!.split(".")[0]!;
  return { phone, deviceId, pairingId: started.id };
};

suite("mobile app pairing and app sessions", () => {
  let previousUrl: unknown;
  beforeAll(async () => {
    previousUrl = await settings.get("app.url");
    await settings.set("app.url", ORIGIN);
    await settings.set("security.rate_limit_per_second", 10000);
    invalidateIdentityRuntimeConfig();
  });
  beforeEach(async () => {
    shell = true;
    for (const category of ["guest", "login", "freeipa"]) await settings.remove(`user.category.${category}.enabled`);
  });
  afterAll(async () => {
    if (typeof previousUrl === "string") await settings.set("app.url", previousUrl);
    invalidateIdentityRuntimeConfig();
    if (users.length) await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(users)}::uuid[])`;
  });

  test("a link pairing with the typed code yields a device key and an app session that other apps accept", async () => {
    const owner = await person();
    const phone = new Jar({ session_token: owner.token });
    const started = await startPairing(owner);
    expect(started.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const claimResponse = await claim(phone, started.secret);
    expect(claimResponse.status).toBe(200);
    const claimed = await typed<{ code: string; account: { name: string } }>(claimResponse);
    expect(claimed.account.name).toBe("Ada Example");
    const pairingCookie = phone.cookies.get("pwa_pairing")!;
    expect(pairingCookie.path).toBe("/pwa/_auth/pairings");
    expect(pairingCookie.attributes).toContain("HttpOnly");
    expect(pairingCookie.attributes).toContain("SameSite=Strict");

    // The web never sees the code; the phone waits until the person types it.
    const status = await json(await call(owner.web, "GET", `${PWA_API_PATH}/pairings/${started.id}`, { origin: null }));
    expect(status).toMatchObject({ state: "claimed", device: { name: "iPhone", platform: "ios" }, attemptsLeft: 3 });
    expect(JSON.stringify(status)).not.toContain(claimed.code);
    const waiting = await complete(phone);
    expect(waiting.status).toBe(202);
    expect(await json(waiting)).toMatchObject({ state: "waiting", code: claimed.code });

    expect((await confirm(owner, started.id, claimed.code)).status).toBe(204);
    const completed = await complete(phone);
    expect(completed.status).toBe(200);
    expect(completed.headers.get("cache-control")).toBe("no-store");
    expect(completed.headers.get("referrer-policy")).toBe("no-referrer");
    expect(phone.get("pwa_pairing")).toBeUndefined();
    // On iOS the Home Screen app's copy of the Safari session goes.
    expect(phone.get("session_token")).toBeUndefined();
    const device = phone.cookies.get("pwa_device")!;
    expect(device.path).toBe("/pwa/_auth");
    expect(device.attributes).toContain("HttpOnly");
    expect(device.attributes).toContain(`Max-Age=${PWA_LIMITS.idleDays * 86_400}`);
    expect(phone.cookies.get("pwa_session")).toMatchObject({ path: "/" });
    expect(phone.cookies.get("pwa_session")!.attributes).toContain(`Max-Age=${PWA_LIMITS.sessionSeconds}`);

    expect(await json(await probe(phone))).toMatchObject({ userId: owner.id, kind: "app" });
    expect((await call(phone, "GET", "/api/probe", { origin: null })).status).toBe(200);

    const list = await typed<{ items: { id: string; name: string; current: boolean }[] }>(
      await call(owner.web, "GET", `${PWA_API_PATH}/devices`, { origin: null }),
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ name: "iPhone", current: false });

    const audits = await sql<{ action: string; metadata: unknown }[]>`
      SELECT action, metadata FROM audit.events WHERE actor_user_id = ${owner.id}::uuid AND action LIKE 'auth.pwa.%' ORDER BY id`;
    expect(audits.map((row) => row.action)).toEqual(["auth.pwa.pairing.start", "auth.pwa.pairing.confirm", "auth.pwa.device.enroll"]);
    const recorded = JSON.stringify(audits);
    for (const value of [started.secret, claimed.code, device.value, phone.get("pwa_session")!]) expect(recorded).not.toContain(value);
  });

  test("without the mobile app nothing pairs or renews, while removal and sign-out still work", async () => {
    const owner = await person();
    const { phone, deviceId } = await pair(owner);
    shell = false;
    const unavailable = await call(owner.web, "POST", `${PWA_API_PATH}/pairings`);
    expect(unavailable.status).toBe(503);
    expect(await json(unavailable)).toMatchObject({ code: "UNAVAILABLE" });
    expect((await claim(new Jar(), "A".repeat(43))).status).toBe(503);
    expect((await complete(phone)).status).toBe(503);
    expect((await renew(phone)).status).toBe(503);
    expect(phone.get("pwa_device")).toBeDefined();
    const launch = await call(phone, "GET", `${PWA_AUTH_PATH}/session/launch?to=%2Fpwa%2F`, { origin: null });
    expect(launch.headers.get("location")).toBe("/pwa/?pwa=unavailable");
    expect((await call(owner.web, "GET", `${PWA_API_PATH}/devices`, { origin: null })).status).toBe(200);
    expect((await call(phone, "PATCH", `${PWA_AUTH_PATH}/session`, { body: { name: "Work phone" } })).status).toBe(204);
    expect((await call(owner.web, "DELETE", `${PWA_API_PATH}/devices/${deviceId}`)).status).toBe(204);
    expect((await probe(phone)).status).toBe(401);
    expect((await call(phone, "DELETE", `${PWA_AUTH_PATH}/session`)).status).toBe(204);
    expect(phone.get("pwa_device")).toBeUndefined();
  });

  test("transport: Origin from app.url on every non-GET, no forwarded headers, body limit", async () => {
    const jar = new Jar();
    expect((await call(jar, "DELETE", `${PWA_AUTH_PATH}/session`, { origin: null })).status).toBe(403);
    expect((await call(jar, "DELETE", `${PWA_AUTH_PATH}/session`, { origin: "https://evil.example.test" })).status).toBe(403);
    // The gateway's real header shape: plain HTTP inside, the browser's https Origin outside.
    const behindGateway = await call(jar, "DELETE", `${PWA_AUTH_PATH}/session`, {
      headers: { "x-forwarded-proto": "http", "x-forwarded-host": "app-core:3000" },
    });
    expect(behindGateway.status).toBe(204);
    expect(behindGateway.headers.get("vary")).toContain("Origin");
    const big = await call(jar, "POST", `${PWA_AUTH_PATH}/pairings/claim`, {
      body: { secret: "A".repeat(PWA_LIMITS.bodyBytes), platform: "ios" },
    });
    expect(big.status).toBe(400);
    expect(await json(big)).toMatchObject({ code: "INVALID_REQUEST" });
    const owner = await person();
    // API keys and OAuth tokens never manage phones.
    const bearer = await call(owner.web, "GET", `${PWA_API_PATH}/devices`, {
      origin: null,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(await json(bearer)).toMatchObject({ code: "FORBIDDEN" });
  });

  test("starting needs a recent web sign-in and is capped at five open pairings", async () => {
    const owner = await person();
    await sql`UPDATE auth.session_families SET issued_at = now() - interval '11 minutes' WHERE sid = ${owner.sid}::uuid`;
    expect(await json(await call(owner.web, "POST", `${PWA_API_PATH}/pairings`))).toMatchObject({ code: "REAUTHENTICATE" });
    const fresh = await person();
    for (let index = 0; index < PWA_LIMITS.pendingPerAccount; index += 1) await startPairing(fresh);
    const capped = await call(fresh.web, "POST", `${PWA_API_PATH}/pairings`);
    expect(capped.status).toBe(429);
    expect(await json(capped)).toMatchObject({ code: "LIMIT_REACHED" });
  });

  test("a link can be claimed once and only within its claim window", async () => {
    const owner = await person();
    const started = await startPairing(owner);
    expect((await claim(new Jar(), started.secret)).status).toBe(200);
    const again = await claim(new Jar(), started.secret);
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: "ALREADY_USED" });

    const late = await startPairing(owner);
    await sql`UPDATE auth.pwa_pairings SET claim_until = now() - interval '1 second' WHERE id = ${late.id}::uuid`;
    expect(await json(await claim(new Jar(), late.secret))).toMatchObject({ code: "EXPIRED" });
    expect((await call(owner.web, "GET", `${PWA_API_PATH}/pairings/${late.id}`, { origin: null })).status).toBe(410);
    expect(await json(await claim(new Jar(), "B".repeat(43)))).toMatchObject({ code: "EXPIRED" });
  });

  test("three wrong codes cancel the pairing; only the initiating session may confirm", async () => {
    const owner = await person();
    const phone = new Jar();
    const started = await startPairing(owner);
    const { code } = await typed<{ code: string }>(await claim(phone, started.secret));

    const otherSession = { ...owner, web: new Jar({ session_token: await createTestSession(owner.id) }) };
    expect((await confirm(otherSession, started.id, code)).status).toBe(404);

    const first = await confirm(owner, started.id, wrong(code));
    expect(first.status).toBe(409);
    expect(await json(first)).toMatchObject({ code: "WRONG_CODE", attemptsLeft: 2 });
    expect(await json(await confirm(owner, started.id, wrong(code)))).toMatchObject({ code: "WRONG_CODE", attemptsLeft: 1 });
    const third = await confirm(owner, started.id, wrong(code));
    expect(third.status).toBe(410);
    expect(await json(third)).toMatchObject({ code: "EXPIRED" });
    expect((await confirm(owner, started.id, code)).status).toBe(410);
    expect((await complete(phone)).status).toBe(410);
    expect(phone.get("pwa_pairing")).toBeUndefined();
    const [cancel] = await sql<{ metadata: { reason: string } }[]>`
      SELECT metadata FROM audit.events WHERE action = 'auth.pwa.pairing.cancel' AND target_id = ${started.id}`;
    expect(cancel?.metadata.reason).toBe("wrong_code");
  });

  test("signing out on the web or everywhere voids a running pairing", async () => {
    const owner = await person();
    const phone = new Jar();
    const started = await startPairing(owner);
    const { code } = await typed<{ code: string }>(await claim(phone, started.secret));
    expect((await confirm(owner, started.id, code)).status).toBe(204);
    await session.revoke(owner.token);
    expect(await json(await complete(phone))).toMatchObject({ code: "EXPIRED" });

    const second = await person();
    const secondPhone = new Jar();
    const pending = await startPairing(second);
    await claim(secondPhone, pending.secret);
    await session.revokeAllForUser(second.id);
    expect((await complete(secondPhone)).status).toBe(410);
  });

  test("completion is idempotent and re-pairing in the same app replaces the phone", async () => {
    const owner = await person();
    const started = await startPairing(owner);
    const phone = new Jar();
    const { code } = await typed<{ code: string }>(await claim(phone, started.secret));
    await confirm(owner, started.id, code);
    const pairingCookie = phone.get("pwa_pairing")!;
    expect((await complete(phone)).status).toBe(200);
    const deviceId = phone.get("pwa_device")!.split(".")[0]!;

    // A retry with the app session present: answered again, nothing new.
    const retryJar = new Jar({ pwa_pairing: pairingCookie, pwa_session: phone.get("pwa_session")! });
    expect((await complete(retryJar)).status).toBe(200);
    expect(retryJar.get("pwa_device")).toBeUndefined();
    // The response was lost: same device, new key and session.
    const lost = new Jar({ pwa_pairing: pairingCookie });
    expect((await complete(lost)).status).toBe(200);
    expect(lost.get("pwa_device")!.split(".")[0]).toBe(deviceId);
    expect((await probe(phone)).status).toBe(401);
    expect((await probe(lost)).status).toBe(200);
    expect((await pwaDevices.list({ userId: owner.id })).map((item) => item.id)).toEqual([deviceId]);

    const again = await pair(owner, lost);
    expect(again.deviceId).not.toBe(deviceId);
    expect((await pwaDevices.list({ userId: owner.id })).map((item) => item.id)).toEqual([again.deviceId]);
    const [replaced] = await sql<
      { revocation_reason: string }[]
    >`SELECT revocation_reason FROM auth.pwa_devices WHERE id = ${deviceId}::uuid`;
    expect(replaced?.revocation_reason).toBe("replaced");
  });

  test("an app of another account and Chrome signed in as someone else are refused", async () => {
    const owner = await person();
    const stranger = await person({ name: "Grace Example" });
    const { phone } = await pair(stranger);
    const started = await startPairing(owner);
    const { code } = await typed<{ code: string }>(await claim(phone, started.secret));
    await confirm(owner, started.id, code);
    const paired = await complete(phone);
    expect(paired.status).toBe(409);
    expect(await json(paired)).toMatchObject({ code: "ALREADY_PAIRED" });

    const android = new Jar({ session_token: stranger.token });
    const second = await startPairing(owner);
    const claimed = await typed<{ code: string }>(await claim(android, second.secret, "android"));
    await confirm(owner, second.id, claimed.code);
    const mismatch = await complete(android);
    expect(await json(mismatch)).toMatchObject({ code: "ACCOUNT_MISMATCH" });
    expect(android.get("session_token")).toBe(stranger.token);
    android.cookies.delete("session_token");
    expect((await complete(android)).status).toBe(200);
  });

  test("blocked and expired accounts cannot pair; at most twenty phones", async () => {
    const owner = await person();
    const started = await startPairing(owner);
    const phone = new Jar();
    const { code } = await typed<{ code: string }>(await claim(phone, started.secret));
    await confirm(owner, started.id, code);
    await settings.set("user.category.login.enabled", false);
    expect(await json(await complete(phone))).toMatchObject({ code: "ACCOUNT_BLOCKED" });
    await settings.remove("user.category.login.enabled");

    const full = await person();
    for (let index = 0; index < PWA_LIMITS.devicesPerAccount; index += 1) await createTestAppSession(full.id);
    const limited = await startPairing(full);
    const limitedPhone = new Jar();
    const claimed = await typed<{ code: string }>(await claim(limitedPhone, limited.secret));
    await confirm(full, limited.id, claimed.code);
    const capped = await complete(limitedPhone);
    expect(capped.status).toBe(429);
    expect(await json(capped)).toMatchObject({ code: "LIMIT_REACHED" });
  });

  test("renewal rotates the device key, keeps the previous key for a missed answer, and never records a web sign-in", async () => {
    const owner = await person();
    const { phone, deviceId } = await pair(owner);
    const [before] = await sql<{ last_login_local: Date }[]>`SELECT last_login_local FROM auth.users WHERE id = ${owner.id}::uuid`;

    expect(await json(await renew(phone))).toEqual({ renewed: false });
    const oldKey = phone.get("pwa_device")!;
    const oldSession = phone.get("pwa_session")!;

    // Due: the app session is gone, so Core issues a new family and a new key.
    phone.cookies.delete("pwa_session");
    expect(await json(await renew(phone))).toEqual({ renewed: true });
    const newKey = phone.get("pwa_device")!;
    expect(newKey).not.toBe(oldKey);
    expect(phone.get("pwa_session")).not.toBe(oldSession);
    const families = await sql`SELECT sid FROM auth.session_families WHERE pwa_device_id = ${deviceId}::uuid`;
    expect(families.length).toBe(2);
    const [after] = await sql<{ last_login_local: Date }[]>`SELECT last_login_local FROM auth.users WHERE id = ${owner.id}::uuid`;
    expect(after?.last_login_local).toEqual(before!.last_login_local);

    // A parallel request with the previous key within the grace: no action.
    const stale = new Jar({ pwa_device: oldKey });
    expect(await json(await renew(stale))).toEqual({ renewed: false });
    // After the grace, the previous key recovers the phone once more, audited.
    await sql`UPDATE auth.pwa_devices SET rotated_at = now() - interval '2 minutes' WHERE id = ${deviceId}::uuid`;
    expect(await json(await renew(stale))).toEqual({ renewed: true });
    const [recover] = await sql`SELECT 1 FROM audit.events WHERE action = 'auth.pwa.device.recover' AND target_id = ${deviceId}`;
    expect(recover).toBeDefined();

    // The newest key confirms itself and retires the previous one.
    const latest = new Jar({ pwa_device: stale.get("pwa_device")! });
    expect(await json(await renew(latest))).toEqual({ renewed: true });
    expect(latest.get("pwa_device")).not.toBe(stale.get("pwa_device"));
    const confirmed = new Jar({ pwa_device: latest.get("pwa_device")!, pwa_session: latest.get("pwa_session")! });
    expect(await json(await renew(confirmed))).toEqual({ renewed: false });
    const replay = await renew(new Jar({ pwa_device: stale.get("pwa_device")! }));
    expect(replay.status).toBe(401);
    expect(await json(replay)).toMatchObject({ code: "UNPAIRED" });

    const unknown = new Jar({ pwa_device: `${deviceId}.${"C".repeat(43)}`, pwa_session: "x" });
    expect((await renew(unknown)).status).toBe(401);
    expect(unknown.get("pwa_device")).toBeUndefined();
    expect(unknown.get("pwa_session")).toBeUndefined();
  });

  test("renewal ends idle, revoked and signed-out phones, revokes phones of expired accounts and pauses blocked ones", async () => {
    const owner = await person();
    const idle = await pair(owner);
    await sql`UPDATE auth.pwa_devices SET rotated_at = now() - interval '151 days' WHERE id = ${idle.deviceId}::uuid`;
    expect(await json(await renew(idle.phone))).toMatchObject({ code: "UNPAIRED" });

    const blocked = await pair(await person());
    await settings.set("user.category.login.enabled", false);
    const response = await renew(blocked.phone);
    expect(await json(response)).toMatchObject({ code: "ACCOUNT_BLOCKED" });
    expect(blocked.phone.get("pwa_device")).toBeDefined();
    await settings.remove("user.category.login.enabled");
    expect((await renew(blocked.phone)).status).toBe(200);

    const expiring = await person();
    const expired = await pair(expiring);
    await sql`UPDATE auth.users SET account_expires = now() - interval '1 minute' WHERE id = ${expiring.id}::uuid`;
    // Without a live app session nothing moved the epoch yet: renewal itself revokes the phone.
    expired.phone.cookies.delete("pwa_session");
    expect((await renew(expired.phone)).status).toBe(401);
    const [row] = await sql<
      { revocation_reason: string }[]
    >`SELECT revocation_reason FROM auth.pwa_devices WHERE id = ${expired.deviceId}::uuid`;
    expect(row?.revocation_reason).toBe("account_expired");

    const everywhere = await person();
    const signedOut = await pair(everywhere);
    await session.revokeAllForUser(everywhere.id);
    expect((await probe(signedOut.phone)).status).toBe(401);
    expect((await renew(signedOut.phone)).status).toBe(401);
    const [revoke] = await sql<{ metadata: { reason: string } }[]>`
      SELECT metadata FROM audit.events WHERE action = 'auth.pwa.device.revoke' AND target_id = ${signedOut.deviceId}`;
    expect(revoke?.metadata.reason).toBe("sign_out_everywhere");
  });

  test("launch renews and returns to the page, or leads to the right state", async () => {
    const owner = await person();
    const { phone } = await pair(owner);
    phone.cookies.delete("pwa_session");
    const launch = (jar: Jar, to = "/pwa/spaces?view=today") =>
      call(jar, "GET", `${PWA_AUTH_PATH}/session/launch?to=${encodeURIComponent(to)}`, { origin: null });
    const renewed = await launch(phone);
    expect(renewed.status).toBe(302);
    expect(renewed.headers.get("location")).toBe("/pwa/spaces?view=today&pwa_launch=1");
    expect(phone.get("pwa_session")).toBeDefined();
    expect((await launch(phone, "https://evil.example.test/")).headers.get("location")).toBe("/pwa/?pwa_launch=1");
    expect((await launch(phone, "/pwa/_auth/session/renew")).headers.get("location")).toBe("/pwa/?pwa_launch=1");
    expect((await launch(phone, "/pwa//evil.example.test")).headers.get("location")).toBe("/pwa/?pwa_launch=1");
    expect((await launch(new Jar())).headers.get("location")).toBe("/pwa/?pwa=new");
    const ended = new Jar({ pwa_device: `${crypto.randomUUID()}.${"D".repeat(43)}` });
    expect((await launch(ended)).headers.get("location")).toBe("/pwa/?pwa=ended");
    expect(ended.get("pwa_device")).toBeUndefined();
    await settings.set("user.category.login.enabled", false);
    try {
      expect((await launch(phone)).headers.get("location")).toBe("/pwa/?pwa=blocked");
    } finally {
      await settings.remove("user.category.login.enabled");
    }
  });

  test("renewal names another web account in a shared cookie jar", async () => {
    const owner = await person();
    const other = await person({ name: "Grace Example" });
    const { phone } = await pair(owner, new Jar(), "android");
    phone.cookies.set("session_token", { value: other.token, path: "/", attributes: "" });
    expect(await json(await renew(phone))).toEqual({ renewed: false, otherAccount: { name: "Grace Example" } });
  });

  test("renewal concurrent with signing out everywhere does not deadlock", async () => {
    const owner = await person();
    const { phone } = await pair(owner);
    phone.cookies.delete("pwa_session");
    const results = await Promise.all([renew(phone), session.revokeAllForUser(owner.id), renew(phone)]);
    expect([200, 401]).toContain((results[0] as Response).status);
    expect((await renew(new Jar({ pwa_device: phone.get("pwa_device") ?? "" }))).status).toBe(401);
  });

  test("removing, signing out of the app and administrator removal end device and sessions at once", async () => {
    const owner = await person();
    const removed = await pair(owner);
    expect((await call(owner.web, "DELETE", `${PWA_API_PATH}/devices/${removed.deviceId}`)).status).toBe(204);
    expect((await call(owner.web, "DELETE", `${PWA_API_PATH}/devices/${removed.deviceId}`)).status).toBe(204);
    expect((await probe(removed.phone)).status).toBe(401);
    expect((await renew(removed.phone)).status).toBe(401);
    expect((await call(owner.web, "DELETE", `${PWA_API_PATH}/devices/${crypto.randomUUID()}`)).status).toBe(404);

    const unpaired = await pair(owner);
    expect((await call(unpaired.phone, "DELETE", `${PWA_AUTH_PATH}/session`)).status).toBe(204);
    expect(unpaired.phone.get("pwa_session")).toBeUndefined();
    const [row] = await sql<
      { revocation_reason: string }[]
    >`SELECT revocation_reason FROM auth.pwa_devices WHERE id = ${unpaired.deviceId}::uuid`;
    expect(row?.revocation_reason).toBe("unpaired");

    const admin = await person({ admin: true });
    const administered = await pair(owner);
    await expect(pwaDevices.listUserDevices({ userId: owner.id, admin: false }, owner.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await pwaDevices.listUserDevices({ userId: admin.id, admin: true }, owner.id)).map((item) => item.id)).toEqual([
      administered.deviceId,
    ]);
    expect(await pwaDevices.revokeUserDevice({ userId: admin.id, admin: true }, owner.id, administered.deviceId)).toEqual({
      revoked: true,
    });
    expect(await pwaDevices.revokeUserDevice({ userId: admin.id, admin: true }, owner.id, administered.deviceId)).toEqual({
      revoked: false,
    });
    expect((await probe(administered.phone)).status).toBe(401);
  });

  test("maintenance revokes phones of expired accounts; extending the account does not revive them", async () => {
    const owner = await person();
    const { phone, deviceId } = await pair(owner);
    await sql`UPDATE auth.users SET account_expires = now() - interval '1 minute' WHERE id = ${owner.id}::uuid`;
    await sql`UPDATE auth.pwa_pairings SET expires_at = now() - interval '1 minute' WHERE user_id = ${owner.id}::uuid`;
    await pwaDevices.maintain();
    const [device] = await sql<
      { revocation_reason: string }[]
    >`SELECT revocation_reason FROM auth.pwa_devices WHERE id = ${deviceId}::uuid`;
    expect(device?.revocation_reason).toBe("account_expired");
    expect((await sql`SELECT 1 FROM auth.pwa_pairings WHERE user_id = ${owner.id}::uuid`).length).toBe(0);
    await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${owner.id}::uuid`;
    expect((await renew(phone)).status).toBe(401);
  });

  test("an app session cannot create authority that outlives the phone and never acts as administrator", async () => {
    const admin = await person({ admin: true });
    const { phone } = await pair(admin);
    const appSession = await session.authenticate(phone.get("pwa_session")!);
    expect(appSession?.data).toMatchObject({ kind: "app" });
    expect(appSession?.user.roles).not.toContain("admin");
    expect((await session.authenticate(admin.token))?.user.roles).toContain("admin");
    expect(await json(await probe(phone))).toMatchObject({ kind: "app" });

    const webOnly = async (method: string, path: string, body?: unknown) => {
      const response = await call(phone, method, path, { body });
      expect([path, response.status]).toEqual([path, 403]);
      expect(await json(response)).toMatchObject({ code: "FORBIDDEN" });
    };
    await webOnly("POST", "/api/me/api-keys", { name: "From the phone" });
    await webOnly("POST", "/api/me/passkeys/registration/start");
    await webOnly("POST", "/api/me/password", { currentPassword: "x".repeat(12), newPassword: "y".repeat(12) });
    await webOnly("DELETE", "/api/me");
    await webOnly("POST", "/api/me/mandates", {
      ownerAppId: "spaces",
      workloadType: "sync",
      workloadId: "one",
      policy: { version: 1, operations: [] },
    });
    await webOnly("POST", "/api/me/notifications/browser/endpoints", {
      subscription: { endpoint: "https://push.example.test/x", keys: { p256dh: "a", auth: "b" } },
    });
    await webOnly("POST", `${APP_APPROVAL_PATH}/manage/pairings/start`, {});
    // Reading stays possible.
    expect((await call(phone, "GET", "/api/me/api-keys", { origin: null })).status).toBe(200);

    // Recent sign-in never counts for app families.
    await expect(
      sql.begin((tx) =>
        requireRecentWebSession(tx, { userId: admin.id, sid: appSession!.data.sid }, 600, (code) => {
          throw new Error(code);
        }),
      ),
    ).rejects.toThrow("REAUTHENTICATE");

    // Invocations made for an app session carry its kind; the callee drops the administrator role.
    const authority = invocationAuthorityFromRequest({
      actor: { kind: "user", user: appSession!.user },
      accessSubject: { type: "user", userId: admin.id },
      credentialKind: "session",
      scopes: [],
      sessionKind: "app",
    });
    expect(authority.session_kind).toBe("app");
    const now = Math.floor(Date.now() / 1000);
    const resolved = await resolveInvocationAuthority({
      ...authority,
      iss: ORIGIN,
      aud: "app:spaces",
      token_use: "invocation",
      act: { sub: "app:assistant" },
      op: "query:x",
      schema_hash: null,
      ver: 1,
      jti: crypto.randomUUID(),
      iat: now,
      nbf: now,
      exp: now + 60,
    } as Parameters<typeof resolveInvocationAuthority>[0]);
    expect(resolved?.actor.kind === "user" && resolved.actor.user.roles).not.toContain("admin");
  });

  test("web sign-out revokes only the web family", async () => {
    const owner = await person();
    const { phone } = await pair(owner, new Jar({ session_token: owner.token }), "android");
    const both = new Jar({ session_token: owner.token, pwa_session: phone.get("pwa_session")! });
    const logout = new Hono().post("/logout", async (c) => {
      await session.delete(c);
      return c.body(null, 204);
    });
    both.store(await logout.request("/logout", { method: "POST", headers: { cookie: both.header("/") } }));
    expect(both.get("session_token")).toBeUndefined();
    expect(await session.authenticate(owner.token)).toBeNull();
    expect((await probe(phone)).status).toBe(200);
  });

  test("an emergency signing-key revocation ends app sessions; the phone gets a new one at its next start", async () => {
    const owner = await person();
    const { phone } = await pair(owner);
    const [family] = await sql<{ signing_kid: string }[]>`
      SELECT signing_kid FROM auth.session_families WHERE user_id = ${owner.id}::uuid AND pwa_device_id IS NOT NULL LIMIT 1`;
    await revokeIdentitySigningKey({ kid: family!.signing_kid, reason: "pwa integration test" });
    expect((await probe(phone)).status).toBe(401);
    expect(await json(await renew(phone))).toEqual({ renewed: true });
    expect((await probe(phone)).status).toBe(200);
  });
});
