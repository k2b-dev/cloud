import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AppDeviceProof, AppDevicePublicKeySchema, appDeviceProofMessage } from "@k2b/cloud/contracts";
import { appApproval } from "@k2b/cloud/services";
import * as settings from "@k2b/cloud/services/settings";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate/core/app-approval";
import { cleanupTerminalLogins, createIdentityOAuthDeviceApprovalRoutes, terminalLogins } from "./identity-oauth-device-approval";

const previousBroker = process.env.CLOUD_OAUTH_BROKER_SECRET;
beforeAll(() => {
  process.env.CLOUD_OAUTH_BROKER_SECRET = "ab".repeat(32);
});
afterAll(() => {
  if (previousBroker === undefined) delete process.env.CLOUD_OAUTH_BROKER_SECRET;
  else process.env.CLOUD_OAUTH_BROKER_SECRET = previousBroker;
});

const headers = { authorization: `Bearer ${"ab".repeat(32)}`, "content-type": "application/json" };
const request = (routes: ReturnType<typeof createIdentityOAuthDeviceApprovalRoutes>, body: unknown) =>
  routes.request("/oauth/device-approval", { method: "POST", headers, body: JSON.stringify(body) });
const input = (deviceAuthorizationId = crypto.randomUUID(), clientId = "test-cli", identifier = "alice") => ({
  deviceAuthorizationId,
  clientId,
  identifier,
  scopes: ["openid", "profile"],
  lifetimeSeconds: 3600,
});

