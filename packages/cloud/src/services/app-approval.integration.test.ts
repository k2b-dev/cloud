import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { type Server, sql } from "bun";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { withActiveIdentitySigner } from "./identity";
import "../../../../scripts/fixtures/authorization-preload";
import { migrateCloudAi } from "../ai/migrate";
import { aiConversations } from "../ai/store";
import { createAppApprovalRoutes } from "../api/app-approval";
import { createDeviceActions } from "../api/app-approval-actions";
import {
  APP_APPROVAL_LIMITS,
  APP_APPROVAL_PATH,
  AppActionViewSchema,
  AppDeviceAccountSchema,
  AppDeviceInboxSchema,
  type AppDeviceProof,
  AppDevicePublicKeySchema,
  type AppDeviceRequest,
  AppDeviceResponseSchema,
  AppDevicesPageSchema,
  AppLoginStartResultSchema,
  AppLoginContextSchema,
  AppLoginStatusSchema,
  AppPairingClaimResultSchema,
  AppPairingPayloadSchema,
  AppPairingResultSchema,
  appActionDigest,
  appDeviceProofMessage,
  appPairingProofMessage,
} from "../contracts/app-approval";
import {
  type AppApprovalActor,
  type AppApprovalConfig,
  type AppLoginDecisionHints,
  type AppLoginPushSender,
  type AppTerminalLogins,
  createAppApprovalService,
  readAppApprovalConfig,
} from "./app-approval";
import { approvals } from "./approvals";
import { browserHash, countryHistory } from "./known-browsers";
import { type AppLoginAddressStore, appLoginAddressKey, valkeyAppLoginAddressStore } from "./login-address-store";
import type { AppLoginRequestContext } from "./login-context";
import { requestCacheRedis } from "./request-cache-redis";
import { createIdentityPublicRoutes } from "./identity";
import { invalidateIdentityRuntimeConfig } from "./identity/runtime-config";
import { session } from "./session";
import { createTestSession } from "./session/session.test-fixture";
import * as settings from "./settings";

const deviceActions = createDeviceActions((id, _locale) => id);

// Never migrate or mutate the development installation.
const suite = suiteFor("database", "valkey");
const sign = async (key: CryptoKey, message: string) =>
  Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(message))).toString("base64url");
const keys = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: AppDevicePublicKeySchema.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }) };
};

