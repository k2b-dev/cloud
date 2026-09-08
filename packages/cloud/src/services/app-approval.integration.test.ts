import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, type Server } from "bun";
import { Hono } from "hono";
import { createAppApprovalRoutes } from "../api/app-approval";
import {
  APP_APPROVAL_PATH,
  AppDevicePublicKeySchema,
  AppDeviceResponseSchema,
  AppDevicesPageSchema,
  AppPairingPayloadSchema,
  AppPairingClaimResultSchema,
  AppPairingResultSchema,
  AppLoginStartResultSchema,
  AppLoginStatusSchema,
  appDeviceProofMessage,
  appPairingProofMessage,
  type AppDeviceProof,
  type AppDeviceRequest,
} from "../contracts/app-approval";
import { createAppApprovalService, readAppApprovalConfig, type AppApprovalActor, type AppApprovalConfig } from "./app-approval";
import { createIdentityPublicRoutes } from "./identity";
import { invalidateIdentityRuntimeConfig } from "./identity/runtime-config";
import { createTestSession } from "./session/test-fixture";
import * as settings from "./settings";

// Never migrate or mutate the development installation.
const suite = process.env.CLOUD_APP_APPROVAL_TEST === "1" ? describe : describe.skip;
const sign = async (key: CryptoKey, message: string) =>
  Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(message))).toString("base64url");
const keys = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: AppDevicePublicKeySchema.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }) };
};