describe("Core OAuth device approval broker", () => {
  test("authenticates before parsing even a malformed or oversized body", async () => {
    const routes = createIdentityOAuthDeviceApprovalRoutes();
    for (const authorization of [undefined, "Bearer invalid", `Bearer ${"cd".repeat(32)}`]) {
      const response = await routes.request("/oauth/device-approval", {
        method: "POST",
        headers: { ...(authorization ? { authorization } : {}), "content-length": "300000" },
        body: "not JSON",
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("strict bounded input rejects malformed bodies before any database query", async () => {
    const routes = createIdentityOAuthDeviceApprovalRoutes();
    for (const body of [
      {},
      { ...input(), extra: true },
      { ...input(), identifier: " " },
      { ...input(), deviceAuthorizationId: "bad" },
      { ...input(), scopes: ["openid", "openid"] },
      { ...input(), scopes: ["scope with spaces"] },
      { ...input(), lifetimeSeconds: 7_776_001 },
      { ...input(), lifetimeSeconds: 0 },
      { ...input(), clientId: "c".repeat(257) },
    ]) {
      const response = await request(routes, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    }
    expect((await routes.request("/oauth/device-approval", { method: "POST", headers, body: "{" })).status).toBe(400);
  });
});

databaseSuite()("Core terminal authorization bridge", () => {
  const saved = new Map<string, unknown>();
  const configKeys = ["app.url", "user.app_approval.enabled", "user.app_approval.origin"];
  beforeAll(async () => {
    await migrate();
    await migrate();
    for (const key of configKeys) saved.set(key, await settings.get(key));
    await settings.set("app.url", "https://terminal-core.example.test");
    await settings.set("user.app_approval.enabled", true);
    await settings.set("user.app_approval.origin", "https://terminal-login.example.test");
  });
  afterAll(async () => {
    for (const key of configKeys) await settings.set(key, saved.get(key));
  });

  const fixture = async () => {
    const userId = crypto.randomUUID(),
      clientPk = crypto.randomUUID(),
      deviceId = crypto.randomUUID();
    const uid = `terminal-${userId}`,
      clientId = `terminal-${clientPk}`;
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const key = AppDevicePublicKeySchema.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
    const issuer = "https://terminal-core.example.test";
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES (${userId}::uuid,${uid},'local','user')`;
    await sql`INSERT INTO oauth.clients(id,name,client_id,redirect_uris,scopes,audiences,allowed_profiles,access_mode,registration_kind,is_public,allow_device_grant)
      VALUES (${clientPk}::uuid,'Terminal test client',${clientId},'{}',ARRAY['openid','profile','admin'],ARRAY['cloud'],ARRAY['user'],'profiles','managed',true,true)`;
    await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted,accepts)
      VALUES (${deviceId}::uuid,${issuer},${userId}::uuid,'Phone',${JSON.stringify(key)}::text::jsonb,false,ARRAY['terminal-logins'])`;
    const authorization = async () => {
      const id = crypto.randomUUID();
      await sql`INSERT INTO oauth.device_authorizations(id,device_code_hash,user_code_hash,client_id,scopes,audiences,expires_at,login_lifetime_seconds)
        VALUES (${id}::uuid,${id},${id},${clientId},ARRAY['openid','profile'],ARRAY['cloud'],now()+interval '10 minutes',7200)`;
      return id;
    };
    const decide = async (id: string, decision: "approve" | "deny" = "approve", hook = terminalLogins) => {
      const [login] = await sql<{ id: string; challenge: string; comparison: string }[]>`
        SELECT id,challenge,comparison FROM auth.app_logins WHERE device_authorization_id=${id}::uuid`;
      if (!login) throw new Error("Missing app login");
      const now = Math.floor(Date.now() / 1000);
      const proof: AppDeviceProof = {
        issuer,
        deviceId,
        jti: crypto.randomUUID(),
        issuedAt: now,
        expiresAt: now + 60,
        command: { operation: "decide", requestId: login.id, challenge: login.challenge, comparison: login.comparison, decision },
      };
      const signature = Buffer.from(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new TextEncoder().encode(appDeviceProofMessage(proof)),
        ),
      ).toString("base64url");
      return appApproval.deviceCommand(
        { proof, signature },
        {
          inbox: async () => ({ actions: [], moreActions: 0 }),
          view: async () => null,
          decide: async () => false,
        },
        hook,
      );
    };
    return {
      userId,
      uid,
      clientId,
      clientPk,
      deviceId,
      authorization,
      decide,
      cleanup: async () => {
        await sql`DELETE FROM audit.events WHERE actor_user_id=${userId}::uuid OR target_id=${clientPk}`;
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
        await sql`DELETE FROM auth.app_logins WHERE client_id=${clientId}`;
        await sql`DELETE FROM oauth.clients WHERE id=${clientPk}::uuid`;
      },
    };
  };

  test("rejects decided, expired, wrong-client, scopes, admin, lifetime and duplicate links", async () => {
    const f = await fixture();
    const routes = createIdentityOAuthDeviceApprovalRoutes();
    try {
      for (const invalid of [
        "decided",
        "expired",
        "client",
        "scopes",
        "admin",
        "lifetime",
        "private",
        "disabled",
        "client-scopes",
      ] as const) {
        const id = await f.authorization();
        const body = input(id, f.clientId, f.uid);
        if (invalid === "decided")
          await sql`UPDATE oauth.device_authorizations SET status='denied',user_id=${f.userId}::uuid WHERE id=${id}::uuid`;
        if (invalid === "expired")
          await sql`UPDATE oauth.device_authorizations SET expires_at=now()-interval '1 second' WHERE id=${id}::uuid`;
        if (invalid === "client") body.clientId = "another-client";
        if (invalid === "scopes") body.scopes = ["openid"];
        if (invalid === "admin") {
          body.scopes = ["admin"];
          await sql`UPDATE oauth.device_authorizations SET scopes=ARRAY['admin'] WHERE id=${id}::uuid`;
        }
        if (invalid === "lifetime") body.lifetimeSeconds = 7201;
        if (invalid === "private")
          await sql`UPDATE oauth.clients SET is_public=false,allow_device_grant=false WHERE id=${f.clientPk}::uuid`;
        if (invalid === "client-scopes") await sql`UPDATE oauth.clients SET scopes=ARRAY['openid'] WHERE id=${f.clientPk}::uuid`;
        if (invalid === "disabled") await sql`UPDATE oauth.clients SET allow_device_grant=false WHERE id=${f.clientPk}::uuid`;
        const response = await request(routes, body);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ code: "CONFLICT" });
        await sql`UPDATE oauth.clients SET is_public=true,allow_device_grant=true,scopes=ARRAY['openid','profile','admin'] WHERE id=${f.clientPk}::uuid`;
      }
      const id = await f.authorization();
      expect((await request(routes, input(id, f.clientId, "unknown"))).status).toBe(200);
      expect((await request(routes, input(id, f.clientId, f.uid))).status).toBe(409);
      await settings.set("user.app_approval.enabled", false);
      expect((await request(routes, input(await f.authorization(), f.clientId, f.uid))).status).toBe(503);
    } finally {
      await settings.set("user.app_approval.enabled", true);
      await f.cleanup();
    }
  });

  test("unknown, real and client-disallowed accounts return the same shape; nested grants permit access", async () => {
    const f = await fixture();
    const groups = [crypto.randomUUID(), crypto.randomUUID()];
    try {
      const routes = createIdentityOAuthDeviceApprovalRoutes();
      for (const kind of ["unknown", "real", "disallowed", "direct", "nested"] as const) {
        await sql`UPDATE oauth.clients SET access_mode=${["disallowed", "direct", "nested"].includes(kind) ? "specific" : "profiles"} WHERE id=${f.clientPk}::uuid`;
        if (kind === "direct")
          await sql`INSERT INTO oauth.client_access_users(client_id,user_id) VALUES (${f.clientPk}::uuid,${f.userId}::uuid)`;
        if (kind === "nested") {
          await sql`DELETE FROM oauth.client_access_users WHERE client_id=${f.clientPk}::uuid`;
          for (const group of groups)
            await sql`INSERT INTO auth.groups(id,cn,provider,name) VALUES (${group}::uuid,${group},'local',${group})`;
          await sql`INSERT INTO auth.user_groups_v2(user_id,group_id) VALUES (${f.userId}::uuid,${groups[0]}::uuid)`;
          await sql`INSERT INTO auth.group_groups_v2(parent_group_id,child_group_id) VALUES (${groups[1]}::uuid,${groups[0]}::uuid)`;
          await sql`INSERT INTO oauth.client_access_groups(client_id,group_id) VALUES (${f.clientPk}::uuid,${groups[1]}::uuid)`;
        }
        const id = await f.authorization();
        const response = await request(routes, input(id, f.clientId, kind === "unknown" ? "missing" : f.uid));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(Object.keys(body)).toEqual(["comparison", "expiresAt"]);
        expect(body.comparison).toMatch(/^\d{6}$/);
        expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);
        const [login] = await sql`SELECT kind,user_id FROM auth.app_logins WHERE device_authorization_id=${id}::uuid`;
        expect(login).toMatchObject({ kind: "terminal", user_id: ["unknown", "disallowed"].includes(kind) ? null : f.userId });
      }
    } finally {
      await f.cleanup();
      for (const group of groups.reverse()) await sql`DELETE FROM auth.groups WHERE id=${group}::uuid`;
    }
  });

  test("cleanup retains approved terminal evidence until the expired OAuth row is gone", async () => {
    const f = await fixture();
    try {
      const id = await f.authorization();
      expect((await request(createIdentityOAuthDeviceApprovalRoutes(), input(id, f.clientId, f.uid))).status).toBe(200);
      await f.decide(id);
      await sql`UPDATE auth.app_logins SET expires_at=now()-interval '1 second' WHERE device_authorization_id=${id}::uuid`;
      await appApproval.cleanup();
      await cleanupTerminalLogins();
      expect(await sql`SELECT 1 FROM auth.app_logins WHERE device_authorization_id=${id}::uuid`).toHaveLength(1);
      await sql`UPDATE oauth.device_authorizations SET expires_at=now()-interval '1 second' WHERE id=${id}::uuid`;
      await cleanupTerminalLogins();
      expect(await sql`SELECT 1 FROM auth.app_logins WHERE device_authorization_id=${id}::uuid`).toHaveLength(1);
      await sql`DELETE FROM oauth.device_authorizations WHERE id=${id}::uuid`;
      await cleanupTerminalLogins();
      expect(await sql`SELECT 1 FROM auth.app_logins WHERE device_authorization_id=${id}::uuid`).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });

  test("signed approve and deny update exactly the linked grant and both audits atomically", async () => {
    const f = await fixture();
    try {
      const routes = createIdentityOAuthDeviceApprovalRoutes();
      for (const decision of ["approve", "deny"] as const) {
        const id = await f.authorization(),
          other = await f.authorization();
        expect((await request(routes, input(id, f.clientId, f.uid))).status).toBe(200);
        expect(await sql.begin((tx) => terminalLogins.describe(tx, [id, other]))).toEqual(
          new Map([
            [id, { id: f.clientId, name: "Terminal test client" }],
            [other, { id: f.clientId, name: "Terminal test client" }],
          ]),
        );
        const rollback = {
          ...terminalLogins,
          decide: async (...args: Parameters<typeof terminalLogins.decide>) => {
            expect(await terminalLogins.decide(...args)).toBe(true);
            return false;
          },
        };
        await expect(f.decide(id, decision, rollback)).rejects.toMatchObject({ status: 409 });
        const [pending] = await sql`SELECT status,user_id FROM oauth.device_authorizations WHERE id=${id}::uuid`;
        expect(pending).toMatchObject({ status: "pending", user_id: null });
        expect(
          await sql`SELECT 1 FROM audit.events WHERE action='oauth.device.authorize' AND metadata->>'deviceGrantId'=${id}`,
        ).toHaveLength(0);
        expect(await f.decide(id, decision)).toEqual({ state: decision === "approve" ? "approved" : "denied" });
        const [grant] = await sql`SELECT status,user_id,login_lifetime_seconds FROM oauth.device_authorizations WHERE id=${id}::uuid`;
        expect(grant).toMatchObject({
          status: decision === "approve" ? "approved" : "denied",
          user_id: f.userId,
          login_lifetime_seconds: 3600,
        });
        const [untouched] = await sql`SELECT status,user_id FROM oauth.device_authorizations WHERE id=${other}::uuid`;
        expect(untouched).toMatchObject({ status: "pending", user_id: null });
        const events = await sql<
          { action: string; outcome: string; reason: string | null; metadata: unknown }[]
        >`SELECT action,outcome,reason,metadata FROM audit.events WHERE actor_user_id=${f.userId}::uuid AND metadata->>'deviceGrantId'=${id} ORDER BY action`;
        expect(events).toHaveLength(2);
        expect(events.map((row) => row.action)).toEqual([`auth.app.login.${decision}`, "oauth.device.authorize"]);
        expect(events[1]).toMatchObject({
          outcome: decision === "approve" ? "allowed" : "denied",
          reason: decision === "deny" ? "resource_owner_denied" : null,
          metadata: { clientId: f.clientId, deviceGrantId: id, scopes: ["openid", "profile"], via: "app-approval" },
        });
        expect(await sql.begin((tx) => terminalLogins.describe(tx, [id]))).toEqual(new Map());
      }
    } finally {
      await f.cleanup();
    }
  });
});
