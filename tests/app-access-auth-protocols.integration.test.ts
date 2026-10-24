import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../scripts/fixtures/test-infra";
import "../scripts/fixtures/authorization-preload";
import { createAppApprovalRoutes } from "../packages/cloud/src/api/app-approval";
import { createPwaPhoneRoutes } from "../packages/cloud/src/api/pwa-phone";
import {
  APP_APPROVAL_PATH,
  type AppDeviceProof,
  AppDevicePublicKeySchema,
  AppDeviceResponseSchema,
  AppLoginStartResultSchema,
  AppPairingClaimResultSchema,
  appDeviceProofMessage,
  appPairingProofMessage,
} from "../packages/cloud/src/contracts/app-approval";
import { PWA_AUTH_PATH, PWA_COOKIES } from "../packages/cloud/src/contracts/pwa";
import { requireAppAccess } from "../packages/cloud/src/server/middleware/app-access";
import type { AuthContext } from "../packages/cloud/src/server/middleware/auth";
import { createAppApprovalService } from "../packages/cloud/src/services/app-approval";
import { invalidateIdentityRuntimeConfig } from "../packages/cloud/src/services/identity/runtime-config";
import { pairingSecret } from "../packages/cloud/src/services/pairing-secret";
import { createTestBrowserSignIn } from "../packages/cloud/src/services/session/session.test-fixture";
import * as settings from "../packages/cloud/src/services/settings";
import { app as core } from "../packages/core/src/config";

const issuer = "https://cloud.example.test";
const appOrigin = "https://authenticator.example.test";
const sign = async (key: CryptoKey, message: string) =>
  Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(message))).toString("base64url");
// Production protocol service and routers; only the distributed wake-up transport
// is a stand-in, as in the canonical app-approval integration fixture.
const service = createAppApprovalService(
  sql,
  async () => ({ issuer, appOrigin, enabled: true, adminPairing: false }),
  { publish: () => {}, wait: async () => {} },
  async () => 202,
);
const router = new Hono<AuthContext>()
  .use(
    "*",
    requireAppAccess(core.meta, async () => new Response("Core denied", { status: 403 })),
  )
  .route(APP_APPROVAL_PATH, createAppApprovalRoutes({ notify: async () => {} }, service))
  .route(PWA_AUTH_PATH, createPwaPhoneRoutes({ shellAvailable: () => true, notify: async () => {} }));
