import { afterAll, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { type AppDeviceProof, AppDevicePublicKeySchema, appDeviceProofMessage } from "@k2b/cloud/contracts";
import { type AuthContext, auth, v } from "@k2b/cloud/server";
import { type AppTerminalLogins, appApproval, oauthTokens, readAppApprovalConfig, toPgUuidArray } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import * as settings from "@k2b/cloud/services/settings";
import { redis, sql } from "bun";
import { Hono } from "hono";
import * as jose from "jose";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import type { DeviceApprovalView } from "./frontend/_components/DeviceApproval";
import { resolveDeviceView } from "./frontend/device";
import { completeDeviceDecision, DeviceDecisionSchema } from "./frontend/device-action";
import { migrate } from "./migrate";
import oauthRoutes from "./oauth";
import { oauth } from "./service/oauth";
import { issueOAuthTokenBatch, OAuthAuthorityGrantRejectedError } from "./service/token-authority";

const withFrozenTime = async (run: () => Promise<void>) => {
  const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;
  setSystemTime(clock!.now);
  try {
    await run();
  } finally {
    setSystemTime();
  }
};

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
  return { userId, cookie: `session_token=${await createTestSession(userId)}`, ip: uniqueCallerAddress() };
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
  headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": uniqueCallerAddress() },
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

const startDevice = async (params: { clientId?: string; scope?: string; ttl?: string } = {}): Promise<DeviceStart> => {
  const response = await oauthRoutes.request(
    "/oauth/device_authorization",
    form({
      client_id: params.clientId ?? "cloud-cli",
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.ttl !== undefined ? { ttl: params.ttl } : {}),
    }),
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

const familyFor = async (refreshToken: string) => {
  const [row] = await sql<{ id: string; expires_at: Date; token_expires_at: Date }[]>`
    SELECT family.id, family.expires_at, token.expires_at AS token_expires_at
    FROM oauth.refresh_tokens token
    JOIN oauth.refresh_token_families family ON family.id = token.family_id
    WHERE token.token_prefix = ${refreshToken.split("_")[2]!}
  `;
  if (!row) throw new Error("Refresh family is missing");
  return row;
};

const approveDevice = async (ttl?: string) => {
  const who = await person();
  const started = await startDevice({ scope: "openid offline_access", ttl });
  await decide(who, (await confirmRequest(who, started.user_code)).request, "approve");
  const tokens = await poll(started.device_code);
  expect(tokens.status).toBe(200);
  return tokens.body;
};

const expectRemaining = (seconds: unknown, expected: number) => {
  expect(Number.isInteger(seconds)).toBe(true);
  expect(Number(seconds)).toBeGreaterThanOrEqual(expected - 5);
  expect(Number(seconds)).toBeLessThanOrEqual(expected);
};

const expectTokensEndBy = (tokens: Record<string, unknown>, endsAt: Date) => {
  for (const token of [tokens.access_token, tokens.id_token]) {
    expect(jose.decodeJwt(String(token)).exp).toBeLessThanOrEqual(Math.floor(endsAt.getTime() / 1000));
  }
};

suite("OAuth device authorization grant", () => {
  test("signing out everywhere ends device refresh and access tokens on the next request", () =>
    withFrozenTime(async () => {
      const who = await person();
      const started = await startDevice({ scope: "openid offline_access" });
      const [user] = await sql<{ auth_epoch: string | number }[]>`SELECT auth_epoch FROM auth.users WHERE id = ${who.userId}::uuid`;
      const authEpoch = Number(user!.auth_epoch);
      await decide(who, (await confirmRequest(who, started.user_code)).request, "approve");
      const issued = await poll(started.device_code);
      expect(issued.status).toBe(200);
      const accessToken = String(issued.body.access_token);
      expect(jose.decodeJwt(accessToken).auth_epoch).toBe(authEpoch);
      expect(await oauthTokens.verifyAccessToken(accessToken, ["cloud", "cloud-cli"])).toMatchObject({
        kind: "user",
        user: { id: who.userId },
      });
      expect((await oauthRoutes.request("/oauth/userinfo", { headers: { authorization: `Bearer ${accessToken}` } })).status).toBe(200);
      await session.revokeAllForUser(who.userId);
      const refresh = await oauthRoutes.request(
        "/oauth/token",
        form({
          grant_type: "refresh_token",
          client_id: "cloud-cli",
          refresh_token: String(issued.body.refresh_token),
        }),
      );
      expect(refresh.status).toBe(400);
      expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
      expect(await oauthTokens.verifyAccessToken(accessToken, ["cloud", "cloud-cli"])).toBeNull();
      expect((await oauthRoutes.request("/oauth/userinfo", { headers: { authorization: `Bearer ${accessToken}` } })).status).toBe(401);
    }));

  test("approved device codes without an epoch stay unconsumed", () =>
    withFrozenTime(async () => {
      const who = await person();
      const started = await startDevice({ scope: "openid offline_access" });
      await decide(who, (await confirmRequest(who, started.user_code)).request, "approve");
      await sql`UPDATE oauth.device_authorizations SET auth_epoch = NULL WHERE device_code_hash = ${sha256(started.device_code)}`;
      const result = await poll(started.device_code);
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: "invalid_grant" });
      const [row] = await sql<{ status: string; authority_nonce: string | null }[]>`
      SELECT status, authority_nonce FROM oauth.device_authorizations WHERE device_code_hash = ${sha256(started.device_code)}
    `;
      expect(row).toEqual({ status: "approved", authority_nonce: null });
      expect(await sql`SELECT id FROM oauth.refresh_token_families WHERE user_id = ${who.userId}::uuid`).toHaveLength(0);
    }));

  test("a denial answers access_denied only with the deciding epoch", () =>
    withFrozenTime(async () => {
      const who = await person();
      const started = await startDevice();
      await decide(who, (await confirmRequest(who, started.user_code)).request, "deny");
      // Every decision path, the Cloud Login one included, must record its epoch on deny as well.
      await sql`UPDATE oauth.device_authorizations SET auth_epoch = NULL WHERE device_code_hash = ${sha256(started.device_code)}`;
      expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    }));

  test("signing out everywhere ends an approved device code before polling", () =>
    withFrozenTime(async () => {
      const who = await person();
      const started = await startDevice({ scope: "openid offline_access" });
      await decide(who, (await confirmRequest(who, started.user_code)).request, "approve");
      await session.revokeAllForUser(who.userId);
      const result = await poll(started.device_code);
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: "invalid_grant" });
      expect(await sql`SELECT id FROM oauth.refresh_token_families WHERE user_id = ${who.userId}::uuid`).toHaveLength(0);
    }));

  beforeAll(async () => {
    await migrate();
  });

  afterAll(async () => {
    if (createdClients.length > 0) {
      await sql`DELETE FROM audit.events WHERE target_id = ANY(${toPgUuidArray(createdClients)}::text[])`;
      await sql`DELETE FROM oauth.clients WHERE id = ANY(${toPgUuidArray(createdClients)}::uuid[])`;
    }
    if (createdUsers.length > 0) {
      await sql`DELETE FROM audit.events WHERE actor_user_id = ANY(${toPgUuidArray(createdUsers)}::uuid[])`;
      await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(createdUsers)}::uuid[])`;
    }
  });

  test("discovery advertises the device endpoint and grant", async () => {
    const response = await oauthRoutes.request("/.well-known/oauth-authorization-server");
    const metadata = (await response.json()) as {
      device_authorization_endpoint: string;
      grant_types_supported: string[];
      cloud_login_ttl_supported: boolean;
      cloud_login_hint_supported: boolean;
    };
    expect(metadata.device_authorization_endpoint).toBe(`${ISSUER}/oauth/device_authorization`);
    expect(metadata.grant_types_supported).toContain(DEVICE_GRANT);
    expect(metadata.cloud_login_ttl_supported).toBe(true);
    expect(metadata.cloud_login_hint_supported).toBe(true);
  });

  test("full happy path issues refreshable tokens with the requested scopes and audits the approval", async () => {
    const who = await person("Device Happy Path");
    const started = await startDevice({ scope: "openid profile read offline_access" });
    expect(Object.keys(started).sort()).toEqual([
      "device_code",
      "expires_in",
      "interval",
      "user_code",
      "verification_uri",
      "verification_uri_complete",
    ]);
    expect(started.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(started.device_code.length).toBeGreaterThanOrEqual(43);
    expect(started.verification_uri).toBe(`${ISSUER}/oauth/device`);
    expect(started.verification_uri_complete).toBe(`${ISSUER}/oauth/device?user_code=${started.user_code}`);
    expect(started.expires_in).toBe(600);
    expect(started.interval).toBe(5);
    expect((await oauth.device.getPending((await deviceRow(started.device_code)).id))?.loginLifetimeSeconds).toBeNull();

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

  for (const [ttl, expected] of [
    ["3600", 3600],
    ["2592000", 28800],
    ["600", 600],
    [undefined, 7776000],
  ] as const) {
    test(`device login ttl=${ttl ?? "omitted"} has an absolute lifetime of ${expected} seconds`, async () => {
      const previous = await settings.get<number>("user.session.expiry_hours");
      try {
        await settings.set("user.session.expiry_hours", 8);
        const tokens = await approveDevice(ttl);
        const family = await familyFor(String(tokens.refresh_token));
        expectRemaining(Math.floor((family.expires_at.getTime() - Date.now()) / 1000), expected);
        expectRemaining(tokens.refresh_token_expires_in, expected);
        expectRemaining(tokens.expires_in, Math.min(3600, expected));
        expectTokensEndBy(tokens, family.expires_at);
        expect(family.token_expires_at.getTime()).toBe(family.expires_at.getTime());
      } finally {
        await settings.set("user.session.expiry_hours", previous);
      }
    });
  }

  test("a failed lifetime lookup leaves device approval available for the next poll", async () => {
    const previous = await settings.get<number>("user.session.expiry_hours");
    try {
      await settings.set("user.session.expiry_hours", 8);
      const who = await person();
      const started = await startDevice({ scope: "openid offline_access", ttl: "600" });
      await decide(who, (await confirmRequest(who, started.user_code)).request, "approve");

      const lookup = spyOn(settings, "get").mockRejectedValueOnce(new Error("Settings temporarily unavailable"));
      try {
        expect(await poll(started.device_code)).toMatchObject({ status: 500, body: { error: "server_error" } });
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(lookup).toHaveBeenCalledWith("user.session.expiry_hours");
        expect((await deviceRow(started.device_code)).status).toBe("approved");
      } finally {
        lookup.mockRestore();
      }

      await allowNextPoll(started.device_code);
      const tokens = await poll(started.device_code);
      expect(tokens.status).toBe(200);
      expect(typeof tokens.body.refresh_token).toBe("string");
      expectRemaining(tokens.body.refresh_token_expires_in, 600);
    } finally {
      await settings.set("user.session.expiry_hours", previous);
    }
  });

  test("a one-year ttl and session setting cannot extend the 90-day default", async () => {
    const previous = await settings.get<number>("user.session.expiry_hours");
    try {
      await settings.set("user.session.expiry_hours", 8760);
      const who = await person();
      const started = await startDevice({ scope: "openid offline_access", ttl: "31536000" });
      expect((await oauth.device.getPending((await deviceRow(started.device_code)).id))?.loginLifetimeSeconds).toBe(7776000);
      await decide(who, (await confirmRequest(who, started.user_code)).request, "approve");
      const tokens = await poll(started.device_code);
      expect(tokens.status).toBe(200);
      expectRemaining(tokens.body.refresh_token_expires_in, 7776000);
    } finally {
      await settings.set("user.session.expiry_hours", previous);
    }
  });

  test("device authorization stores its cap and rechecks a lowered setting at issuance", async () => {
    const previous = await settings.get<number>("user.session.expiry_hours");
    try {
      await settings.set("user.session.expiry_hours", 8);
      const who = await person();
      const started = await startDevice({ scope: "openid offline_access", ttl: "2592000" });
      const row = await deviceRow(started.device_code);
      expect((await oauth.device.getPending(row.id))?.loginLifetimeSeconds).toBe(28800);
      expect((await oauth.device.findPendingByUserCode(started.user_code.replace("-", "")))?.loginLifetimeSeconds).toBe(28800);
      await decide(who, (await confirmRequest(who, started.user_code)).request, "approve");
      await settings.set("user.session.expiry_hours", 1);
      const tokens = await poll(started.device_code);
      expect(tokens.status).toBe(200);
      expectRemaining(tokens.body.refresh_token_expires_in, 3600);
      expectTokensEndBy(tokens.body, (await familyFor(String(tokens.body.refresh_token))).expires_at);
    } finally {
      await settings.set("user.session.expiry_hours", previous);
    }
  });

  test("lowering the setting does not shorten a login that already exists", async () => {
    const previous = await settings.get<number>("user.session.expiry_hours");
    try {
      await settings.set("user.session.expiry_hours", 8);
      const tokens = await approveDevice("2592000");
      const family = await familyFor(String(tokens.refresh_token));
      await settings.set("user.session.expiry_hours", 1);
      const response = await oauthRoutes.request(
        "/oauth/token",
        form({
          grant_type: "refresh_token",
          client_id: "cloud-cli",
          refresh_token: String(tokens.refresh_token),
        }),
      );
      expect(response.status).toBe(200);
      const refreshed: Record<string, unknown> = await response.json();
      expectRemaining(refreshed.refresh_token_expires_in, 28800);
      expect((await familyFor(String(refreshed.refresh_token))).expires_at.getTime()).toBe(family.expires_at.getTime());
    } finally {
      await settings.set("user.session.expiry_hours", previous);
    }
  });

  test("refresh near family expiry caps both JWTs and preserves the absolute family end", async () => {
    const tokens = await approveDevice();
    const family = await familyFor(String(tokens.refresh_token));
    const [updated] = await sql<{ expires_at: Date }[]>`
      UPDATE oauth.refresh_token_families SET expires_at = now() + INTERVAL '10 minutes'
      WHERE id = ${family.id}::uuid RETURNING expires_at
    `;
    if (!updated) throw new Error("Refresh family is missing");
    await sql`UPDATE oauth.refresh_tokens SET expires_at = ${updated.expires_at} WHERE family_id = ${family.id}::uuid`;
    const response = await oauthRoutes.request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        client_id: "cloud-cli",
        refresh_token: String(tokens.refresh_token),
      }),
    );
    expect(response.status).toBe(200);
    const refreshed: Record<string, unknown> = await response.json();
    expectRemaining(refreshed.refresh_token_expires_in, 600);
    expectRemaining(refreshed.expires_in, 600);
    expectTokensEndBy(refreshed, updated.expires_at);
    const rotated = await familyFor(String(refreshed.refresh_token));
    expect(rotated.expires_at.getTime()).toBe(updated.expires_at.getTime());
    expect(rotated.token_expires_at.getTime()).toBe(updated.expires_at.getTime());
  });

  test("refresh after the absolute family expiry is invalid_grant", async () => {
    const tokens = await approveDevice();
    const family = await familyFor(String(tokens.refresh_token));
    await sql`UPDATE oauth.refresh_token_families SET expires_at = now() - INTERVAL '1 second' WHERE id = ${family.id}::uuid`;
    await sql`UPDATE oauth.refresh_tokens SET expires_at = now() - INTERVAL '1 second' WHERE family_id = ${family.id}::uuid`;
    const response = await oauthRoutes.request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        client_id: "cloud-cli",
        refresh_token: String(tokens.refresh_token),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("rejects malformed device lifetimes through the existing validator", async () => {
    for (const ttl of ["0", "-1", "abc", "1.5", "", "01", " 1", "1\n", "1000000000000000"]) {
      const response = await oauthRoutes.request("/oauth/device_authorization", form({ client_id: "cloud-cli", ttl }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid_request",
        error_description: "Device authorization request validation failed",
      });
    }
  });

  test("refuses ttl on refresh, device polling and client credentials", async () => {
    const started = await startDevice();
    const grants: Record<string, string>[] = [
      { grant_type: "refresh_token", refresh_token: "unused" },
      { grant_type: DEVICE_GRANT, device_code: started.device_code },
      { grant_type: "client_credentials" },
    ];
    for (const grant of grants) {
      const response = await oauthRoutes.request("/oauth/token", form({ ...grant, client_id: "cloud-cli", ttl: "600" }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid_request",
        error_description: "ttl is only accepted for the authorization_code grant and the device authorization request",
      });
    }
    expect(await poll(started.device_code)).toMatchObject({ body: { error: "authorization_pending" } });
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
    expect((await view({ ...who, ip: uniqueCallerAddress() }, started.user_code)).status).toBe(429);
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
      const result = await oauth.device.poll({
        deviceCode: started.device_code,
        clientId: created.data.clientId,
        resolveLoginLifetime: async () => oauth.refreshTokens.DEFAULT_LOGIN_LIFETIME_SECONDS,
      });
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

  describe("Cloud Login device approval with login_hint", () => {
    const saved = new Map<string, unknown>();
    const keys = ["user.app_approval.enabled", "user.app_approval.origin", "user.session.expiry_hours"];
    const authorizationIds: string[] = [];
    const pushes: { token: string; requestRef: string; cloudOrigin: string }[] = [];
    let pushServer: ReturnType<typeof Bun.serve>;
    let terminalLogins: AppTerminalLogins;

    beforeAll(async () => {
      // The computed import keeps Core's program out of the OAuth typecheck.
      const corePath = "../../core/src/api/identity-oauth-device-approval";
      const core: { terminalLogins: AppTerminalLogins } = await import(corePath);
      terminalLogins = core.terminalLogins;
      for (const key of keys) saved.set(key, await settings.get(key));
      pushServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          if (request.method !== "POST" || new URL(request.url).pathname !== "/push/notify") return new Response(null, { status: 404 });
          pushes.push(await request.json());
          return new Response(null, { status: 200 });
        },
      });
      await settings.set("user.app_approval.enabled", true);
      await settings.set("user.app_approval.origin", pushServer.url.origin);
      await settings.set("user.session.expiry_hours", 8);
    });

    afterAll(async () => {
      try {
        if (authorizationIds.length) {
          await sql`DELETE FROM auth.app_logins WHERE device_authorization_id=ANY(${toPgUuidArray(authorizationIds)}::uuid[])`;
          await sql`DELETE FROM oauth.device_authorizations WHERE id=ANY(${toPgUuidArray(authorizationIds)}::uuid[])`;
        }
      } finally {
        try {
          for (const key of keys) if (saved.has(key)) await settings.set(key, saved.get(key));
        } finally {
          await pushServer?.stop(true);
        }
      }
    });

    const paired = async () => {
      const who = await person("Cloud Login Device Test");
      const [user] = await sql<{ uid: string; mail: string }[]>`SELECT uid,mail FROM auth.users WHERE id=${who.userId}::uuid`;
      if (!user) throw new Error("Missing user");
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const key = AppDevicePublicKeySchema.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
      const deviceId = crypto.randomUUID();
      const issuer = (await readAppApprovalConfig()).issuer;
      const pushToken = `terminal-${deviceId}`;
      await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted,accepts,push_token)
        VALUES (${deviceId}::uuid,${issuer},${who.userId}::uuid,'Phone',${JSON.stringify(key)}::text::jsonb,false,ARRAY['terminal-logins'],${pushToken})`;
      const decide = async (authorizationId: string, decision: "approve" | "deny") => {
        const [login] = await sql<{ id: string; challenge: string; comparison: string }[]>`
          SELECT id,challenge,comparison FROM auth.app_logins WHERE device_authorization_id=${authorizationId}::uuid`;
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
          terminalLogins,
        );
      };
      return { ...who, ...user, deviceId, issuer, pushToken, decide };
    };

    const start = async (identifier: string, ttl?: string) => {
      const response = await oauthRoutes.request(
        "/oauth/device_authorization",
        form({
          client_id: "cloud-cli",
          scope: "openid offline_access read",
          login_hint: identifier,
          ...(ttl !== undefined ? { ttl } : {}),
        }),
      );
      expect(response.status).toBe(200);
      const body: { device_code: string; comparison: string; expires_in: number; interval: number } = await response.json();
      const row = await deviceRow(body.device_code);
      authorizationIds.push(row.id);
      expect(Object.keys(body).sort()).toEqual(["comparison", "device_code", "expires_in", "interval"]);
      expect(body.comparison).toMatch(/^\d{6}$/);
      expect(body.expires_in).toBe(300);
      expect(body.interval).toBe(5);
      const [stored] = await sql<
        { comparison: string }[]
      >`SELECT comparison FROM auth.app_logins WHERE device_authorization_id=${row.id}::uuid`;
      expect(stored?.comparison).toBe(body.comparison);
      return { ...body, id: row.id };
    };

    const expire = async (id: string) => {
      await sql`UPDATE oauth.device_authorizations SET expires_at=now()-interval '1 second' WHERE id=${id}::uuid`;
      await sql`UPDATE auth.app_logins SET expires_at=now()-interval '1 second' WHERE device_authorization_id=${id}::uuid`;
    };

    const waitForPush = async (id: string) => {
      const [login] = await sql<{ id: string }[]>`SELECT id FROM auth.app_logins WHERE device_authorization_id=${id}::uuid`;
      for (let attempt = 0; attempt < 100 && !pushes.some((push) => push.requestRef === login?.id); attempt++) await Bun.sleep(20);
      const push = pushes.find((push) => push.requestRef === login?.id);
      expect(push).toBeDefined();
      return push;
    };

    const countRows = async (clientId = "cloud-cli") => {
      const [row] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM oauth.device_authorizations WHERE client_id=${clientId}`;
      return row!.count;
    };

    const managedClient = async () => {
      const id = await insertUser();
      const created = await oauth.clients.create({
        actor: { id, uid: `admin-${id}`, provider: "local", roles: ["admin"] },
        data: {
          name: `Hint refusal ${crypto.randomUUID()}`,
          redirectUris: [],
          scopes: ["read"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: true,
          allowDeviceGrant: true,
        },
      });
      if (!created.ok) throw new Error("Client setup failed");
      createdClients.push(created.data.id);
      return created.data;
    };

    test("username approval issues a session-length login, wakes the app and prevents replay", async () => {
      const who = await paired();
      const started = await start(`  ${who.uid}  `);
      expect(await waitForPush(started.id)).toMatchObject({ token: who.pushToken, cloudOrigin: who.issuer });
      const [stored] = await sql<{ app_approval: boolean; login_lifetime_seconds: number; remaining: number }[]>`
        SELECT app_approval,login_lifetime_seconds,floor(extract(epoch FROM expires_at-now()))::int AS remaining
        FROM oauth.device_authorizations WHERE id=${started.id}::uuid`;
      expect(stored).toMatchObject({ app_approval: true, login_lifetime_seconds: 28800 });
      expectRemaining(stored?.remaining, 300);
      await who.decide(started.id, "approve");
      const tokens = await poll(started.device_code);
      expect(tokens.status).toBe(200);
      expectRemaining(tokens.body.refresh_token_expires_in, 28800);
      const family = await familyFor(String(tokens.body.refresh_token));
      expectRemaining(Math.floor((family.expires_at.getTime() - Date.now()) / 1000), 28800);
      expect(family.token_expires_at.getTime()).toBe(family.expires_at.getTime());
      expectTokensEndBy(tokens.body, family.expires_at);
      await allowNextPoll(started.device_code);
      expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    });

    test("email lookup ignores case and ttl reduces the absolute login lifetime", async () => {
      const who = await paired();
      const started = await start(who.mail.toUpperCase(), "1800");
      await waitForPush(started.id);
      await who.decide(started.id, "approve");
      const tokens = await poll(started.device_code);
      expect(tokens.status).toBe(200);
      expectRemaining(tokens.body.refresh_token_expires_in, 1800);
      const family = await familyFor(String(tokens.body.refresh_token));
      expectRemaining(Math.floor((family.expires_at.getTime() - Date.now()) / 1000), 1800);
    });

    test("signed denial and expired app grants use normal device polling errors", async () => {
      const who = await paired();
      const denied = await start(who.uid);
      await waitForPush(denied.id);
      await who.decide(denied.id, "deny");
      expect(await poll(denied.device_code)).toMatchObject({ status: 400, body: { error: "access_denied" } });
      const expired = await start(who.uid);
      await waitForPush(expired.id);
      await expire(expired.id);
      expect(await poll(expired.device_code)).toMatchObject({ status: 400, body: { error: "expired_token" } });
    });

    test("a Cloud Login approval carries the account epoch and ends when it moves before polling", async () => {
      const who = await paired();
      const [user] = await sql<{ auth_epoch: string | number }[]>`SELECT auth_epoch FROM auth.users WHERE id=${who.userId}::uuid`;
      const signedIn = await start(who.uid);
      await waitForPush(signedIn.id);
      await who.decide(signedIn.id, "approve");
      const tokens = await poll(signedIn.device_code);
      expect(tokens.status).toBe(200);
      expect(jose.decodeJwt(String(tokens.body.access_token)).auth_epoch).toBe(Number(user!.auth_epoch));
      const stale = await start(who.uid);
      await waitForPush(stale.id);
      await who.decide(stale.id, "approve");
      await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${who.userId}::uuid`;
      expect(await poll(stale.device_code)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
      const [row] = await sql<{ status: string }[]>`SELECT status FROM oauth.device_authorizations WHERE id=${stale.id}::uuid`;
      expect(row?.status).toBe("approved");
      // Only the first sign-in's family exists; the refused grant activated nothing.
      expect(await sql`SELECT id FROM oauth.refresh_token_families WHERE user_id=${who.userId}::uuid AND status='active'`).toHaveLength(1);
    });

    test("unknown, ambiguous and unpaired accounts answer identically and expire without a push", async () => {
      const real = await paired();
      const started = await start(real.uid);
      await waitForPush(started.id);
      const before = pushes.length;
      const ambiguous = await paired();
      const otherId = await insertUser();
      await sql`UPDATE auth.users SET mail=${ambiguous.uid.toUpperCase()} WHERE id=${otherId}::uuid`;
      const unpairedId = await insertUser();
      const [unpaired] = await sql<{ uid: string }[]>`SELECT uid FROM auth.users WHERE id=${unpairedId}::uuid`;
      for (const identifier of [`missing-${crypto.randomUUID()}`, ambiguous.uid, unpaired!.uid]) {
        const decoy = await start(identifier);
        expect(Object.keys(decoy).sort()).toEqual(Object.keys(started).sort());
        expect(decoy.expires_in).toBe(started.expires_in);
        expect(decoy.interval).toBe(started.interval);
        const [login] = await sql<
          { user_id: string | null }[]
        >`SELECT user_id FROM auth.app_logins WHERE device_authorization_id=${decoy.id}::uuid`;
        expect(login?.user_id).toBeNull();
        expect(await poll(decoy.device_code)).toMatchObject({ status: 400, body: { error: "authorization_pending" } });
        expect(await poll(decoy.device_code)).toMatchObject({ status: 400, body: { error: "slow_down" } });
        await expire(decoy.id);
        expect(await poll(decoy.device_code)).toMatchObject({ status: 400, body: { error: "expired_token" } });
      }
      expect(pushes).toHaveLength(before);
    });

    test("managed clients, empty/admin/disallowed scopes and malformed hints never reach Core or insert a row", async () => {
      const client = await managedClient();
      const fetch = globalThis.fetch;
      let calls = 0;
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).endsWith("/oauth/device-approval")) {
              calls++;
              return Promise.resolve(new Response(null, { status: 503 }));
            }
            return fetch(input, init);
          },
          { preconnect: fetch.preconnect },
        ),
      );
      const settingsSpy = spyOn(settings, "get");
      try {
        const before = await countRows(client.clientId);
        const response = await oauthRoutes.request(
          "/oauth/device_authorization",
          form({ client_id: client.clientId, login_hint: "alice", scope: "admin" }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "invalid_request",
          error_description: "login_hint is only accepted for first-party clients",
        });
        expect(settingsSpy).not.toHaveBeenCalled();
        expect(await countRows(client.clientId)).toBe(before);
        for (const scope of ["admin", "unknown-scope"]) {
          const count = await countRows();
          const result = await oauthRoutes.request(
            "/oauth/device_authorization",
            form({ client_id: "cloud-cli", login_hint: "alice", scope }),
          );
          expect(result.status).toBe(400);
          expect(await result.json()).toMatchObject({ error: "invalid_scope" });
          expect(await countRows()).toBe(count);
        }
        // A first-party fixture without openid resolves an omitted scope to the empty set.
        await sql`UPDATE oauth.clients SET registration_kind='first_party' WHERE id=${client.id}::uuid`;
        const empty = await oauthRoutes.request("/oauth/device_authorization", form({ client_id: client.clientId, login_hint: "alice" }));
        expect(empty.status).toBe(400);
        expect(await empty.json()).toMatchObject({ error: "invalid_scope" });
        expect(await countRows(client.clientId)).toBe(before);
        for (const login_hint of ["", "  ", "a".repeat(255)]) {
          const count = await countRows();
          const malformed = await oauthRoutes.request("/oauth/device_authorization", form({ client_id: "cloud-cli", login_hint }));
          expect(malformed.status).toBe(400);
          expect(await malformed.json()).toEqual({
            error: "invalid_request",
            error_description: "Device authorization request validation failed",
          });
          expect(await countRows()).toBe(count);
        }
        expect(calls).toBe(0);
        expect(settingsSpy).not.toHaveBeenCalled();
      } finally {
        settingsSpy.mockRestore();
        fetchSpy.mockRestore();
      }
    });

    test("app rows reject code entry and both stale confirmation and direct browser decisions", async () => {
      const who = await paired();
      const client = await oauth.clients.getByClientId({ clientId: "cloud-cli" });
      if (!client) throw new Error("Missing CLI client");
      const started = await oauth.device.create({ client, scopes: ["openid"], appApproval: true, loginLifetimeSeconds: 28800 });
      authorizationIds.push(started.id);
      expect(await view(who, started.userCode)).toMatchObject({ status: 400, view: { kind: "entry", error: expect.any(String) } });
      expect(await oauth.device.findPendingByUserCode(started.userCode)).toBeNull();
      expect(await oauth.device.getPending(started.id)).toBeNull();
      const confirmation = await oauth.device.createConfirmation({ deviceAuthorizationId: started.id, userId: who.userId });
      expect(await decide(who, confirmation, "approve")).toBe("/oauth/device?result=expired");
      const [user] = await sql<{ auth_epoch: string | number }[]>`SELECT auth_epoch FROM auth.users WHERE id=${who.userId}::uuid`;
      for (const decision of ["approve", "deny"] as const) {
        expect(
          await oauth.device.decide({
            id: started.id,
            browserSignIn: { userId: who.userId, sid: crypto.randomUUID() },
            client,
            actor: { userId: who.userId, uid: who.uid, provider: "local", roles: [] },
            authEpoch: Number(user!.auth_epoch),
            decision,
          }),
        ).toBe(false);
      }
      expect((await deviceRow(started.deviceCode)).status).toBe("pending");
    });

    test("disabled app approval refuses the start without inserting or calling Core", async () => {
      const before = await countRows();
      const fetch = globalThis.fetch;
      let calls = 0;
      const spy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).endsWith("/oauth/device-approval")) {
              calls++;
              throw new Error("Unexpected Core call");
            }
            return fetch(input, init);
          },
          { preconnect: fetch.preconnect },
        ),
      );
      try {
        await settings.set("user.app_approval.enabled", false);
        const response = await oauthRoutes.request("/oauth/device_authorization", form({ client_id: "cloud-cli", login_hint: "alice" }));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "invalid_request",
          error_description: "Cloud Login approval is turned off on this Cloud; start the sign-in without login_hint",
        });
        expect(await countRows()).toBe(before);
        expect(calls).toBe(0);
      } finally {
        spy.mockRestore();
        await settings.set("user.app_approval.enabled", true);
      }
    });

    for (const failure of ["old-core", "network", "cleanup"] as const) {
      test(`Core ${failure} returns 503 and preserves other pending grants`, async () => {
        const untouched = await start(`missing-${crypto.randomUUID()}`);
        const before = await countRows();
        const fetch = globalThis.fetch;
        let calls = 0;
        const deleteSpy = failure === "cleanup" ? spyOn(oauth.device, "deletePending").mockRejectedValue(new Error("Delete failed")) : null;
        const spy = spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            (input: RequestInfo | URL, init?: RequestInit) => {
              if (String(input).endsWith("/oauth/device-approval")) {
                calls++;
                const body: { deviceAuthorizationId: string } = JSON.parse(String(init?.body));
                authorizationIds.push(body.deviceAuthorizationId);
                if (failure === "network") throw new TypeError("Network failure");
                return Promise.resolve(new Response(null, { status: 404 }));
              }
              return fetch(input, init);
            },
            { preconnect: fetch.preconnect },
          ),
        );
        try {
          const response = await oauthRoutes.request("/oauth/device_authorization", form({ client_id: "cloud-cli", login_hint: "alice" }));
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
          expect(calls).toBe(1);
          expect(await countRows()).toBe(before + (failure === "cleanup" ? 1 : 0));
          expect((await deviceRow(untouched.device_code)).status).toBe("pending");
        } finally {
          spy.mockRestore();
          deleteSpy?.mockRestore();
        }
      });
    }
  });
});
