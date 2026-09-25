import { afterAll, beforeAll, expect, test } from "bun:test";
import { type AuthContext, auth, v } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { redis, sql } from "bun";
import { Hono } from "hono";
import * as jose from "jose";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import type { DeviceApprovalView } from "./frontend/_components/DeviceApproval";
import { resolveDeviceView } from "./frontend/device";
import { completeDeviceDecision, DeviceDecisionSchema } from "./frontend/device-action";
import { migrate } from "./migrate";
import oauthRoutes from "./oauth";
import { oauth } from "./service/oauth";
import { issueOAuthTokenBatch, OAuthAuthorityGrantRejectedError } from "./service/token-authority";

const suite = suiteFor("database", "valkey", "nats");
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const ISSUER = "http://localhost:3000";

const createdUsers: string[] = [];
const createdClients: string[] = [];

const insertUser = async (displayName = "Device Test") => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn, admin)
    VALUES (${`oauth-device-${suffix}`}, 'local', 'user', ${displayName}, ${`oauth-device-${suffix}@example.test`}, 'Device', 'Test', false)
    RETURNING id
  `;
  createdUsers.push(row!.id);
  return row!.id;
};

/** One fresh person with a browser session and a private client address for the failure counters. */
const person = async (displayName?: string) => {
  const userId = await insertUser(displayName);
  return { userId, cookie: `session_token=${await createTestSession(userId)}`, ip: `198.51.100.${Math.floor(Math.random() * 250) + 1}` };
};

// The page route is exercised through its view resolver so tests assert state, not rendered markup.
const deviceRoutes = () =>
  new Hono<AuthContext>()
    .get("/oauth/device", auth.requireRole("authenticated"), auth.requireUser(), async (c) => {
      const view = await resolveDeviceView(c);
      return c.json(view);
    })
    .post("/oauth/device", auth.requireRole("authenticated"), auth.requireUser(), v("form", DeviceDecisionSchema), (c) =>
      completeDeviceDecision(c, c.req.valid("form")),
    );

// Each request uses its own documentation address so the per-IP endpoint limits never couple tests.
const form = (values: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `192.0.2.${Math.floor(Math.random() * 250) + 1}` },
  body: new URLSearchParams(values),
});

type DeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

const startDevice = async (params: { clientId?: string; scope?: string } = {}): Promise<DeviceStart> => {
  const response = await oauthRoutes.request(
    "/oauth/device_authorization",
    form({ client_id: params.clientId ?? "cloud-cli", ...(params.scope ? { scope: params.scope } : {}) }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceStart;
};

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

const deviceRow = async (deviceCode: string) => {
  const [row] = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM oauth.device_authorizations WHERE device_code_hash = ${sha256(deviceCode)}
  `;
  if (!row) throw new Error("Device authorization row is missing");
  return row;
};

/** Tests poll faster than a real client; forget the last poll instead of sleeping five seconds. */
const allowNextPoll = async (deviceCode: string) => {
  await redis.del(`oauth:device:poll:${(await deviceRow(deviceCode)).id}`);
};