suite("isolated app approval protocol", () => {
  let server: Server<unknown>;
  let cfg: AppApprovalConfig;
  const service = createAppApprovalService(sql, async () => cfg);
  const cloudB = createAppApprovalService(sql, async () => ({ ...cfg, issuer: "https://second-cloud.example.test" }));
  const routes = createAppApprovalRoutes(service);
  const post = (path: string, body: unknown, token?: string, origin = cfg.issuer) =>
    routes.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const account = async (provider: "local" | "ipa" = "local", profile: "user" | "guest" = "user") => {
    const uid = `app-${crypto.randomUUID()}`;
    const [row] = await sql<
      { id: string; uid: string; mail: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,mail) VALUES (${uid},${provider},${profile},${`${uid}@example.test`}) RETURNING id,uid,mail`;
    const token = await createTestSession(row!.id);
    const [family] = await sql<
      { sid: string }[]
    >`SELECT sid FROM auth.session_families WHERE user_id=${row!.id}::uuid ORDER BY issued_at DESC LIMIT 1`;
    const actor: AppApprovalActor = { userId: row!.id, sid: family!.sid, admin: false };
    return { ...row!, token, actor };
  };
  const enroll = async (owner: Awaited<ReturnType<typeof account>>, target = service) => {
    const key = await keys();
    const pairing = AppPairingPayloadSchema.parse(await target.startPairing(owner.actor));
    const claim = { pairingId: pairing.pairingId, secret: pairing.secret, name: "Test device", publicKey: key.publicKey };
    const claimed = AppPairingClaimResultSchema.parse(
      await target.claimPairing({
        ...claim,
        signature: await sign(key.privateKey, appPairingProofMessage(pairing.issuer, claim)),
      }),
    );
    await target.confirmPairing(owner.actor, pairing.pairingId, claimed.comparison);
    AppPairingResultSchema.parse(await target.pairingResult(pairing.pairingId, pairing.secret, key.publicKey));
    AppDevicesPageSchema.parse(await target.listDevices(owner.actor));
    return { ...key, id: claimed.deviceId, issuer: pairing.issuer };
  };
  const proof = async (
    device: Awaited<ReturnType<typeof enroll>>,
    command: AppDeviceProof["command"],
    override: Partial<AppDeviceProof> = {},
  ): Promise<AppDeviceRequest> => {
    const now = Math.floor(Date.now() / 1000);
    const payload: AppDeviceProof = {
      issuer: device.issuer,
      deviceId: device.id,
      jti: crypto.randomUUID(),
      issuedAt: now,
      expiresAt: now + 60,
      command,
      ...override,
    };
    return { proof: payload, signature: await sign(device.privateKey, appDeviceProofMessage(payload)) };
  };
  const approve = async (
    device: Awaited<ReturnType<typeof enroll>>,
    requestId: string,
    target = service,
    decision: "approve" | "deny" = "approve",
  ) => {
    const pending = AppDeviceResponseSchema.parse(await target.deviceCommand(await proof(device, { operation: "pending" })));
    if (!("requests" in pending)) throw new Error("Pending response missing");
    const request = pending.requests?.find((item) => item.requestId === requestId);
    if (!request) throw new Error("Pending request missing");
    return target.deviceCommand(
      await proof(device, { operation: "decide", requestId, challenge: request.challenge, comparison: request.comparison, decision }),
    );
  };
  beforeAll(async () => {
    const db = new URL(process.env.DATABASE_URL!);
    if (
      db.hostname !== "127.0.0.1" ||
      db.port !== "55449" ||
      db.pathname !== "/cloud_app_approval_test" ||
      new URL(process.env.REDIS_URL!).port !== "56399"
    )
      throw new Error("Dedicated app-approval test DB/cache required");
    // Public, deterministic fixture material: never used outside the guarded DB.
    process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = "a1".repeat(32);
    for (const name of ["auth", "settings", "audit", "logging", "app-approval"])
      await (await import(`../../../core/src/migrate/core/${name}.ts`)).migrate();
    // Rerunning additive migration must be safe.
    await (await import("../../../core/src/migrate/core/app-approval")).migrate();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: new Hono().route("/", createIdentityPublicRoutes()).route(APP_APPROVAL_PATH, routes).fetch,
    });
    cfg = { issuer: `http://127.0.0.1:${server.port}`, appOrigin: "http://127.0.0.1:43119", enabled: true, adminPairing: false };
    await settings.set("app.url", cfg.issuer);
    await settings.set("security.rate_limit_per_second", 10000);
    invalidateIdentityRuntimeConfig();
  }, 30000);
  beforeEach(async () => {
    cfg.enabled = true;
    cfg.adminPairing = false;
    for (const category of ["guest", "login", "freeipa"]) await settings.remove(`user.category.${category}.enabled`);
  });
  afterAll(async () => {
    await server?.stop(true);
  });

  test("feature defaults off, issuer uses canonical app URL, malformed origins fail closed", async () => {
    expect((await readAppApprovalConfig()).enabled).toBe(false);
    await settings.set("user.app_approval.enabled", true);
    await settings.set("user.app_approval.origin", "https://auth.example.test/path");
    await expect(readAppApprovalConfig()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await settings.set("user.app_approval.origin", "https://auth.example.test");
    expect((await readAppApprovalConfig()).issuer).toBe(cfg.issuer);
    await settings.remove("user.app_approval.enabled");
  });

  test("self enrollment needs possession and explicit recent-session confirmation", async () => {
    const owner = await account(),
      key = await keys();
    const pairing = await service.startPairing(owner.actor);
    const claim = { pairingId: pairing.pairingId, secret: pairing.secret, publicKey: key.publicKey, name: "Phone" };
    const signed = { ...claim, signature: await sign(key.privateKey, appPairingProofMessage(cfg.issuer, claim)) };
    await expect(service.claimPairing({ ...signed, name: "Tampered" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const result = await service.claimPairing(signed);
    await expect(
      service.deviceCommand(await proof({ ...key, id: result.deviceId, issuer: cfg.issuer }, { operation: "pending" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await service.pairingResult(pairing.pairingId, pairing.secret, key.publicKey)).comparison).toBe(result.comparison);
    await expect(service.pairingResult(pairing.pairingId, pairing.secret, (await keys()).publicKey)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(service.claimPairing(signed)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.confirmPairing(owner.actor, pairing.pairingId, "wrong")).rejects.toMatchObject({ code: "CONFLICT" });
    await service.confirmPairing(owner.actor, pairing.pairingId, result.comparison);
    await expect(service.confirmPairing(owner.actor, pairing.pairingId, result.comparison)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await service.listDevices(owner.actor)).items).toHaveLength(1);
    const [row] = await sql`SELECT secret_hash FROM auth.app_pairings WHERE id=${pairing.pairingId}::uuid`;
    expect(row.secret_hash).not.toBe(pairing.secret);
  });

  test("API management rejects anonymous and cross-origin, and old sessions cannot enroll", async () => {
    const owner = await account();
    expect((await post("/manage/pairings/start", {})).status).toBe(401);
    expect((await post("/manage/pairings/start", {}, owner.token, cfg.appOrigin)).status).toBe(403);
    expect((await post("/manage/pairings/start", {}, owner.token)).status).toBe(201);
    await sql`UPDATE auth.session_families SET issued_at=now()-interval '11 minutes' WHERE sid=${owner.actor.sid}::uuid`;
    expect((await post("/manage/pairings/start", {}, owner.token)).status).toBe(403);
  });

  test("admin assisted pairing requires opt-in, current admin and initiating session", async () => {
    const admin = await account(),
      owner = await account();
    admin.actor.admin = true;
    await expect(service.startPairing(admin.actor, owner.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    cfg.adminPairing = true;
    const pairing = await service.startPairing(admin.actor, owner.id);
    await expect(service.inspectPairing(owner.actor, pairing.pairingId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.inspectPairing({ ...admin.actor, admin: false }, pairing.pairingId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await service.cancelPairing(admin.actor, pairing.pairingId);
    expect((await service.pairingResult(pairing.pairingId, pairing.secret, (await keys()).publicKey)).state).toBe("cancelled");
  });

  test.each([
    ["local", "user", "login"],
    ["local", "guest", "guest"],
    ["ipa", "user", "freeipa"],
    ["ipa", "guest", "freeipa"],
  ] as const)("%s/%s approves a one-use %s browser login", async (provider, profile, category) => {
    const owner = await account(provider, profile),
      device = await enroll(owner);
    const started = await service.startLogin(owner.uid, category);
    await approve(device, started.requestId);
    await expect(service.consumeLogin(started.requestId, "wrong-secret")).rejects.toMatchObject({ code: "CONFLICT" });
    const results = await Promise.allSettled([
      service.consumeLogin(started.requestId, started.browserSecret),
      service.consumeLogin(started.requestId, started.browserSecret),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await service.browserStatus(started.requestId, started.browserSecret)).state).toBe("consumed");
  });

  test("two Clouds and two accounts cannot reuse keys, requests, or signatures", async () => {
    const owner = await account(),
      other = await account();
    const a = await enroll(owner),
      b = await enroll(owner, cloudB),
      stranger = await enroll(other);
    const started = await service.startLogin(owner.mail, "login");
    const request = await proof(a, { operation: "pending" });
    await expect(cloudB.deviceCommand(request)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.deviceCommand(await proof(stranger, { operation: "pending" }, { deviceId: a.id }))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await cloudB.deviceCommand(await proof(b, { operation: "pending" }))).toMatchObject({ requests: [] });
    expect(await service.deviceCommand(await proof(stranger, { operation: "pending" }))).toMatchObject({ requests: [] });
    await approve(a, started.requestId);
    await expect(cloudB.consumeLogin(started.requestId, started.browserSecret)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await service.consumeLogin(started.requestId, started.browserSecret)).toBe(owner.id);
  });

  test("signed commands reject replay, body tampering, wrong clock and request mixups", async () => {
    const owner = await account(),
      device = await enroll(owner);
    const request = await proof(device, { operation: "pending" });
    await service.deviceCommand(request);
    await expect(service.deviceCommand(request)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      service.deviceCommand({ ...request, proof: { ...request.proof, command: { operation: "revoke" } } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.deviceCommand(await proof(device, { operation: "pending" }, { issuedAt: 1, expiresAt: 61 })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const started = await service.startLogin(owner.uid, "login");
    await expect(
      service.deviceCommand(
        await proof(device, {
          operation: "decide",
          requestId: started.requestId,
          challenge: "a".repeat(43),
          comparison: started.comparison,
          decision: "approve",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await approve(device, started.requestId, service, "deny");
    await expect(service.consumeLogin(started.requestId, started.browserSecret)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("revocation and current account policy deny already approved logins", async () => {
    const owner = await account(),
      device = await enroll(owner);
    const started = await service.startLogin(owner.uid, "login");
    await approve(device, started.requestId);
    await settings.set("user.category.login.enabled", false);
    await expect(service.consumeLogin(started.requestId, started.browserSecret)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await settings.remove("user.category.login.enabled");
    await service.mutateDevice(owner.actor, device.id);
    await expect(service.consumeLogin(started.requestId, started.browserSecret)).rejects.toMatchObject({ code: "FORBIDDEN" });
    cfg.enabled = false;
    expect((await service.listDevices(owner.actor)).items[0]?.revokedAt).not.toBeNull();
    await expect(service.startLogin(owner.uid, "login")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  test("account epoch changes, expiry and deletion invalidate credentials and requests", async () => {
    const owner = await account(),
      device = await enroll(owner);
    const started = await service.startLogin(owner.uid, "login");
    await approve(device, started.requestId);
    await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${owner.id}::uuid`;
    await expect(service.consumeLogin(started.requestId, started.browserSecret)).rejects.toMatchObject({ code: "CONFLICT" });
    await sql`UPDATE auth.users SET account_expires=now()-interval '1 minute' WHERE id=${owner.id}::uuid`;
    await expect(service.deviceCommand(await proof(device, { operation: "pending" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await sql`DELETE FROM auth.users WHERE id=${owner.id}::uuid`;
    await expect(service.deviceCommand(await proof(device, { operation: "pending" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("unknown and disabled accounts have the same public pending shape", async () => {
    const owner = await account();
    const known = AppLoginStartResultSchema.parse(await service.startLogin(owner.uid, "login"));
    const unknown = await service.startLogin("unknown@example.test", "login");
    await settings.set("user.category.login.enabled", false);
    const disabled = await service.startLogin(owner.uid, "login");
    expect(Object.keys(known)).toEqual(Object.keys(unknown));
    expect(Object.keys(known)).toEqual(Object.keys(disabled));
    for (const result of [known, unknown, disabled])
      expect(AppLoginStatusSchema.parse(await service.browserStatus(result.requestId, result.browserSecret)).state).toBe("pending");
  });

  test("HTTP completion sets a Cloud-only cookie and CORS exposes only device endpoints", async () => {
    const owner = await account(),
      device = await enroll(owner);
    const started = await service.startLogin(owner.uid, "login");
    await approve(device, started.requestId);
    expect((await post("/login/complete", started, undefined, cfg.appOrigin)).status).toBe(403);
    const body = { requestId: started.requestId, browserSecret: started.browserSecret };
    const complete = await post("/login/complete", body);
    expect(complete.status).toBe(204);
    expect(complete.headers.get("set-cookie")).toContain("HttpOnly");
    expect(await complete.text()).toBe("");
    expect((await post("/login/complete", body)).status).toBe(409);
    const preflight = await routes.request("/device", {
      method: "OPTIONS",
      headers: { origin: cfg.appOrigin, "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(cfg.appOrigin);
    expect(preflight.headers.has("access-control-allow-credentials")).toBe(false);
    expect((await post("/device", await proof(device, { operation: "pending" }), undefined, "https://evil.example.test")).status).toBe(403);
    expect((await post("/device", { oversized: "a".repeat(9000) }, undefined, cfg.appOrigin)).status).toBe(413);
    expect((await post("/device", { proof: {}, signature: "bad" }, undefined, cfg.appOrigin)).status).toBe(400);
  });

  test("durable enrollment notices retry and expiry cleanup is bounded", async () => {
    // Mark earlier test enrollments delivered, then simulate this device's send failure.
    await sql`UPDATE auth.app_devices SET notified_at=now()`;
    const owner = await account();
    const device = await enroll(owner);
    await expect(
      service.maintain(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    const delivered: string[] = [];
    await service.maintain(async (notice) => {
      delivered.push(notice.deviceId);
    });
    await service.maintain(async (notice) => {
      delivered.push(notice.deviceId);
    });
    expect(delivered).toEqual([device.id]);
    const started = await service.startLogin(owner.uid, "login");
    await sql`UPDATE auth.app_logins SET expires_at=now()-interval '1 second' WHERE id=${started.requestId}::uuid`;
    await service.cleanup();
    expect(await sql`SELECT id FROM auth.app_logins WHERE id=${started.requestId}::uuid`).toHaveLength(0);
  });

  test("expired and cancelled pairings cannot be claimed; outstanding pairing work is capped", async () => {
    const owner = await account(),
      key = await keys();
    const expired = await service.startPairing(owner.actor);
    await sql`UPDATE auth.app_pairings SET expires_at=now()-interval '1 second' WHERE id=${expired.pairingId}::uuid`;
    const claim = { pairingId: expired.pairingId, secret: expired.secret, publicKey: key.publicKey, name: "Expired" };
    await expect(
      service.claimPairing({ ...claim, signature: await sign(key.privateKey, appPairingProofMessage(cfg.issuer, claim)) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const cancelled = await service.startPairing(owner.actor);
    await service.cancelPairing(owner.actor, cancelled.pairingId);
    const cancelledClaim = { ...claim, pairingId: cancelled.pairingId, secret: cancelled.secret };
    await expect(
      service.claimPairing({
        ...cancelledClaim,
        signature: await sign(key.privateKey, appPairingProofMessage(cfg.issuer, cancelledClaim)),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    for (let i = 0; i < 5; i++) await service.startPairing(owner.actor);
    await expect(service.startPairing(owner.actor)).rejects.toMatchObject({ code: "LIMIT_REACHED" });
  });

  test("device keys cannot be silently re-enrolled, and outstanding logins stay bounded", async () => {
    const owner = await account(),
      device = await enroll(owner);
    const pairing = await service.startPairing(owner.actor);
    const claim = { pairingId: pairing.pairingId, secret: pairing.secret, publicKey: device.publicKey, name: "Duplicate" };
    const claimed = await service.claimPairing({
      ...claim,
      signature: await sign(device.privateKey, appPairingProofMessage(cfg.issuer, claim)),
    });
    await expect(service.confirmPairing(owner.actor, pairing.pairingId, claimed.comparison)).rejects.toMatchObject({ code: "CONFLICT" });
    for (let i = 0; i < 7; i++) await service.startLogin(owner.uid, "login");
    const result = await service.deviceCommand(await proof(device, { operation: "pending" }));
    expect("requests" in result && result.requests?.length).toBe(5);
    const [row] = await sql`SELECT jsonb_typeof(public_key) AS kind FROM auth.app_devices WHERE id=${device.id}::uuid`;
    expect(row.kind).toBe("object");
  });

  test("HTTP validates explicit device mutations and current admin-assisted authority", async () => {
    const owner = await account(),
      other = await account(),
      device = await enroll(owner);
    expect((await post("/manage/devices/update", { deviceId: device.id }, owner.token)).status).toBe(400);
    expect((await post("/manage/devices/update", { operation: "rename", deviceId: device.id, name: "Renamed" }, other.token)).status).toBe(
      404,
    );
    expect((await post("/manage/devices/update", { operation: "rename", deviceId: device.id, name: "Renamed" }, owner.token)).status).toBe(
      204,
    );
    cfg.adminPairing = true;
    expect((await post("/manage/pairings/start", { userId: other.id }, owner.token)).status).toBe(403);
    await sql`UPDATE auth.users SET admin=true WHERE id=${owner.id}::uuid`;
    const response = await post("/manage/pairings/start", { userId: other.id }, owner.token);
    expect(response.status).toBe(201);
    const pairing = await response.json();
    await sql`UPDATE auth.users SET admin=false WHERE id=${owner.id}::uuid`;
    expect((await post("/manage/pairings/status", { pairingId: pairing.pairingId }, owner.token)).status).toBe(403);
  });
});