const contextRequest = (overrides: Partial<AppLoginRequestContext> = {}): AppLoginRequestContext => ({
  browser: "firefox",
  os: "linux",
  country: "AT",
  city: "Vienna",
  network: "Operator",
  cookie: null,
  prefix: null,
  ...overrides,
});
// Frozen copy of the old strict wire schema, independent of the current contract.
const oldPlainText = (max: number) =>
  z
    .string()
    .refine((value) => Array.from(value).length <= max)
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u);
const OldPendingLoginSchema = z
  .object({
    requestId: z.string().uuid(),
    challenge: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
    comparison: z.string().regex(/^\d{6}$/),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    terminal: z
      .object({
        client: z
          .object({
            id: oldPlainText(256)
              .min(1)
              .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 258),
            name: oldPlainText(60).min(1),
          })
          .strict(),
        scopes: z
          .array(z.string().regex(/^[a-z][a-z0-9_:.-]{0,39}$/))
          .min(1)
          .max(16),
        lifetimeSeconds: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

suite("isolated app approval protocol", () => {
  let server: Server<unknown>;
  let cfg: AppApprovalConfig;
  // In-process stand-in for the Sync broadcast between replicas.
  const decided = new EventTarget();
  const hints: AppLoginDecisionHints = {
    publish: (requestId) => decided.dispatchEvent(new Event(requestId)),
    wait: (requestId, signal) =>
      new Promise<void>((resolve) => {
        decided.addEventListener(requestId, () => resolve(), { once: true, signal });
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  };
  // Stand-in for Cloud Login's POST /push/notify; records what would leave the Cloud.
  const pushes: { appOrigin: string; body: Parameters<AppLoginPushSender>[1]; committed: boolean }[] = [];
  let pushStatus = 202;
  const pushEvents = new EventTarget();
  const pushSender: AppLoginPushSender = async (appOrigin, body) => {
    const [row] = await sql`SELECT 1 FROM auth.app_logins WHERE id=${body.requestRef}::uuid`;
    pushes.push({ appOrigin, body, committed: Boolean(row) });
    pushEvents.dispatchEvent(new Event("push"));
    return pushStatus;
  };
  const service = createAppApprovalService(sql, async () => cfg, hints, pushSender);
  const cloudB = createAppApprovalService(sql, async () => ({ ...cfg, issuer: "https://second-cloud.example.test" }), hints);
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
    const pending = AppDeviceResponseSchema.parse(await target.deviceCommand(await proof(device, { operation: "pending" }), deviceActions));
    if (!("requests" in pending)) throw new Error("Pending response missing");
    const request = pending.requests?.find((item) => item.requestId === requestId);
    if (!request) throw new Error("Pending request missing");
    return target.deviceCommand(
      await proof(device, { operation: "decide", requestId, challenge: request.challenge, comparison: request.comparison, decision }),
      deviceActions,
    );
  };
  beforeAll(async () => {
    // Public, deterministic fixture material: never used outside the guarded DB.
    process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = "a1".repeat(32);
    for (const name of ["auth", "settings", "audit", "logging", "device-trust", "app-approval"])
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
    await settings.remove("user.app_approval.origin");
    expect((await readAppApprovalConfig()).appOrigin).toBe("https://cloud-login.pwa.k2b.dev");
    await settings.set("user.app_approval.origin", "https://auth.example.test/path");
    await expect(readAppApprovalConfig()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await readAppApprovalConfig(sql, false)).toMatchObject({ enabled: true, appOrigin: "" });
    await settings.set("user.app_approval.origin", "https://auth.example.test");
    expect((await readAppApprovalConfig()).issuer).toBe(cfg.issuer);
    await settings.remove("user.app_approval.enabled");
  });

  test("incomplete setup preserves owned device management but blocks login, pairing and foreign origins", async () => {
    const owner = await account();
    const device = await enroll(owner);
    const stranger = await account();
    await settings.set("user.app_approval.enabled", true);
    await settings.set("user.app_approval.origin", "");
    const live = createAppApprovalService(sql);
    const api = createAppApprovalRoutes(live);
    try {
      expect((await live.listDevices(owner.actor)).items.map((item) => item.id)).toContain(device.id);
      const read = await api.request("/manage/devices", { headers: { authorization: `Bearer ${owner.token}` } });
      expect(read.status).toBe(200);
      expect((await api.request("/info")).status).toBe(503);
      await expect(live.startLogin(owner.uid, "login")).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await expect(live.startPairing(owner.actor)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await expect(live.mutateDevice(stranger.actor, device.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      const mutation = (origin: string) =>
        api.request("/manage/devices/update", {
          method: "POST",
          headers: { authorization: `Bearer ${owner.token}`, origin, "content-type": "application/json" },
          body: JSON.stringify({ operation: "revoke", deviceId: device.id }),
        });
      expect((await mutation("https://foreign.example.test")).status).toBe(403);
      expect((await mutation(cfg.issuer)).status).toBe(204);
      expect((await live.listDevices(owner.actor)).items.find((item) => item.id === device.id)?.revokedAt).not.toBeNull();
    } finally {
      await settings.remove("user.app_approval.enabled");
      await settings.remove("user.app_approval.origin");
    }
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
      service.deviceCommand(await proof({ ...key, id: result.deviceId, issuer: cfg.issuer }, { operation: "pending" }), deviceActions),
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

  test("a held browser status answers on the app decision, at expiry, or at its bound", async () => {
    const owner = await account(),
      device = await enroll(owner);
    const started = await service.startLogin(owner.uid, "login");
    let since = performance.now();
    expect((await service.browserStatus(started.requestId, started.browserSecret, { ms: 200 })).state).toBe("pending");
    expect(performance.now() - since).toBeGreaterThanOrEqual(190);
    await expect(service.browserStatus(started.requestId, "wrong-secret", { ms: 30_000 })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const client = new AbortController();
    const gone = service.browserStatus(started.requestId, started.browserSecret, { ms: 30_000, signal: client.signal });
    client.abort();
    expect((await gone).state).toBe("pending");
    const held = service.browserStatus(started.requestId, started.browserSecret, { ms: 30_000 });
    await Bun.sleep(50);
    since = performance.now();
    await approve(device, started.requestId);
    expect((await held).state).toBe("approved");
    expect(performance.now() - since).toBeLessThan(1_000);
    const expiring = await service.startLogin(owner.uid, "login");
    await sql`UPDATE auth.app_logins SET expires_at=now()+interval '300 milliseconds' WHERE id=${expiring.requestId}::uuid`;
    since = performance.now();
    expect((await service.browserStatus(expiring.requestId, expiring.browserSecret, { ms: 30_000 })).state).toBe("expired");
    expect(performance.now() - since).toBeLessThan(5_000);
  });

  test("a sign-in wakes the owner's paired phones after commit with only the Cloud and request id", async () => {
    const owner = await account();
    const other = await account();
    const device = await enroll(owner);
    const second = await enroll(owner);
    const stranger = await enroll(other);
    const token = "P".repeat(43);
    expect(await service.deviceCommand(await proof(device, { operation: "push", token }), deviceActions)).toEqual({ state: "updated" });
    // The same phone paired twice holds one token: one wake-up, not two.
    await service.deviceCommand(await proof(second, { operation: "push", token }), deviceActions);
    await service.deviceCommand(await proof(stranger, { operation: "push", token: "S".repeat(43) }), deviceActions);
    const until = async (check: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await check()); i++) await Bun.sleep(20);
    };
    pushes.length = 0;
    pushStatus = 202;
    const started = await service.startLogin(owner.uid, "login", contextRequest());
    const [storedContext] = await sql`SELECT context FROM auth.app_logins WHERE id=${started.requestId}::uuid`;
    expect(AppLoginContextSchema.safeParse(storedContext.context).success).toBe(true);
    await until(() => pushes.length > 0);
    await Bun.sleep(50);
    expect(pushes).toEqual([
      { appOrigin: cfg.appOrigin, body: { token, cloudOrigin: cfg.issuer, requestRef: started.requestId }, committed: true },
    ]);
    const [login] = await sql<{ challenge: string }[]>`SELECT challenge FROM auth.app_logins WHERE id=${started.requestId}::uuid`;
    for (const secret of [started.browserSecret, started.comparison, login!.challenge, owner.uid, owner.mail])
      expect(JSON.stringify(pushes)).not.toContain(secret);

    pushes.length = 0;
    await service.startLogin(`missing-${crypto.randomUUID()}`, "login");
    await Bun.sleep(100);
    expect(pushes).toEqual([]);

    pushStatus = 410;
    await sql`UPDATE auth.app_devices SET login_wake_at=now()-interval '31 seconds' WHERE user_id=${owner.id}::uuid`;
    await service.startLogin(owner.uid, "login");
    const tokens = () =>
      sql<
        { push_token: string | null }[]
      >`SELECT push_token FROM auth.app_devices WHERE id IN (${device.id}::uuid, ${second.id}::uuid, ${stranger.id}::uuid) ORDER BY push_token NULLS FIRST`;
    await until(async () => (await tokens())[1]?.push_token === null);
    expect((await tokens()).map((row) => row.push_token)).toEqual([null, null, "S".repeat(43)]);
    pushes.length = 0;
    await service.startLogin(owner.uid, "login");
    await Bun.sleep(100);
    expect(pushes).toEqual([]);
    pushStatus = 202;

    // Push tokens are strict, signed parameters.
    const tampered = await proof(device, { operation: "push", token });
    tampered.proof.command = { operation: "push", token: "Q".repeat(43) };
    await expect(service.deviceCommand(tampered, deviceActions)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const invalid = await proof(device, { operation: "push", token });
    const body = { ...invalid, proof: { ...invalid.proof, command: { operation: "push", token: "short" } } };
    expect((await post("/device", body, undefined, cfg.appOrigin)).status).toBe(400);
  });

  test("a device reads only its own account and device record", async () => {
    const owner = await account(),
      other = await account();
    await sql`UPDATE auth.users SET display_name='Ada Lovelace' WHERE id=${owner.id}::uuid`;
    await sql`UPDATE auth.users SET mail=NULL WHERE id=${other.id}::uuid`;
    const device = await enroll(owner),
      stranger = await enroll(other),
      elsewhere = await enroll(owner, cloudB);
    const [row] = await sql<{ created_at: Date }[]>`SELECT created_at FROM auth.app_devices WHERE id=${device.id}::uuid`;
    const response = await post("/device", await proof(device, { operation: "account" }), undefined, cfg.appOrigin);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(cfg.appOrigin);
    const body = AppDeviceAccountSchema.parse(await response.json());
    // Exactly these fields: no user or device id, key, push token, or another user's data.
    expect(body).toEqual({
      account: { uid: owner.uid, displayName: "Ada Lovelace", mail: owner.mail },
      device: { name: "Test device", createdAt: row!.created_at.toISOString() },
    });
    expect(await service.deviceCommand(await proof(stranger, { operation: "account" }), deviceActions)).toEqual({
      account: { uid: other.uid, displayName: "", mail: null },
      device: { name: "Test device", createdAt: expect.any(String) },
    });
    expect(await cloudB.deviceCommand(await proof(elsewhere, { operation: "account" }), deviceActions)).toMatchObject({
      account: { uid: owner.uid },
    });
    // Another device's key, another Cloud, a replayed or tampered proof, and a revoked device learn nothing.
    await expect(
      service.deviceCommand(await proof(stranger, { operation: "account" }, { deviceId: device.id }), deviceActions),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(cloudB.deviceCommand(await proof(device, { operation: "account" }), deviceActions)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const replay = await proof(device, { operation: "account" });
    await service.deviceCommand(replay, deviceActions);
    await expect(service.deviceCommand(replay, deviceActions)).rejects.toMatchObject({ code: "CONFLICT" });
    const tampered = await proof(device, { operation: "pending" });
    await expect(
      service.deviceCommand({ ...tampered, proof: { ...tampered.proof, command: { operation: "account" } } }, deviceActions),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await post("/device", await proof(device, { operation: "account" }), undefined, "https://evil.example.test")).status).toBe(403);
    await service.mutateDevice(owner.actor, device.id);
    await expect(service.deviceCommand(await proof(device, { operation: "account" }), deviceActions)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  test("two Clouds and two accounts cannot reuse keys, requests, or signatures", async () => {
    const owner = await account(),
      other = await account();
    const a = await enroll(owner),
      b = await enroll(owner, cloudB),
      stranger = await enroll(other);
    const started = await service.startLogin(owner.mail, "login");
    const request = await proof(a, { operation: "pending" });
    await expect(cloudB.deviceCommand(request, deviceActions)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.deviceCommand(await proof(stranger, { operation: "pending" }, { deviceId: a.id }), deviceActions),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await cloudB.deviceCommand(await proof(b, { operation: "pending" }), deviceActions)).toMatchObject({ requests: [] });
    expect(await service.deviceCommand(await proof(stranger, { operation: "pending" }), deviceActions)).toMatchObject({ requests: [] });
    await approve(a, started.requestId);
    await expect(cloudB.consumeLogin(started.requestId, started.browserSecret)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await service.consumeLogin(started.requestId, started.browserSecret)).toBe(owner.id);
  });

  test("signed commands reject replay, body tampering, wrong clock and request mixups", async () => {
    const owner = await account(),
      device = await enroll(owner);
    const request = await proof(device, { operation: "pending" });
    await service.deviceCommand(request, deviceActions);
    await expect(service.deviceCommand(request, deviceActions)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      service.deviceCommand({ ...request, proof: { ...request.proof, command: { operation: "revoke" } } }, deviceActions),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.deviceCommand(await proof(device, { operation: "pending" }, { issuedAt: 1, expiresAt: 61 }), deviceActions),
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
        deviceActions,
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

  test("only administrators list and revoke another account's devices, idempotently and audited", async () => {
    const owner = await account(),
      admin = await account(),
      other = await account();
    admin.actor.admin = true;
    const device = await enroll(owner),
      spare = await enroll(owner),
      unrelated = await enroll(other);
    const started = await service.startLogin(owner.uid, "login");
    await approve(device, started.requestId);

    for (const actor of [other.actor, { ...admin.actor, admin: false }, { ...owner.actor, admin: false }]) {
      await expect(service.listUserDevices(actor, owner.id)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      await expect(service.revokeUserDevice(actor, owner.id, device.id)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    }
    expect((await service.listUserDevices(admin.actor, owner.id)).map((item) => item.id).sort()).toEqual([device.id, spare.id].sort());
    // A device is addressed together with its account.
    await expect(service.revokeUserDevice(admin.actor, other.id, device.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.revokeUserDevice(admin.actor, owner.id, unrelated.id)).rejects.toMatchObject({ status: 404 });

    // Revocation works while app sign-in is switched off: it only removes access.
    cfg.enabled = false;
    const revoked = await service.revokeUserDevice(admin.actor, owner.id, device.id);
    expect(revoked).toMatchObject({ revoked: true, device: { id: device.id, name: "Test device", revokedAt: expect.any(String) } });
    expect(await service.revokeUserDevice(admin.actor, owner.id, device.id)).toMatchObject({ revoked: false, device: { id: device.id } });
    cfg.enabled = true;

    // The revoked device can neither poll, approve, nor complete the approval it already gave.
    await expect(service.consumeLogin(started.requestId, started.browserSecret)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.deviceCommand(await proof(device, { operation: "pending" }), deviceActions)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const next = await service.startLogin(owner.uid, "login");
    const [login] = await sql<{ challenge: string }[]>`SELECT challenge FROM auth.app_logins WHERE id=${next.requestId}::uuid`;
    await expect(
      service.deviceCommand(
        await proof(device, {
          operation: "decide",
          requestId: next.requestId,
          challenge: login!.challenge,
          comparison: next.comparison,
          decision: "approve",
        }),
        deviceActions,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Other devices keep working, and the owner's own list still shows the revocation.
    await approve(spare, next.requestId);
    expect(await service.consumeLogin(next.requestId, next.browserSecret)).toBe(owner.id);
    expect((await service.listUserDevices(admin.actor, owner.id)).map((item) => item.id)).toEqual([spare.id]);
    expect((await service.listDevices(owner.actor)).items.find((item) => item.id === device.id)?.revokedAt).not.toBeNull();
    expect(await service.deviceCommand(await proof(unrelated, { operation: "pending" }), deviceActions)).toMatchObject({ requests: [] });

    const events = await sql<
      { actor_user_id: string; target_type: string; metadata: { targetUserId?: string } }[]
    >`SELECT actor_user_id, target_type, metadata FROM audit.events WHERE action='auth.app.device.revoke' AND target_id=${device.id}`;
    expect(events).toEqual([{ actor_user_id: admin.id, target_type: "app_device", metadata: { targetUserId: owner.id } }]);
  });

  test("signing out everywhere revokes every paired device of the account", async () => {
    const owner = await account(),
      other = await account();
    const device = await enroll(owner),
      elsewhere = await enroll(owner, cloudB),
      unrelated = await enroll(other);
    const started = await service.startLogin(owner.uid, "login");
    await approve(device, started.requestId);
    const key = await keys();
    const pairing = await service.startPairing(owner.actor);
    const claim = { pairingId: pairing.pairingId, secret: pairing.secret, publicKey: key.publicKey, name: "In flight" };
    const claimed = await service.claimPairing({
      ...claim,
      signature: await sign(key.privateKey, appPairingProofMessage(cfg.issuer, claim)),
    });

    await session.revokeAllForUser(owner.id);

    await expect(service.consumeLogin(started.requestId, started.browserSecret)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.deviceCommand(await proof(device, { operation: "pending" }), deviceActions)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(cloudB.deviceCommand(await proof(elsewhere, { operation: "pending" }), deviceActions)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // A pairing started from the revoked session cannot add a device afterwards.
    await expect(service.confirmPairing(owner.actor, pairing.pairingId, claimed.comparison)).rejects.toMatchObject({
      code: "REAUTHENTICATE",
    });
    const rows = await sql<
      { id: string; revoked_at: Date | null }[]
    >`SELECT id, revoked_at FROM auth.app_devices WHERE user_id=${owner.id}::uuid`;
    expect(rows.map((row) => row.id).sort()).toEqual([device.id, elsewhere.id].sort());
    expect(rows.every((row) => row.revoked_at)).toBe(true);
    expect(await service.deviceCommand(await proof(unrelated, { operation: "pending" }), deviceActions)).toMatchObject({ requests: [] });
    // Each device revocation is audited as a system consequence of the sign-out.
    const events = await sql<
      { target_id: string; actor_user_id: string | null; metadata: Record<string, unknown> }[]
    >`SELECT target_id, actor_user_id, metadata FROM audit.events WHERE action='auth.app.device.revoke' AND metadata->>'targetUserId'=${owner.id} ORDER BY target_id`;
    expect(events).toEqual(
      [device.id, elsewhere.id].sort().map((id) => ({
        target_id: id,
        actor_user_id: null,
        metadata: { targetUserId: owner.id, provenance: "system", reason: "sign_out_everywhere" },
      })),
    );

    // After signing in again, the owner pairs a new device that works.
    await createTestSession(owner.id);
    const [family] = await sql<
      { sid: string }[]
    >`SELECT sid FROM auth.session_families WHERE user_id=${owner.id}::uuid ORDER BY issued_at DESC LIMIT 1`;
    const replacement = await enroll({ ...owner, actor: { ...owner.actor, sid: family!.sid } });
    const again = await service.startLogin(owner.uid, "login");
    await approve(replacement, again.requestId);
    expect(await service.consumeLogin(again.requestId, again.browserSecret)).toBe(owner.id);
  });

  test("an assisted pairing started before a sign-out everywhere cannot be confirmed", async () => {
    const owner = await account(),
      admin = await account();
    admin.actor.admin = true;
    cfg.adminPairing = true;
    const claimAssisted = async () => {
      const key = await keys();
      const pairing = await service.startPairing(admin.actor, owner.id);
      const claim = { pairingId: pairing.pairingId, secret: pairing.secret, publicKey: key.publicKey, name: "Assisted" };
      const claimed = await service.claimPairing({
        ...claim,
        signature: await sign(key.privateKey, appPairingProofMessage(cfg.issuer, claim)),
      });
      return { pairing, claimed };
    };
    const stale = await claimAssisted();

    await session.revokeAllForUser(owner.id);

    // The administrator's session is still current, but the pairing belongs to the ended epoch.
    await expect(service.inspectPairing(admin.actor, stale.pairing.pairingId)).rejects.toMatchObject({ code: "UNAVAILABLE", status: 404 });
    await expect(service.confirmPairing(admin.actor, stale.pairing.pairingId, stale.claimed.comparison)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await sql`SELECT id FROM auth.app_devices WHERE user_id=${owner.id}::uuid`).toHaveLength(0);
    await service.cancelPairing(admin.actor, stale.pairing.pairingId);

    // A pairing the administrator starts afterwards works as usual.
    const fresh = await claimAssisted();
    expect(await service.inspectPairing(admin.actor, fresh.pairing.pairingId)).toMatchObject({ state: "claimed" });
    await service.confirmPairing(admin.actor, fresh.pairing.pairingId, fresh.claimed.comparison);
    expect(await service.listUserDevices(admin.actor, owner.id)).toEqual([
      expect.objectContaining({ id: fresh.claimed.deviceId, assisted: true, revokedAt: null }),
    ]);
  });

  test.each([
    ["self", "REAUTHENTICATE"],
    ["assisted", "CONFLICT"],
  ] as const)("a pairing confirmed during a sign-out everywhere cannot leave an active device (%s)", async (kind, code) => {
    const owner = await account(),
      admin = await account();
    admin.actor.admin = true;
    cfg.adminPairing = true;
    const initiator = kind === "self" ? owner.actor : admin.actor;
    const key = await keys();
    const pairing = await service.startPairing(initiator, owner.id);
    const claim = { pairingId: pairing.pairingId, secret: pairing.secret, publicKey: key.publicKey, name: "Racing" };
    const claimed = await service.claimPairing({
      ...claim,
      signature: await sign(key.privateKey, appPairingProofMessage(cfg.issuer, claim)),
    });
    // Counts the sessions queued behind the lock holder, directly or behind each other.
    const queued = async (holder: number, count: number) => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const [row] = await sql<{ waiting: number }[]>`WITH RECURSIVE queue(pid) AS (
            SELECT ${holder}::int
            UNION SELECT a.pid FROM pg_stat_activity a JOIN queue q ON q.pid = ANY(pg_blocking_pids(a.pid))
          ) SELECT count(*)::int - 1 AS waiting FROM queue`;
        if (row!.waiting >= count) return;
        await Bun.sleep(10);
      }
      throw new Error(`Expected ${count} sessions waiting for the account row`);
    };
    // Hold the account row, queue the sign-out first and the confirmation behind it. Checking the
    // session or epoch before taking the lock would pass with the old epoch and insert the device afterwards.
    const held = Promise.withResolvers<number>(),
      release = Promise.withResolvers<void>();
    const holder = sql.begin(async (tx) => {
      const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM auth.users WHERE id=${owner.id}::uuid FOR UPDATE`;
      held.resolve(row!.pid);
      await release.promise;
    });
    try {
      const pid = await held.promise;
      const signOut = session.revokeAllForUser(owner.id);
      await queued(pid, 1);
      // Settle into a value: Bun's expect(...).rejects would wait for it before the lock is released.
      const confirmed = service.confirmPairing(initiator, pairing.pairingId, claimed.comparison).then(
        () => null,
        (error: unknown) => error,
      );
      await queued(pid, 2);
      release.resolve();
      await signOut;
      expect(await confirmed).toMatchObject({ code });
    } finally {
      release.resolve();
      await holder;
    }
    expect(await sql`SELECT id FROM auth.app_devices WHERE user_id=${owner.id}::uuid AND revoked_at IS NULL`).toHaveLength(0);
  });

  test("request-time expiry ends sessions but keeps paired devices for when it is lifted", async () => {
    for (const authenticate of [session.authenticate, session.authenticateUserId]) {
      const owner = await account(),
        device = await enroll(owner);
      expect(await authenticate(owner.token)).not.toBeNull();
      await sql`UPDATE auth.users SET account_expires=now()-interval '1 minute' WHERE id=${owner.id}::uuid`;
      expect(await authenticate(owner.token)).toBeNull();
      await expect(service.deviceCommand(await proof(device, { operation: "pending" }), deviceActions)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      await sql`UPDATE auth.users SET account_expires=NULL WHERE id=${owner.id}::uuid`;
      // The expired request ended the session; the device works again without re-pairing.
      expect(await authenticate(owner.token)).toBeNull();
      expect(await service.deviceCommand(await proof(device, { operation: "pending" }), deviceActions)).toMatchObject({ requests: [] });
    }
  });

  test("account epoch changes, expiry and deletion invalidate credentials and requests", async () => {
    const owner = await account(),
      device = await enroll(owner);
    const started = await service.startLogin(owner.uid, "login");
    await approve(device, started.requestId);
    await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${owner.id}::uuid`;
    await expect(service.consumeLogin(started.requestId, started.browserSecret)).rejects.toMatchObject({ code: "CONFLICT" });
    await sql`UPDATE auth.users SET account_expires=now()-interval '1 minute' WHERE id=${owner.id}::uuid`;
    await expect(service.deviceCommand(await proof(device, { operation: "pending" }), deviceActions)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await sql`DELETE FROM auth.users WHERE id=${owner.id}::uuid`;
    await expect(service.deviceCommand(await proof(device, { operation: "pending" }), deviceActions)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
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

  test("accounts without email skip the email-only enrollment notice but keep its audit entry", async () => {
    await sql`UPDATE auth.app_devices SET notified_at=now()`;
    const owner = await account();
    await sql`UPDATE auth.users SET mail=NULL WHERE id=${owner.id}::uuid`;
    const device = await enroll(owner);
    const delivered: string[] = [];
    await service.maintain(async (notice) => {
      delivered.push(notice.deviceId);
    });
    expect(delivered).toEqual([]);
    const [row] = await sql<{ notified_at: Date | null }[]>`SELECT notified_at FROM auth.app_devices WHERE id=${device.id}::uuid`;
    expect(row?.notified_at).not.toBeNull();
    expect(await sql`SELECT id FROM audit.events WHERE action='auth.app.device.enroll' AND target_id=${device.id}`).toHaveLength(1);
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
    const result = await service.deviceCommand(await proof(device, { operation: "pending" }), deviceActions);
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

  const noActions = { inbox: async () => ({ actions: [], moreActions: 0 }), view: async () => null, decide: async () => false };
  const terminalClients = new Map<string, { id: string; name: string }>();
  const terminalDecisions: Parameters<AppTerminalLogins["decide"]>[1][] = [];
  const terminal: AppTerminalLogins = {
    describe: async (_tx, ids) =>
      new Map(
        ids.flatMap((id) => {
          const client = terminalClients.get(id);
          return client ? [[id, client] as const] : [];
        }),
      ),
    decide: async (tx, input) => {
      // Visible here only through the decision transaction; a false hook must roll this back too.
      await tx`UPDATE auth.users SET display_name='Decision hook' WHERE id=${input.user.id}::uuid`;
      terminalDecisions.push(input);
      return terminalClients.has(input.deviceAuthorizationId);
    },
  };
  const terminalStart = async (identifier: string, access = true) => {
    const deviceAuthorizationId = crypto.randomUUID();
    terminalClients.set(deviceAuthorizationId, { id: "test-cli", name: "Test\nCLI\u202e" });
    const input = { deviceAuthorizationId, identifier, clientId: "test-cli", scopes: ["openid", "profile"], lifetimeSeconds: 3600 };
    const response = await service.startTerminalLogin(input, async () => access);
    const [row] = await sql<{ id: string; user_id: string | null; challenge: string; comparison: string; state: string }[]>`
      SELECT id,user_id,challenge,comparison,state FROM auth.app_logins WHERE device_authorization_id=${deviceAuthorizationId}::uuid`;
    if (!row) throw new Error("Missing terminal request");
    return { ...row, response, input };
  };
  const terminalDecision = (
    login: Awaited<ReturnType<typeof terminalStart>>,
    decision: "approve" | "deny" = "approve",
  ): AppDeviceProof["command"] => ({
    operation: "decide",
    requestId: login.id,
    challenge: login.challenge,
    comparison: login.comparison,
    decision,
  });

  test("terminal decoys cover unknown, ambiguous, unpaired, expired, policy, client and budget failures", async () => {
    const real = await account(),
      unpaired = await account(),
      expired = await account(),
      blocked = await account();
    const device = await enroll(real);
    await service.deviceCommand(await proof(device, { operation: "inbox", accept: ["terminal-logins"] }), noActions, terminal);
    await service.deviceCommand(await proof(device, { operation: "push", token: "D".repeat(43) }), noActions);
    await enroll(expired);
    await enroll(blocked);
    await sql`UPDATE auth.users SET account_expires=now()-interval '1 second' WHERE id=${expired.id}::uuid`;
    const ambiguous = await account();
    await sql`UPDATE auth.users SET mail=${real.uid} WHERE id=${ambiguous.id}::uuid`;
    const start = pushes.length;
    const results = [];
    for (const identifier of [`missing-${crypto.randomUUID()}`, real.uid, unpaired.mail, expired.mail])
      results.push(await terminalStart(identifier));
    await settings.set("user.category.login.enabled", false);
    results.push(await terminalStart(blocked.uid));
    await settings.remove("user.category.login.enabled");
    results.push(await terminalStart(blocked.uid, false));
    await sql`UPDATE auth.users SET mail=NULL WHERE id=${ambiguous.id}::uuid`;
    const budgetOwner = await account();
    await enroll(budgetOwner);
    for (let i = 0; i < 3; i++) await service.startLogin(budgetOwner.uid, "login");
    for (let i = 0; i < 2; i++) expect((await terminalStart(budgetOwner.mail)).user_id).toBe(budgetOwner.id);
    results.push(await terminalStart(budgetOwner.uid));
    for (const result of results) {
      expect(result.user_id).toBeNull();
      expect(Object.keys(result.response)).toEqual(["comparison", "expiresAt"]);
      expect(result.response.comparison).toMatch(/^\d{6}$/);
      expect(new Date(result.response.expiresAt).toISOString()).toBe(result.response.expiresAt);
    }
    let checked = false;
    await service.startTerminalLogin({ ...results[0]!.input, deviceAuthorizationId: crypto.randomUUID() }, async (_tx, subject) => {
      checked = true;
      expect(subject.id).not.toBe(real.id);
      expect(subject.profile).toBe("user");
      return true;
    });
    expect(checked).toBe(true);
    expect(pushes).toHaveLength(start);
    await expect(service.startTerminalLogin(results[0]!.input, async () => true)).rejects.toMatchObject({ status: 409 });
    expect(await service.deviceCommand(await proof(device, { operation: "pending" }), noActions)).toMatchObject({
      requests: expect.any(Array),
    });
  });

  const readContextLogins = async (
    device: Awaited<ReturnType<typeof enroll>>,
    operation: "pending" | "inbox",
    address?: string,
    target = service,
  ) => {
    const response = AppDeviceResponseSchema.parse(
      await target.deviceCommand(await proof(device, { operation, accept: ["login-context"] }), noActions, undefined, { address }),
    );
    if ("requests" in response) return response.requests;
    if ("logins" in response) return response.logins;
    throw new Error("Expected a login list");
  };

  test("context upgrade matrix preserves old response bytes and old strict parsing on both commands", async () => {
    const owner = await account(),
      device = await enroll(owner);
    const started = await service.startLogin(owner.uid, "login", contextRequest());
    const [row] = await sql`SELECT context FROM auth.app_logins WHERE id=${started.requestId}::uuid`;
    expect(AppLoginContextSchema.safeParse(row.context).success).toBe(true);
    const read = async (operation: "pending" | "inbox", optedIn = false) => {
      const response = await post(
        "/device",
        await proof(device, { operation, ...(optedIn ? { accept: ["login-context"] as ["login-context"] } : {}) }),
        undefined,
        cfg.appOrigin,
      );
      expect(response.status).toBe(200);
      return response.text();
    };
    await sql`UPDATE auth.app_logins SET context=NULL WHERE id=${started.requestId}::uuid`;
    const pendingBefore = await read("pending"),
      inboxBefore = await read("inbox");
    // A pre-upgrade request remains readable by an opted-in app too.
    expect(JSON.parse(await read("pending", true)).requests[0].context).toBeUndefined();
    await sql`UPDATE auth.app_logins SET context=${JSON.stringify(row.context)}::text::jsonb WHERE id=${started.requestId}::uuid`;
    for (const [operation, before] of [
      ["pending", pendingBefore],
      ["inbox", inboxBefore],
    ] as const) {
      const legacy = await read(operation);
      expect(legacy).toBe(before);
      const key = operation === "pending" ? "requests" : "logins";
      for (const login of JSON.parse(legacy)[key]) expect(OldPendingLoginSchema.safeParse(login).success).toBe(true);
      const opted = JSON.parse(await read(operation, true));
      expect(AppLoginContextSchema.parse(opted[key][0].context)).toEqual(row.context);
      expect(OldPendingLoginSchema.safeParse(opted[key][0]).success).toBe(false);
    }
    await sql`UPDATE auth.app_logins SET context=${JSON.stringify({ invalid: true })}::text::jsonb WHERE id=${started.requestId}::uuid`;
    for (const operation of ["pending", "inbox"] as const) expect((await readContextLogins(device, operation))[0]?.context).toBeUndefined();
  });

  test("real and decoy HTTP starts have equal shapes and headers, even with browser cookies", async () => {
    const owner = await account();
    for (const cookie of [undefined, `cloud_browser=${"C".repeat(43)}; __Host-cloud_browser=${"C".repeat(43)}`]) {
      const start = (identifier: string) =>
        routes.request("/login/start", {
          method: "POST",
          headers: {
            origin: cfg.issuer,
            "content-type": "application/json",
            "user-agent": "Firefox/130.0 (X11; Linux)",
            "x-forwarded-for": "8.8.8.8",
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify({ identifier, category: "login" }),
        });
      const real = await start(owner.uid),
        decoy = await start(`missing-${crypto.randomUUID()}`);
      expect(real.status).toBe(202);
      expect(decoy.status).toBe(real.status);
      // The shared per-IP rate-limit budget counts down between the two calls; every other header is equal.
      const headers = (response: Response) => [...response.headers].filter(([name]) => name !== "x-ratelimit-remaining");
      expect([...decoy.headers.keys()]).toEqual([...real.headers.keys()]);
      expect(headers(decoy)).toEqual(headers(real));
      expect(real.headers.has("set-cookie")).toBe(false);
      expect(decoy.headers.has("set-cookie")).toBe(false);
      const realBody = await real.json(),
        decoyBody = await decoy.json();
      const shape = (body: Record<string, unknown>) => Object.entries(body).map(([key, value]) => [key, typeof value]);
      expect(shape(decoyBody)).toEqual(shape(realBody));
      const [realRow] = await sql`SELECT context FROM auth.app_logins WHERE id=${realBody.requestId}::uuid`;
      const [decoyRow] = await sql`SELECT user_id,context FROM auth.app_logins WHERE id=${decoyBody.requestId}::uuid`;
      expect(realRow.context).toMatchObject({ browser: "firefox", os: "linux" });
      expect(decoyRow.user_id).toBeNull();
      expect(decoyRow.context).toBeNull();
      const redis = await requestCacheRedis();
      expect(await redis.exists(appLoginAddressKey(realBody.requestId))).toBe(true);
      expect(await redis.exists(appLoginAddressKey(decoyBody.requestId))).toBe(true);
      await valkeyAppLoginAddressStore.forget(realBody.requestId);
      await valkeyAppLoginAddressStore.forget(decoyBody.requestId);
    }
  });

  test("country history returns both facts inside one account's 90-day window", async () => {
    const owner = await account(),
      other = await account(),
      now = new Date();
    const cutoff = new Date(now.getTime() - 90 * 86_400_000);
    await sql`INSERT INTO auth.sign_in_countries(user_id,country,last_seen_at) VALUES
      (${owner.id}::uuid,'AT',${new Date(cutoff.getTime() + 1)}),
      (${owner.id}::uuid,'DE',${cutoff}),(${other.id}::uuid,'DE',${now})`;
    expect(await countryHistory(sql, { userId: owner.id, country: "AT", now })).toEqual({ seen: true, any: true });
    expect(await countryHistory(sql, { userId: owner.id, country: "DE", now })).toEqual({ seen: false, any: true });
    expect(await countryHistory(sql, { userId: owner.id, country: null, now })).toEqual({ seen: false, any: true });
    expect(await countryHistory(sql, { country: "DE", now })).toEqual({ seen: false, any: false });
    await sql`DELETE FROM auth.sign_in_countries WHERE user_id=${owner.id}::uuid AND country='AT'`;
    expect(await countryHistory(sql, { userId: owner.id, country: "DE", now })).toEqual({ seen: false, any: false });
  });

  test("phone sees the Core level table and introduction suppresses history", async () => {
    const [saved] = await sql<
      { started_at: Date; geoip_since: Date | null }[]
    >`SELECT started_at,geoip_since FROM auth.device_trust_state WHERE id=true`;
    const at = new Date(),
      past = (days: number) => new Date(at.getTime() - days * 86_400_000);
    try {
      await sql`UPDATE auth.device_trust_state SET started_at=${past(30)},geoip_since=${past(30)} WHERE id=true`;
      const rows = [
        [true, true, true, "info"],
        [true, false, true, "hint"],
        [false, true, true, "hint"],
        [false, false, false, "hint"],
        [false, false, true, "warn"],
      ] as const;
      for (const [known, seen, any, level] of rows) {
        const owner = await account(),
          device = await enroll(owner),
          cookie = "K".repeat(43);
        if (known)
          await sql`INSERT INTO auth.known_browsers(user_id,browser_hash,browser,os,first_seen_at,last_seen_at)
          VALUES (${owner.id}::uuid,${browserHash(owner.id, cookie)},'firefox','linux',${past(7)},${at})`;
        if (any)
          await sql`INSERT INTO auth.sign_in_countries(user_id,country,last_seen_at) VALUES (${owner.id}::uuid,${seen ? "AT" : "DE"},${at})`;
        await service.startLogin(owner.uid, "login", contextRequest({ cookie }));
        for (const operation of ["pending", "inbox"] as const)
          expect((await readContextLogins(device, operation))[0]?.context).toMatchObject({
            level,
            history: { knownSince: known ? past(7).toISOString() : null, newCountry: !seen, countriesSince: past(30).toISOString() },
          });
      }
      await sql`UPDATE auth.device_trust_state SET started_at=${at} WHERE id=true`;
      const owner = await account(),
        device = await enroll(owner);
      await service.startLogin(owner.uid, "login", contextRequest());
      expect((await readContextLogins(device, "pending"))[0]?.context).toMatchObject({ level: "info", history: null });
    } finally {
      await sql`UPDATE auth.device_trust_state SET started_at=${saved!.started_at},geoip_since=${saved!.geoip_since} WHERE id=true`;
    }
  });

  test("S5 expires with the request, matches only the public prefix, and is deleted on either decision", async () => {
    const owner = await account(),
      device = await enroll(owner),
      redis = await requestCacheRedis();
    for (const [prefix, same, different, decision] of [
      ["8.8.8.8", "8.8.8.8", "8.8.4.4", "approve"],
      ["2606:4700:4700:1::/64", "2606:4700:4700:1::abcd", "2606:4700:4700:2::1", "deny"],
    ] as const) {
      const started = await service.startLogin(owner.uid, "login", contextRequest({ prefix }));
      const key = appLoginAddressKey(started.requestId);
      const ttl = Number(await redis.send("PTTL", [key]));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(APP_APPROVAL_LIMITS.loginSeconds * 1000);
      expect(ttl).toBeLessThanOrEqual(Date.parse(started.expiresAt) - Date.now() + 100);
      const stored = JSON.parse((await redis.get(key))!);
      expect(Object.keys(stored)).toEqual(["salt", "digest"]);
      expect(stored.salt).toMatch(/^[a-f0-9]{32}$/);
      expect(JSON.stringify(stored)).not.toContain(prefix);
      for (const operation of ["pending", "inbox"] as const) {
        expect((await readContextLogins(device, operation, same))[0]?.context?.sameNetwork).toBe(true);
        expect((await readContextLogins(device, operation, different))[0]?.context?.sameNetwork).toBeUndefined();
        expect((await readContextLogins(device, operation, "192.168.1.1"))[0]?.context?.sameNetwork).toBeUndefined();
      }
      // Route forwards the phone address too.
      const response = await routes.request("/device", {
        method: "POST",
        headers: { origin: cfg.appOrigin, "content-type": "application/json", "x-forwarded-for": same },
        body: JSON.stringify(await proof(device, { operation: "pending", accept: ["login-context"] })),
      });
      expect((await response.json()).requests[0].context.sameNetwork).toBe(true);
      const [row] = await sql`SELECT context FROM auth.app_logins WHERE id=${started.requestId}::uuid`;
      expect(row.context.sameNetwork).toBeUndefined();
      await approve(device, started.requestId, service, decision);
      expect(await redis.exists(key)).toBe(false);
      const [event] =
        await sql`SELECT metadata FROM audit.events WHERE action=${`auth.app.login.${decision}`} AND metadata->>'requestId'=${started.requestId}`;
      expect(event.metadata).toEqual({ requestId: started.requestId, level: row.context.level });
    }
  });

  test("every failing address-store operation is best effort, outside the SQL transaction", async () => {
    const calls: string[] = [];
    let requestId: string | undefined;
    const fail = async (operation: string, id?: string): Promise<never> => {
      calls.push(operation);
      if (id) {
        const [committed] = await sql`SELECT state FROM auth.app_logins WHERE id=${id}::uuid`;
        expect(committed).toBeDefined();
        expect(committed.state).toBe(operation === "forget" ? "denied" : "pending");
      }
      throw new Error("cache unavailable");
    };
    const addresses: AppLoginAddressStore = {
      remember: (id) => fail("remember", id),
      read: () => fail("read", requestId),
      forget: (id) => fail("forget", id),
    };
    const target = createAppApprovalService(sql, async () => cfg, hints, pushSender, addresses);
    const owner = await account(),
      device = await enroll(owner, target);
    const started = await target.startLogin(owner.uid, "login", contextRequest({ prefix: "8.8.8.8" }));
    requestId = started.requestId;
    const legacy = AppDeviceResponseSchema.parse(
      await target.deviceCommand(await proof(device, { operation: "pending" }), noActions, undefined, { address: "8.8.8.8" }),
    );
    expect("requests" in legacy && legacy.requests[0]?.context).toBeUndefined();
    expect(calls).toEqual(["remember"]);
    for (const operation of ["pending", "inbox"] as const) {
      const context = (await readContextLogins(device, operation, "8.8.8.8", target))[0]?.context;
      expect(context).toBeDefined();
      expect(context?.sameNetwork).toBeUndefined();
    }
    await approve(device, requestId, target, "deny");
    expect(calls).toEqual(["remember", "read", "read", "forget"]);
  });

  test("context and terminal consent share the five-request budget and the unchanged inbox byte budget", async () => {
    const owner = await account(),
      device = await enroll(owner);
    const browserIds: string[] = [];
    for (let i = 0; i < 5; i++)
      browserIds.push(
        (await service.startLogin(owner.uid, "login", contextRequest({ city: "界".repeat(32), network: '"\\'.repeat(48) }))).requestId,
      );
    expect((await terminalStart(owner.uid)).user_id).toBeNull();
    const five = await readContextLogins(device, "pending");
    expect(five).toHaveLength(5);
    expect(five.every((row) => row.context)).toBe(true);
    for (const id of browserIds.slice(3)) await approve(device, id, service, "deny");
    const terminals = [await terminalStart(owner.uid), await terminalStart(owner.uid)];
    const action = {
      actionId: crypto.randomUUID(),
      app: { id: "a".repeat(60), name: "😀".repeat(60) },
      requester: { app: { id: "assistant", name: "😀".repeat(60) }, title: "😀".repeat(80) },
      assurance: "confirm" as const,
      sentence: "😀".repeat(120),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    const actions = { ...noActions, inbox: async () => ({ actions: Array.from({ length: 5 }, () => ({ ...action })), moreActions: 0 }) };
    const response = await service.deviceCommand(
      await proof(device, { operation: "inbox", accept: ["terminal-logins", "login-context"] }),
      actions,
      terminal,
    );
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(8192);
    const inbox = AppDeviceInboxSchema.parse(response);
    expect(inbox.logins.map((row) => row.requestId).sort()).toEqual([...browserIds.slice(0, 3), ...terminals.map((row) => row.id)].sort());
    expect(inbox.actions.length + inbox.moreActions).toBe(5);
    for (const login of inbox.logins) expect(login.context !== undefined).toBe(login.terminal === undefined);
    for (const id of terminals.map((row) => row.id)) {
      const [stored] = await sql`SELECT context FROM auth.app_logins WHERE id=${id}::uuid`;
      expect(stored.context).toBeNull();
    }
    const [stored] = await sql`SELECT accepts FROM auth.app_devices WHERE id=${device.id}::uuid`;
    expect(stored.accepts).toEqual(["terminal-logins", "login-context"]);
  });

  test("context migration is idempotent and PostgreSQL rejects more than 512 JSONB text bytes", async () => {
    const { migrate } = await import("../../../core/src/migrate/core/app-approval");
    await migrate();
    await migrate();
    // An INSERT exercises the CHECK independently of the service's safe builder. A Bun SQL query is lazy:
    // `expect(...).rejects` needs the promise from `.execute()`, or it never runs and never settles.
    await expect(
      sql`INSERT INTO auth.app_logins(id,issuer,category,browser_hash,challenge,comparison,expires_at,context)
      VALUES (${crypto.randomUUID()}::uuid,${cfg.issuer},'login','test','test','000123',${new Date(Date.now() + 300_000)},${JSON.stringify({ city: "界".repeat(180) })}::text::jsonb)`.execute(),
    ).rejects.toMatchObject({ constraint: "app_logins_context_bytes" });
    const owner = await account();
    for (const name of ["界".repeat(32), '"\\'.repeat(48)]) {
      const started = await service.startLogin(owner.uid, "login", contextRequest({ city: name, network: name }));
      const [row] =
        await sql`SELECT context,jsonb_typeof(context) AS type,octet_length(context::text) AS bytes FROM auth.app_logins WHERE id=${started.requestId}::uuid`;
      // A double-encoded value is a jsonb string scalar: it reads back as text and the CHECK measures its escapes.
      expect(row.type).toBe("object");
      expect(row.bytes).toBeLessThanOrEqual(512);
      expect(AppLoginContextSchema.safeParse(row.context).success).toBe(true);
    }
  });

  test("legacy pending/inbox bytes omit terminal logins; opted-in inbox describes only live authorizations", async () => {
    const owner = await account(),
      device = await enroll(owner);
    await service.startLogin(owner.uid, "login");
    const read = async (command: AppDeviceProof["command"]) => {
      const api = createAppApprovalRoutes(service, () => noActions, terminal);
      return (
        await api.request("/device", {
          method: "POST",
          headers: { "content-type": "application/json", origin: cfg.appOrigin },
          body: JSON.stringify(await proof(device, command)),
        })
      ).text();
    };
    const pending = await read({ operation: "pending" }),
      inbox = await read({ operation: "inbox" });
    const login = await terminalStart(owner.uid);
    expect(await read({ operation: "pending" })).toBe(pending);
    expect(await read({ operation: "inbox" })).toBe(inbox);
    const opted = AppDeviceInboxSchema.parse(JSON.parse(await read({ operation: "inbox", accept: ["terminal-logins"] })));
    expect(opted.logins.find((row) => row.requestId === login.id)?.terminal).toEqual({
      client: { id: "test-cli", name: "Test CLI" },
      scopes: ["openid", "profile"],
      lifetimeSeconds: 3600,
    });
    const [stored] = await sql`SELECT accepts FROM auth.app_devices WHERE id=${device.id}::uuid`;
    expect(stored.accepts).toEqual(["terminal-logins"]);
    terminalClients.delete(login.input.deviceAuthorizationId);
    expect(AppDeviceInboxSchema.parse(JSON.parse(await read({ operation: "inbox", accept: ["terminal-logins"] }))).logins).toHaveLength(1);
    await read({ operation: "inbox" });
    const [cleared] = await sql`SELECT accepts FROM auth.app_devices WHERE id=${device.id}::uuid`;
    expect(cleared.accepts).toEqual([]);
    expect(await service.deviceCommand(await proof(device, { operation: "inbox", accept: ["terminal-logins"] }), noActions)).toMatchObject({
      logins: expect.any(Array),
    });
  });

  test("terminal decisions require the deciding device to opt in", async () => {
    const owner = await account(),
      device = await enroll(owner),
      second = await enroll(owner);
    await service.deviceCommand(await proof(device, { operation: "inbox", accept: ["terminal-logins"] }), noActions, terminal);
    const login = await terminalStart(owner.uid);
    const command = terminalDecision(login);
    const api = createAppApprovalRoutes(service, () => noActions, terminal);
    const decide = async () =>
      api.request("/device", {
        method: "POST",
        headers: { "content-type": "application/json", origin: cfg.appOrigin },
        body: JSON.stringify(await proof(second, command)),
      });
    const rejected = await decide();
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ code: "CONFLICT" });
    const [pending] = await sql`SELECT state FROM auth.app_logins WHERE id=${login.id}::uuid`;
    expect(pending.state).toBe("pending");
    await service.deviceCommand(await proof(second, { operation: "inbox", accept: ["terminal-logins"] }), noActions, terminal);
    const approved = await decide();
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ state: "approved" });
  });

  test("terminal decide commits the hook and audit together, rejects stale, foreign, decoy and replayed requests", async () => {
    const owner = await account(),
      device = await enroll(owner),
      stranger = await account(),
      foreignDevice = await enroll(stranger);
    for (const phone of [device, foreignDevice])
      await service.deviceCommand(await proof(phone, { operation: "inbox", accept: ["terminal-logins"] }), noActions, terminal);
    const waiting = await terminalStart(owner.uid);
    const command = terminalDecision(waiting);
    await expect(service.deviceCommand(await proof(device, command), noActions)).rejects.toMatchObject({ status: 409 });
    terminalClients.delete(waiting.input.deviceAuthorizationId);
    await expect(service.deviceCommand(await proof(device, command), noActions, terminal)).rejects.toMatchObject({ status: 409 });
    const [unchanged] = await sql`SELECT state FROM auth.app_logins WHERE id=${waiting.id}::uuid`;
    const [accountRow] = await sql`SELECT display_name FROM auth.users WHERE id=${owner.id}::uuid`;
    expect(unchanged.state).toBe("pending");
    expect(accountRow.display_name).toBe("");
    terminalClients.set(waiting.input.deviceAuthorizationId, { id: "test-cli", name: "CLI" });
    await expect(service.deviceCommand(await proof(foreignDevice, command), noActions, terminal)).rejects.toMatchObject({ status: 409 });
    const decoy = await terminalStart("unknown@example.test");
    await expect(service.deviceCommand(await proof(device, terminalDecision(decoy)), noActions, terminal)).rejects.toMatchObject({
      status: 409,
    });
    const signed = await proof(device, command);
    expect(await service.deviceCommand(signed, noActions, terminal)).toEqual({ state: "approved" });
    expect(terminalDecisions.at(-1)).toMatchObject({
      deviceAuthorizationId: waiting.input.deviceAuthorizationId,
      clientId: waiting.input.clientId,
      user: { id: owner.id },
    });
    await expect(service.deviceCommand(signed, noActions, terminal)).rejects.toMatchObject({ status: 409 });
    await expect(service.deviceCommand(await proof(device, command), noActions, terminal)).rejects.toMatchObject({ status: 409 });
    const [event] =
      await sql`SELECT metadata FROM audit.events WHERE action='auth.app.login.approve' AND metadata->>'requestId'=${waiting.id}`;
    expect(event.metadata).toMatchObject({
      kind: "terminal",
      clientId: waiting.input.clientId,
      deviceGrantId: waiting.input.deviceAuthorizationId,
    });
    const denied = await terminalStart(owner.uid);
    expect(await service.deviceCommand(await proof(device, terminalDecision(denied, "deny")), noActions, terminal)).toEqual({
      state: "denied",
    });
    const expired = await terminalStart(owner.uid);
    await sql`UPDATE auth.app_logins SET expires_at=now()-interval '1 second' WHERE id=${expired.id}::uuid`;
    await expect(service.deviceCommand(await proof(device, terminalDecision(expired)), noActions, terminal)).rejects.toMatchObject({
      status: 409,
    });
    // Even knowing a matching browser secret cannot turn a terminal row into a browser session.
    const token = "A".repeat(43);
    await sql`UPDATE auth.app_logins SET browser_hash=${new Bun.CryptoHasher("sha256").update(token).digest("hex")} WHERE id=${waiting.id}::uuid`;
    await expect(service.browserStatus(waiting.id, token)).rejects.toMatchObject({ status: 404 });
    await expect(service.consumeLogin(waiting.id, token)).rejects.toMatchObject({ status: 409 });
  });

  test("expiry during the terminal hook rolls back the entire decision", async () => {
    const owner = await account(),
      device = await enroll(owner);
    await service.deviceCommand(await proof(device, { operation: "inbox", accept: ["terminal-logins"] }), noActions, terminal);
    const login = await terminalStart(owner.uid);
    const expiresDuringDecision: AppTerminalLogins = {
      ...terminal,
      decide: async (tx, input) => {
        expect(await terminal.decide(tx, input)).toBe(true);
        await tx`UPDATE auth.app_logins SET expires_at=now()-interval '1 second'
        WHERE device_authorization_id=${input.deviceAuthorizationId}::uuid`;
        return true;
      },
    };
    await expect(
      service.deviceCommand(await proof(device, terminalDecision(login)), noActions, expiresDuringDecision),
    ).rejects.toMatchObject({ status: 409 });
    const [row] = await sql`SELECT state FROM auth.app_logins WHERE id=${login.id}::uuid`;
    expect(row.state).toBe("pending");
    expect(await sql`SELECT 1 FROM audit.events WHERE metadata->>'requestId'=${login.id}`).toHaveLength(0);
  });

  test("concurrent terminal decisions and expiry have one winner", async () => {
    const owner = await account(),
      device = await enroll(owner),
      second = await enroll(owner);
    for (const phone of [device, second])
      await service.deviceCommand(await proof(phone, { operation: "inbox", accept: ["terminal-logins"] }), noActions, terminal);
    const login = await terminalStart(owner.uid);
    const outcomes = await Promise.allSettled([
      service.deviceCommand(await proof(device, terminalDecision(login)), noActions, terminal),
      service.deviceCommand(await proof(second, terminalDecision(login, "deny")), noActions, terminal),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const expiring = await terminalStart(owner.uid);
    const [decision, expiry] = await Promise.all([
      service.deviceCommand(await proof(device, terminalDecision(expiring)), noActions, terminal).then(
        () => true,
        () => false,
      ),
      sql`UPDATE auth.app_logins SET expires_at=now()-interval '1 second' WHERE id=${expiring.id}::uuid AND state='pending' RETURNING id`,
    ]);
    expect(Number(decision) + expiry.length).toBe(1);
  });

  test("terminal wake-ups require opt-in, and concurrent browser/terminal starts share the 30-second claim", async () => {
    const owner = await account(),
      device = await enroll(owner),
      old = await enroll(owner);
    await service.deviceCommand(await proof(device, { operation: "inbox", accept: ["terminal-logins"] }), noActions, terminal);
    for (const [phone, token] of [
      [device, "T".repeat(43)],
      [old, "O".repeat(43)],
    ] as const)
      await service.deviceCommand(await proof(phone, { operation: "push", token }), noActions);
    const waitPush = (count: number) => {
      if (pushes.length >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timeout = AbortSignal.timeout(5000);
        const done = () => {
          if (pushes.length < count) return;
          pushEvents.removeEventListener("push", done);
          timeout.removeEventListener("abort", fail);
          resolve();
        };
        const fail = () => {
          pushEvents.removeEventListener("push", done);
          reject(new Error("Wake-up did not finish"));
        };
        timeout.addEventListener("abort", fail, { once: true });
        pushEvents.addEventListener("push", done);
        done();
      });
    };
    const start = pushes.length;
    const first = await terminalStart(owner.uid);
    await waitPush(start + 1);
    expect(pushes.slice(start).map((entry) => entry.body)).toEqual([
      { token: "T".repeat(43), cloudOrigin: cfg.issuer, requestRef: first.id },
    ]);
    await terminalStart(owner.uid);
    await service.deviceCommand(await proof(device, terminalDecision(first, "deny")), noActions, terminal);
    const third = await terminalStart(owner.uid);
    await waitPush(start + 2);
    expect(pushes.at(-1)?.body.requestRef).toBe(third.id);
    await sql`UPDATE auth.app_logins SET expires_at=now()-interval '1 second' WHERE id=${third.id}::uuid`;
    const fourth = await terminalStart(owner.uid);
    await waitPush(start + 3);
    expect(pushes.at(-1)?.body.requestRef).toBe(fourth.id);
    await sql`UPDATE auth.app_devices SET login_wake_at=now()-interval '31 seconds' WHERE id=${device.id}::uuid`;
    await Promise.all([terminalStart(owner.uid), terminalStart(owner.uid)]);
    await waitPush(start + 4);
    expect(pushes).toHaveLength(start + 4);
    const [legacy] = await sql`SELECT login_wake_at FROM auth.app_devices WHERE id=${old.id}::uuid`;
    expect(legacy.login_wake_at).toBeNull();
    await service.deviceCommand(await proof(device, { operation: "inbox" }), noActions, terminal);
    await sql`UPDATE auth.app_logins SET state='denied' WHERE user_id=${owner.id}::uuid AND state='pending'`;
    await Promise.all([service.startLogin(owner.uid, "login"), service.startLogin(owner.uid, "login")]);
    await waitPush(start + 6); // one for each device, despite concurrent starts
    expect(pushes).toHaveLength(start + 6);
  });

  test("an OAuth access bearer cannot enroll a sign-in device", async () => {
    const owner = await account();
    const token = await withActiveIdentitySigner("oauth", (signer) =>
      new SignJWT({
        token_use: "access",
        principal_type: "user",
        uid: owner.uid,
        id: owner.id,
        client_id: "cloud-cli",
        azp: "cloud-cli",
        scope: "read",
      })
        .setProtectedHeader({ alg: "RS256", kid: signer.kid })
        .setIssuer(cfg.issuer)
        .setSubject(owner.id)
        .setAudience(["cloud", "cloud-cli"])
        .setIssuedAt()
        .setExpirationTime("1h")
        .setJti(crypto.randomUUID())
        .sign(signer.key),
    );
    expect([401, 403]).toContain((await post("/manage/pairings/start", {}, token)).status);
    expect(await sql`SELECT id FROM auth.app_pairings WHERE user_id=${owner.id}::uuid`).toHaveLength(0);
  });

  suiteFor(
    "database",
    "nats",
    "valkey",
  )("Cloud Login Actions", () => {
    beforeAll(migrateCloudAi, 30_000);
    const askAction = async (
      owner: Awaited<ReturnType<typeof account>>,
      options: { assurance?: "standard" | "confirm"; signedInSession?: true } = {},
    ) => {
      const chat = await aiConversations.createConversation({ ownerUserId: owner.id, title: "Send a letter" });
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "mock",
        runConfig: {
          kind: "chat",
          input: "Send",
          ...(options.signedInSession === undefined ? {} : { signedInSession: options.signedInSession }),
        },
        userMessage: { role: "user", content: [{ type: "text", text: "Send" }] },
      });
      const callId = crypto.randomUUID();
      const request = await approvals.request({
        appId: "mail",
        action: "draft.send",
        requester: { kind: "assistant_turn", appId: "assistant", ref: `${turn.id}/${callId}`, title: chat.title },
        subjectId: owner.id,
        approverUserId: owner.id,
        assurance: options.assurance ?? "confirm",
        sentence: "mail: Send draft",
        review: { message: "Send this letter", details: [{ label: "To", value: "Ada" }] },
        input: { revision: 1 },
        expiresInMs: 600_000,
      });
      if (!request.ok) throw new Error("Missing approval");
      await aiConversations.savePendingTurnAction({
        approvalId: request.id,
        conversationId: chat.id,
        turnId: turn.id,
        callId,
        kind: "approval",
        status: "pending",
        name: "mail.draft.send",
        args: { revision: 1 },
        allowAlways: false,
        allowChat: false,
        approvalScope: "draft",
        resolvedEvent: null,
      });
      return { id: request.id, conversationId: chat.id, turnId: turn.id, callId };
    };
    const devicePost = async (device: Awaited<ReturnType<typeof enroll>>, command: AppDeviceProof["command"]) =>
      post("/device", await proof(device, command), undefined, cfg.appOrigin);

    test("signed inbox and view belong to the device's account; a digest-bound decision resolves the chat and audits its device", async () => {
      const owner = await account(),
        stranger = await account();
      const device = await enroll(owner);
      const waiting = await askAction(owner, { assurance: "standard" });
      const foreign = await askAction(stranger);
      const login = await service.startLogin(owner.uid, "login");
      const discovery = await routes.request("/info");
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toMatchObject({
        features: ["actions", "terminal-logins", "login-context"],
        limits: APP_APPROVAL_LIMITS,
      });
      const inboxResponse = await devicePost(device, { operation: "inbox" });
      expect(inboxResponse.status).toBe(200);
      const inbox = AppDeviceInboxSchema.parse(await inboxResponse.json());
      expect(inbox.logins.map((entry) => entry.requestId)).toEqual([login.requestId]);
      expect(inbox.actions.map((entry) => entry.actionId)).toEqual([waiting.id]);
      expect(inbox.moreActions).toBe(0);
      const [record] = await sql<{ actions_at: Date | null }[]>`SELECT actions_at FROM auth.app_devices WHERE id=${device.id}::uuid`;
      expect(record?.actions_at).toBeInstanceOf(Date);
      expect((await devicePost(device, { operation: "action", actionId: foreign.id })).status).toBe(409);
      const response = await devicePost(device, { operation: "action", actionId: waiting.id });
      expect(response.status).toBe(200);
      const view = AppActionViewSchema.parse(await response.json());
      expect(view.digest).toBe(await appActionDigest(cfg.issuer, view));
      expect(view.requester.title).toBe("Send a letter");
      const command = { operation: "act", actionId: waiting.id, digest: view.digest, decision: "approve" } as const;
      expect((await devicePost(device, { ...command, digest: "A".repeat(43) })).status).toBe(409);
      expect(await approvals.get(waiting.id)).toMatchObject({ status: "pending" });
      const decided = await devicePost(device, command);
      expect(decided.status).toBe(200);
      expect(await decided.json()).toEqual({ state: "approved" });
      expect(await approvals.get(waiting.id)).toMatchObject({ status: "approved", decidedVia: "cloud_login" });
      expect(await aiConversations.getPendingTurnAction(waiting)).toMatchObject({ status: "resolved", resolvedEvent: { approved: true } });
      const [audit] = await sql<
        { metadata: unknown }[]
      >`SELECT metadata FROM audit.events WHERE target_type='approval_request' AND target_id=${waiting.id}`;
      expect(audit?.metadata).toMatchObject({ decidedVia: "cloud_login", deviceId: device.id });
      expect((await devicePost(device, command)).status).toBe(409);
      expect((await devicePost(device, { operation: "action", actionId: waiting.id })).status).toBe(409);
      for (const decision of ["approve", "deny"] as const) {
        const confirm = await askAction(owner);
        const view = AppActionViewSchema.parse(await (await devicePost(device, { operation: "action", actionId: confirm.id })).json());
        expect((await devicePost(device, { operation: "act", actionId: confirm.id, digest: view.digest, decision })).status).toBe(200);
        expect(await approvals.get(confirm.id)).toMatchObject({
          status: decision === "approve" ? "approved" : "rejected",
          decidedVia: "cloud_login",
        });
      }
    });

    test("all Action commands verify signatures first, and changed, expired or resolved views cannot be decided", async () => {
      const owner = await account();
      const device = await enroll(owner);
      const waiting = await askAction(owner);
      const view = await deviceActions.view({ userId: owner.id, issuer: cfg.issuer, actionId: waiting.id });
      if (!view) throw new Error("Missing view");
      for (const command of [
        { operation: "inbox" },
        { operation: "action", actionId: waiting.id },
        { operation: "act", actionId: waiting.id, digest: view.digest, decision: "approve" },
      ] satisfies AppDeviceProof["command"][]) {
        const signed = await proof(device, command);
        const tampered = { ...signed, proof: { ...signed.proof, jti: crypto.randomUUID() } };
        expect((await post("/device", tampered, undefined, cfg.appOrigin)).status).toBe(403);
      }
      const [deviceRow] = await sql<{ actions_at: Date | null }[]>`SELECT actions_at FROM auth.app_devices WHERE id=${device.id}::uuid`;
      expect(deviceRow?.actions_at).toBeNull();
      await sql`UPDATE approvals.requests SET requester_title='Changed chat' WHERE id=${waiting.id}::uuid`;
      expect((await devicePost(device, { operation: "act", actionId: waiting.id, digest: view.digest, decision: "approve" })).status).toBe(
        409,
      );
      expect(await approvals.get(waiting.id)).toMatchObject({ status: "pending" });
      const latest = await deviceActions.view({ userId: owner.id, issuer: cfg.issuer, actionId: waiting.id });
      if (!latest) throw new Error("Missing view");
      await approvals.decide(waiting.id, { approved: true }, { userId: owner.id, via: "web_session" });
      expect(
        (await devicePost(device, { operation: "act", actionId: waiting.id, digest: latest.digest, decision: "approve" })).status,
      ).toBe(409);
      const expired = await askAction(owner);
      await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${expired.id}::uuid`;
      expect((await devicePost(device, { operation: "action", actionId: expired.id })).status).toBe(409);
      const orphan = await askAction(owner);
      await sql`UPDATE ai.pending_actions SET status='resolved' WHERE approval_id=${orphan.id}::uuid`;
      expect((await devicePost(device, { operation: "action", actionId: orphan.id })).status).toBe(409);
      for (let i = 0; i < 6; i++) await askAction(owner);
      const inbox = AppDeviceInboxSchema.parse(await (await devicePost(device, { operation: "inbox" })).json());
      expect(inbox.actions).toHaveLength(5);
      expect(inbox.moreActions).toBe(1);
    });

    test("revocation after device verification but before the Action decision returns 409 and leaves it pending", async () => {
      const owner = await account();
      const device = await enroll(owner);
      const waiting = await askAction(owner);
      const view = AppActionViewSchema.parse(await (await devicePost(device, { operation: "action", actionId: waiting.id })).json());
      const racingRoutes = createAppApprovalRoutes(service, (appName) => {
        const actions = createDeviceActions(appName);
        return {
          ...actions,
          decide: async (input) => {
            // deviceCommand has committed its device verification before invoking decide.
            await service.mutateDevice(owner.actor, device.id);
            return actions.decide(input);
          },
        };
      });
      const response = await racingRoutes.request("/device", {
        method: "POST",
        headers: { "content-type": "application/json", origin: cfg.appOrigin },
        body: JSON.stringify(await proof(device, { operation: "act", actionId: waiting.id, digest: view.digest, decision: "approve" })),
      });
      expect(response.status).toBe(409);
      expect(await approvals.get(waiting.id)).toMatchObject({ status: "pending" });
      expect(await aiConversations.getPendingTurnAction(waiting)).toMatchObject({ status: "pending" });
      expect(await sql`SELECT 1 FROM audit.events WHERE target_type='approval_request' AND target_id=${waiting.id}`).toHaveLength(0);
    });

    test("a new Action wakes once inside 30 seconds after the previously woken request closes", async () => {
      for (const status of ["approved", "rejected", "cancelled", "expired"] as const) {
        const owner = await account();
        const phone = await enroll(owner);
        await service.deviceCommand(await proof(phone, { operation: "push", token: "W".repeat(43) }), deviceActions);
        await service.deviceCommand(await proof(phone, { operation: "inbox" }), deviceActions);
        const first = await askAction(owner);
        const start = pushes.length;
        await service.wakeForAction(first.id);
        const second = await askAction(owner);
        await service.wakeForAction(second.id);
        expect(pushes).toHaveLength(start + 1);
        if (status === "expired") await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${first.id}::uuid`;
        else await sql`UPDATE approvals.requests SET status=${status} WHERE id=${first.id}::uuid`;
        await Promise.all([service.wakeForAction(second.id), service.wakeForAction(second.id)]);
        expect(pushes).toHaveLength(start + 2);
        expect(pushes.at(-1)?.body.requestRef).toBe(second.id);
        const [claim] = await sql<{ action_wake_ref: string; recent: boolean }[]>`SELECT action_wake_ref,
          action_wake_at > now()-interval '30 seconds' AS recent FROM auth.app_devices WHERE id=${phone.id}::uuid`;
        expect(claim).toMatchObject({ action_wake_ref: second.id, recent: true });
      }
    });

    test("multibyte summaries share the response byte budget with logins and omitted Actions stay counted", async () => {
      const owner = await account();
      const device = await enroll(owner);
      for (let i = 0; i < 5; i++) {
        const action = await askAction(owner);
        await sql`UPDATE approvals.requests SET sentence=${"😀".repeat(280)} WHERE id=${action.id}::uuid`;
        await sql`UPDATE approvals.requests SET requester_title=${"😀".repeat(80)} WHERE id=${action.id}::uuid`;
        await service.startLogin(owner.uid, "login");
      }
      const largeNames = createAppApprovalRoutes(service, () => createDeviceActions((_id, _locale) => "😀".repeat(60)));
      const response = await largeNames.request("/device", {
        method: "POST",
        headers: { "content-type": "application/json", origin: cfg.appOrigin },
        body: JSON.stringify(await proof(device, { operation: "inbox" })),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(APP_APPROVAL_LIMITS.bodyBytes);
      const inbox = AppDeviceInboxSchema.parse(JSON.parse(body));
      expect(inbox.logins).toHaveLength(5);
      expect(inbox.actions.length).toBeLessThan(5);
      expect(inbox.actions.length + inbox.moreActions).toBe(5);
    });

    test("Action push claims devices atomically, requires inbox support, and skips Cloud page requests", async () => {
      const owner = await account();
      const phone = await enroll(owner),
        samePhone = await enroll(owner),
        oldPhone = await enroll(owner),
        revoked = await enroll(owner);
      const token = "U".repeat(43);
      for (const device of [phone, samePhone, oldPhone, revoked])
        await service.deviceCommand(
          await proof(device, { operation: "push", token: device === oldPhone ? "V".repeat(43) : token }),
          deviceActions,
        );
      for (const device of [phone, samePhone, revoked])
        await service.deviceCommand(await proof(device, { operation: "inbox" }), deviceActions);
      await service.mutateDevice(owner.actor, revoked.id);
      const waiting = await askAction(owner);
      const start = pushes.length;
      await Promise.all([service.wakeForAction(waiting.id), service.wakeForAction(waiting.id)]);
      expect(pushes.slice(start).map((push) => push.body)).toEqual([
        { token, cloudOrigin: cfg.issuer, requestRef: waiting.id, kind: "action" },
      ]);
      const [old] = await sql<{ action_wake_at: Date | null }[]>`SELECT action_wake_at FROM auth.app_devices WHERE id=${oldPhone.id}::uuid`;
      expect(old?.action_wake_at).toBeNull();
      const second = await askAction(owner);
      await service.wakeForAction(second.id);
      expect(pushes).toHaveLength(start + 1);
      await sql`UPDATE auth.app_devices SET action_wake_at=now()-interval '31 seconds' WHERE user_id=${owner.id}::uuid`;
      const page = await askAction(owner, { signedInSession: true });
      await service.wakeForAction(page.id);
      expect(pushes).toHaveLength(start + 1);
      await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${second.id}::uuid`;
      await service.wakeForAction(second.id);
      expect(pushes).toHaveLength(start + 1);
      cfg.enabled = false;
      await service.wakeForAction(waiting.id);
      cfg.enabled = true;
      expect(pushes).toHaveLength(start + 1);
      pushStatus = 400;
      try {
        await service.wakeForAction(waiting.id);
        expect(pushes).toHaveLength(start + 2);
        const [deviceRow] = await sql<{ push_token: string }[]>`SELECT push_token FROM auth.app_devices WHERE id=${phone.id}::uuid`;
        expect(deviceRow?.push_token).toBe(token);
        await sql`UPDATE auth.app_devices SET action_wake_at=now()-interval '31 seconds' WHERE user_id=${owner.id}::uuid`;
        pushStatus = 410;
        await service.wakeForAction(waiting.id);
        const rows = await sql<
          { push_token: string | null }[]
        >`SELECT push_token FROM auth.app_devices WHERE id IN (${phone.id}::uuid,${samePhone.id}::uuid)`;
        expect(rows.every((row) => row.push_token === null)).toBe(true);
      } finally {
        pushStatus = 202;
      }
    });
  });
});