const poll = async (deviceCode: string, clientId = "cloud-cli") => {
  const response = await oauthRoutes.request(
    "/oauth/token",
    form({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const view = async (who: { cookie: string; ip: string }, userCode: string | null, extra: Record<string, string> = {}) => {
  const query = userCode === null ? "" : `?user_code=${encodeURIComponent(userCode)}`;
  const response = await deviceRoutes().request(`/oauth/device${query}`, {
    headers: { cookie: who.cookie, "x-forwarded-for": who.ip, ...extra },
  });
  return { status: response.status, view: (await response.json()) as DeviceApprovalView };
};

const decide = async (who: { cookie: string }, request: string, decision: "approve" | "deny", origin = ISSUER) => {
  const response = await deviceRoutes().request("/oauth/device", {
    method: "POST",
    headers: { cookie: who.cookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request, decision }),
  });
  return response.headers.get("location");
};

const confirmRequest = async (who: { cookie: string; ip: string }, userCode: string) => {
  const result = await view(who, userCode);
  expect(result.view.kind).toBe("confirm");
  if (result.view.kind !== "confirm") throw new Error("expected confirmation");
  return result.view;
};

suite("OAuth device authorization grant", () => {
  beforeAll(async () => {
    await migrate();
  });

  afterAll(async () => {
    if (createdClients.length > 0) await sql`DELETE FROM oauth.clients WHERE id = ANY(${toPgUuidArray(createdClients)}::uuid[])`;
    if (createdUsers.length > 0) await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(createdUsers)}::uuid[])`;
  });

  test("discovery advertises the device endpoint and grant", async () => {
    const response = await oauthRoutes.request("/.well-known/oauth-authorization-server");
    const metadata = (await response.json()) as { device_authorization_endpoint: string; grant_types_supported: string[] };
    expect(metadata.device_authorization_endpoint).toBe(`${ISSUER}/oauth/device_authorization`);
    expect(metadata.grant_types_supported).toContain(DEVICE_GRANT);
  });

  test("full happy path issues refreshable tokens with the requested scopes and audits the approval", async () => {
    const who = await person("Device Happy Path");
    const started = await startDevice({ scope: "openid profile read offline_access" });
    expect(started.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(started.device_code.length).toBeGreaterThanOrEqual(43);
    expect(started.verification_uri).toBe(`${ISSUER}/oauth/device`);
    expect(started.verification_uri_complete).toBe(`${ISSUER}/oauth/device?user_code=${started.user_code}`);
    expect(started.expires_in).toBe(600);
    expect(started.interval).toBe(5);

    const [stored] = await sql<{ device_code_hash: string; user_code_hash: string }[]>`
      SELECT device_code_hash, user_code_hash FROM oauth.device_authorizations WHERE device_code_hash = ${sha256(started.device_code)}
    `;
    expect(stored?.user_code_hash).toBe(sha256(started.user_code.replace("-", "")));

    // People type codes loosely: lowercase and without the dash still match.
    const confirm = await confirmRequest(who, started.user_code.replace("-", "").toLowerCase());
    expect(confirm.code).toBe(started.user_code);
    expect(confirm.client).toEqual({ name: "Cloud CLI", clientId: "cloud-cli" });
    expect(confirm.scopes).toEqual(["openid", "profile", "read", "offline_access"]);

    expect(await decide(who, confirm.request, "approve")).toBe("/oauth/device?result=approved");
    const tokens = await poll(started.device_code);
    expect(tokens.status).toBe(200);
    expect(tokens.body.scope).toBe("openid profile read offline_access");
    expect(typeof tokens.body.refresh_token).toBe("string");
    expect(jose.decodeJwt(String(tokens.body.access_token))).toMatchObject({ sub: who.userId, client_id: "cloud-cli" });
    expect(jose.decodeJwt(String(tokens.body.id_token))).toMatchObject({ name: "Device Happy Path" });

    const refreshed = await oauthRoutes.request(
      "/oauth/token",
      form({ grant_type: "refresh_token", client_id: "cloud-cli", refresh_token: String(tokens.body.refresh_token) }),
    );
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { scope: string }).scope).toBe("openid profile read offline_access");

    const [event] = await sql<{ outcome: string; metadata: { clientId: string; scopes: string[] } }[]>`
      SELECT outcome, metadata FROM audit.events
      WHERE action = 'oauth.device.authorize' AND actor_user_id = ${who.userId}::uuid
    `;
    expect(event?.outcome).toBe("allowed");
    expect(event?.metadata.clientId).toBe("cloud-cli");
  });

  test("polling reports pending until approval, and too-fast polling earns slow_down", async () => {
    const who = await person();
    const started = await startDevice({ scope: "openid offline_access" });
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "authorization_pending" } });
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "slow_down" } });

    const confirm = await confirmRequest(who, started.user_code);
    await decide(who, confirm.request, "approve");
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "slow_down" } });
    await allowNextPoll(started.device_code);
    expect((await poll(started.device_code)).status).toBe(200);
  });

  test("a device code mints tokens only once", async () => {
    const who = await person();
    const started = await startDevice({ scope: "openid offline_access" });
    await decide(who, (await confirmRequest(who, started.user_code)).request, "approve");
    expect((await poll(started.device_code)).status).toBe(200);
    await allowNextPoll(started.device_code);
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  test("denial is final and audited", async () => {
    const who = await person();
    const started = await startDevice();
    expect(await decide(who, (await confirmRequest(who, started.user_code)).request, "deny")).toBe("/oauth/device?result=denied");
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "access_denied" } });
    expect((await view(who, started.user_code)).view).toMatchObject({ kind: "entry", error: expect.any(String) });

    const [event] = await sql<{ outcome: string; reason: string }[]>`
      SELECT outcome, reason FROM audit.events
      WHERE action = 'oauth.device.authorize' AND actor_user_id = ${who.userId}::uuid
    `;
    expect(event).toMatchObject({ outcome: "denied", reason: "resource_owner_denied" });
  });

  test("expired authorizations answer expired_token and can no longer be approved", async () => {
    const who = await person();
    const started = await startDevice();
    const confirm = await confirmRequest(who, started.user_code);
    await sql`UPDATE oauth.device_authorizations SET expires_at = now() - INTERVAL '1 second' WHERE device_code_hash = ${sha256(started.device_code)}`;
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "expired_token" } });
    expect(await decide(who, confirm.request, "approve")).toBe("/oauth/device?result=expired");
    expect((await deviceRow(started.device_code)).status).toBe("pending");
  });

  test("wrong code entries are limited per browser address and account", async () => {
    const who = await person();
    const started = await startDevice();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await view(who, "AAAA-AAAA");
      expect(wrong.status).toBe(400);
      expect(wrong.view).toMatchObject({ kind: "entry", code: "AAAA-AAAA" });
    }
    const blocked = await view(who, started.user_code);
    expect(blocked.status).toBe(429);
    expect(blocked.view.kind).toBe("entry");

    // The same account from another address stays blocked, and so does another account from the same address.
    expect((await view({ ...who, ip: "203.0.113.9" }, started.user_code)).status).toBe(429);
    const neighbour = await person();
    expect((await view({ ...neighbour, ip: who.ip }, started.user_code)).status).toBe(429);
    await redis.del(`oauth:device:failed:user:${who.userId}`);
    await redis.del(`oauth:device:failed:ip:${sha256(who.ip)}`);
  });

  test("only the enabled client that started the flow can poll, and scopes stay within the client", async () => {
    const admin = await insertUser();
    const actor = { id: admin, uid: `admin-${admin}`, provider: "local", roles: ["admin"] };
    const base = {
      redirectUris: [],
      scopes: ["openid" as const],
      audiences: ["cloud"],
      allowedProfiles: ["user" as const],
      accessMode: "profiles" as const,
      allowedUserIds: [],
      allowedGroupIds: [],
    };
    const enabled = await oauth.clients.create({
      actor,
      data: { ...base, name: `Device enabled ${crypto.randomUUID()}`, isPublic: true, allowDeviceGrant: true },
    });
    const disabled = await oauth.clients.create({
      actor,
      data: { ...base, name: `Device disabled ${crypto.randomUUID()}`, isPublic: true },
    });
    const confidential = await oauth.clients.create({
      actor,
      data: { ...base, name: `Device confidential ${crypto.randomUUID()}`, isPublic: false, allowDeviceGrant: true },
    });
    if (!enabled.ok || !disabled.ok) throw new Error("client setup failed");
    createdClients.push(enabled.data.id, disabled.data.id);
    expect(confidential).toMatchObject({ ok: false, status: 400 });

    const started = await startDevice();
    expect(await poll(started.device_code, enabled.data.clientId)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect(await poll(started.device_code, disabled.data.clientId)).toMatchObject({ status: 400, body: { error: "unauthorized_client" } });

    const refused = await oauthRoutes.request("/oauth/device_authorization", form({ client_id: disabled.data.clientId }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "unauthorized_client" });
    const unknown = await oauthRoutes.request("/oauth/device_authorization", form({ client_id: "no-such-client" }));
    expect(unknown.status).toBe(401);
    const widened = await oauthRoutes.request(
      "/oauth/device_authorization",
      form({ client_id: enabled.data.clientId, scope: "openid write" }),
    );
    expect(await widened.json()).toMatchObject({ error: "invalid_scope" });
    expect((await startDevice({ clientId: enabled.data.clientId })).user_code).toMatch(/-/);
  });

  test("approval needs the same person's browser session and a same-origin form", async () => {
    const who = await person();
    const other = await person();
    const started = await startDevice({ scope: "openid offline_access read" });
    const confirm = await confirmRequest(who, started.user_code);

    expect(await decide(who, confirm.request, "approve", "https://attacker.example")).toContain("/oauth/error?error=access_denied");
    expect(await decide(other, confirm.request, "approve")).toBe("/oauth/device?result=expired");
    expect((await deviceRow(started.device_code)).status).toBe("pending");

    // A bearer token for the same account cannot approve devices, so a narrow token cannot mint a wider one.
    const second = await startDevice({ scope: "openid offline_access read" });
    await decide(who, (await confirmRequest(who, second.user_code)).request, "approve");
    const tokens = await poll(second.device_code);
    const bearer = await deviceRoutes().request(`/oauth/device?user_code=${started.user_code}`, {
      headers: { authorization: `Bearer ${String(tokens.body.access_token)}`, "x-forwarded-for": who.ip },
    });
    expect(bearer.status).toBe(403);
    expect(await bearer.json()).toMatchObject({ kind: "result", outcome: "blocked" });
  });

  test("Core signs a device grant once and only while the client still allows the grant", async () => {
    const who = await person();
    const actor = { id: who.userId, uid: `admin-${who.userId}`, provider: "local", roles: ["admin"] };
    const created = await oauth.clients.create({
      actor,
      data: {
        name: `Device authority ${crypto.randomUUID()}`,
        redirectUris: [],
        scopes: ["openid"],
        audiences: ["cloud"],
        allowedProfiles: ["user"],
        accessMode: "profiles",
        allowedUserIds: [],
        allowedGroupIds: [],
        isPublic: true,
        allowDeviceGrant: true,
      },
    });
    if (!created.ok) throw new Error("client setup failed");
    createdClients.push(created.data.id);

    const consume = async () => {
      const started = await startDevice({ clientId: created.data.clientId });
      await decide(who, (await confirmRequest(who, started.user_code)).request, "approve");
      const result = await oauth.device.poll({ deviceCode: started.device_code, clientId: created.data.clientId });
      if (!result.ok) throw new Error(`poll failed: ${result.error}`);
      return result.authorityGrant;
    };
    const request = (grant: Awaited<ReturnType<typeof consume>>) => [{ kind: "user_access" as const, grant, expiresIn: 3_600 }];

    const grant = await consume();
    expect(await issueOAuthTokenBatch(request(grant))).toHaveLength(1);
    await expect(issueOAuthTokenBatch(request(grant))).rejects.toBeInstanceOf(OAuthAuthorityGrantRejectedError);

    const disabledLater = await consume();
    await sql`UPDATE oauth.clients SET allow_device_grant = false WHERE id = ${created.data.id}::uuid`;
    await expect(issueOAuthTokenBatch(request(disabledLater))).rejects.toBeInstanceOf(OAuthAuthorityGrantRejectedError);
  });

  test("cleanup prunes expired and redeemed authorizations", async () => {
    const started = await startDevice();
    await sql`UPDATE oauth.device_authorizations SET expires_at = now() - INTERVAL '2 hours' WHERE device_code_hash = ${sha256(started.device_code)}`;
    await oauth.device.cleanup();
    const [row] = await sql`SELECT 1 FROM oauth.device_authorizations WHERE device_code_hash = ${sha256(started.device_code)}`;
    expect(row).toBeUndefined();
  });
});