const post = (path: string, body: unknown, origin = issuer) =>
  router.request(`${APP_APPROVAL_PATH}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

suiteFor(
  "database",
  "nats",
  "valkey",
)("app-access Core specialized authentication protocols", () => {
  const users: string[] = [];
  let previousUrl: string;
  let previousRate: number;
  beforeAll(async () => {
    for (const name of ["auth", "settings", "audit", "logging", "device-trust", "app-approval", "pwa"])
      await (await import(`../packages/core/src/migrate/core/${name}.ts`)).migrate();
    previousUrl = await settings.get<string>("app.url");
    previousRate = await settings.get<number>("security.rate_limit_per_second");
    await settings.set("app.url", issuer);
    await settings.set("security.rate_limit_per_second", 10000);
    invalidateIdentityRuntimeConfig();
  });
  beforeEach(async () => {
    // Match the database clock, as the canonical protocol suite does: session and
    // pairing eligibility use SQL now(), while signed proofs use the JS clock.
    const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;
    setSystemTime(clock!.now);
  });
  afterEach(() => setSystemTime());
  afterAll(async () => {
    for (const id of users) await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    await settings.set("app.url", previousUrl);
    await settings.set("security.rate_limit_per_second", previousRate);
    invalidateIdentityRuntimeConfig();
  });
  const person = async () => {
    const id = crypto.randomUUID();
    const uid = `app-access-${id}`;
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${uid},'local','user')`;
    users.push(id);
    return { id, uid, actor: { ...(await createTestBrowserSignIn(id)), admin: false } };
  };

  test("app-access permits device pairing and browser login without an ordinary session, retaining origin and proof checks", async () => {
    const owner = await person();
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
    const publicKey = AppDevicePublicKeySchema.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
    const info = await router.request(`${APP_APPROVAL_PATH}/info`, { headers: { origin: appOrigin } });
    expect(info.status).toBe(200);
    expect(info.headers.get("Access-Control-Allow-Origin")).toBe(appOrigin);
    const preflight = await router.request(`${APP_APPROVAL_PATH}/device`, { method: "OPTIONS", headers: { origin: appOrigin } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(appOrigin);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    const foreign = await router.request(`${APP_APPROVAL_PATH}/info`, { headers: { origin: "https://evil.example.test" } });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const pairing = await service.startPairing(owner.actor);
    const claim = { pairingId: pairing.pairingId, secret: pairing.secret, name: "Protocol device", publicKey };
    const signature = await sign(key.privateKey, appPairingProofMessage(issuer, claim));
    const badClaim = await post("/pairings/claim", { ...claim, name: "Tampered device", signature }, appOrigin);
    expect(badClaim.status).toBe(403);
    expect(await badClaim.json()).toMatchObject({ code: "FORBIDDEN" });
    const claimed = await post("/pairings/claim", { ...claim, signature }, appOrigin);
    expect(claimed.status).toBe(200);
    const device = AppPairingClaimResultSchema.parse(await claimed.json());
    await service.confirmPairing(owner.actor, pairing.pairingId, device.comparison);
    const result = await post("/pairings/result", { pairingId: pairing.pairingId, secret: pairing.secret, publicKey }, appOrigin);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ state: "confirmed", deviceId: device.deviceId });
    const command = async (command: AppDeviceProof["command"]) => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const proof: AppDeviceProof = {
        issuer,
        deviceId: device.deviceId,
        jti: crypto.randomUUID(),
        issuedAt,
        expiresAt: issuedAt + 60,
        command,
      };
      return { proof, signature: await sign(key.privateKey, appDeviceProofMessage(proof)) };
    };
    const tampered = await command({ operation: "account" });
    tampered.proof.command = { operation: "pending" };
    const badProof = await post("/device", tampered, appOrigin);
    expect(badProof.status).toBe(403);
    expect(await badProof.json()).toMatchObject({ code: "FORBIDDEN" });
    expect((await post("/device", await command({ operation: "account" }), appOrigin)).status).toBe(200);

    expect((await post("/login/start", { identifier: owner.uid, category: "login" }, appOrigin)).status).toBe(403);
    const started = await post("/login/start", { identifier: owner.uid, category: "login" });
    expect(started.status).toBe(202);
    const login = AppLoginStartResultSchema.parse(await started.json());
    const pending = await post("/device", await command({ operation: "pending" }), appOrigin);
    expect(pending.status).toBe(200);
    const inbox = AppDeviceResponseSchema.parse(await pending.json());
    if (!("requests" in inbox)) throw new Error("Pending requests missing");
    const request = inbox.requests.find((item) => item.requestId === login.requestId);
    if (!request) throw new Error("Browser login missing from device inbox");
    const approved = await post(
      "/device",
      await command({
        operation: "decide",
        requestId: request.requestId,
        challenge: request.challenge,
        comparison: request.comparison,
        decision: "approve",
      }),
      appOrigin,
    );
    expect(approved.status).toBe(200);
    const reference = { requestId: login.requestId, browserSecret: login.browserSecret };
    const status = await post("/login/status", reference);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ state: "approved" });
    const wrongSecret = pairingSecret.create();
    expect((await post("/login/status", { ...reference, browserSecret: wrongSecret })).status).toBe(404);
    expect((await post("/login/complete", { ...reference, browserSecret: wrongSecret })).status).toBe(409);
    const completed = await post("/login/complete", reference);
    expect(completed.status).toBe(204);
    expect(completed.headers.getSetCookie().some((cookie) => cookie.startsWith("session_token="))).toBe(true);
    expect((await post("/login/complete", reference)).status).toBe(409);
  });

  test("app-access phone rename and idempotent logout use the device key without a session and clear every protocol cookie", async () => {
    const owner = await person();
    const deviceId = crypto.randomUUID();
    const secret = pairingSecret.create();
    await sql`INSERT INTO auth.pwa_devices(id,user_id,name,platform,auth_epoch,secret_hash,rotated_at)
      SELECT ${deviceId}::uuid,id,'Test phone','other',auth_epoch,${pairingSecret.hash(secret)},now() FROM auth.users WHERE id=${owner.id}::uuid`;
    const phone = (method: string, key: string, origin = issuer) =>
      router.request(`${PWA_AUTH_PATH}/session`, {
        method,
        headers: {
          origin,
          "content-type": "application/json",
          cookie: `${PWA_COOKIES.device}=${key}; ${PWA_COOKIES.session}=expired-app-session; ${PWA_COOKIES.pairing}=stale-pairing`,
        },
        ...(method === "PATCH" ? { body: JSON.stringify({ name: "Renamed phone" }) } : {}),
      });
    const key = `${deviceId}.${secret}`;
    expect((await phone("PATCH", `${deviceId}.${pairingSecret.create()}`)).status).toBe(401);
    expect((await phone("DELETE", key, "https://evil.example.test")).status).toBe(403);
    expect((await phone("PATCH", key)).status).toBe(204);
    expect((await sql`SELECT name FROM auth.pwa_devices WHERE id=${deviceId}::uuid`)[0]?.name).toBe("Renamed phone");
    // A blocked account still needs device-key sign-out to recover.
    await sql`UPDATE auth.users SET account_expires=now()-interval '1 day' WHERE id=${owner.id}::uuid`;
    const logout = await phone("DELETE", key);
    expect(logout.status).toBe(204);
    for (const [name, path] of [
      [PWA_COOKIES.session, "/"],
      [PWA_COOKIES.device, PWA_AUTH_PATH],
      [PWA_COOKIES.pairing, `${PWA_AUTH_PATH}/pairings`],
    ]) {
      expect(
        logout.headers
          .getSetCookie()
          .some(
            (cookie) =>
              cookie.startsWith(`${name}=`) &&
              cookie.split(";").some((attribute) => attribute.trim() === `Path=${path}`) &&
              /Max-Age=0/i.test(cookie),
          ),
      ).toBe(true);
    }
    expect((await sql`SELECT revocation_reason FROM auth.pwa_devices WHERE id=${deviceId}::uuid`)[0]?.revocation_reason).toBe("unpaired");
    expect((await phone("DELETE", key)).status).toBe(204);
    expect((await phone("DELETE", "")).status).toBe(204);
  });

  test("app-access keeps app approval management and private protocol neighbors behind Core entry", async () => {
    for (const path of ["/manage/devices", "/manage/pairings/start", "/info/private", "/device/private", "/login/start/private"])
      expect((await post(path, {})).status).toBe(401);
    expect((await router.request(`${PWA_AUTH_PATH}/session/private`, { method: "DELETE", headers: { origin: issuer } })).status).toBe(401);
  });
});
