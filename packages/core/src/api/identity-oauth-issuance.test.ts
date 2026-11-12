import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { OAuthAuthorityStatement } from "@k2b/cloud/contracts";
import * as settings from "@k2b/cloud/services/settings";
import { encryptValue } from "@k2b/cloud/services/settings/crypto";
import { decodeJwt, generateKeyPair, jwtVerify } from "jose";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateOAuthClients } from "../migrate/core/oauth-clients";
import { createIdentityOAuthIssuanceRoutes } from "./identity-oauth-issuance";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const USER_ID = "68df7d96-aaab-420a-ab1e-62a67e44d3be";
const issuer = "https://cloud.example.test";
const statement = (): OAuthAuthorityStatement => ({
  clientId: "test-client",
  subject: { kind: "user", userId: USER_ID, authEpoch: 7 },
  scopes: ["openid", "profile", "email", "groups"],
  audiences: ["cloud", "test-client"],
  resource: null,
  nonce: "oidc-nonce",
  loginExpiresAt: new Date(NOW + 7200_000).toISOString(),
  terminalLoginId: null,
  tokens: [
    { kind: "user_access", expiresIn: 3600 },
    { kind: "user_id", expiresIn: 3600 },
  ],
});
const authorityState = () => ({
  authEpoch: 7,
  clientId: "test-client",
  grantedScopes: statement().scopes,
  grantedAudiences: statement().audiences,
  nonce: "oidc-nonce",
  notAfter: new Date(NOW + 7200_000),
  user: {
    id: USER_ID,
    uid: "alice",
    profile: "user",
    displayName: "Alice Current",
    givenName: "Alice",
    familyName: "Current",
    email: "alice@example.test",
    groups: ["current-group"],
  },
  serviceAccount: null,
});
const request = (routes: ReturnType<typeof createIdentityOAuthIssuanceRoutes>, body: unknown, path = "/oauth/token") =>
  routes.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const authorize: NonNullable<Parameters<typeof createIdentityOAuthIssuanceRoutes>[0]>["authorize"] = async (c) => {
  c.set("oauthIssuerAppId", "third-party-issuer");
  return null;
};

let pair: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  pair = await generateKeyPair("RS256");
  setSystemTime(NOW);
});
afterAll(() => setSystemTime());
const signer: NonNullable<Parameters<typeof createIdentityOAuthIssuanceRoutes>[0]>["withActiveSigner"] = async (_purpose, use) =>
  use({ kid: "platform-oauth-key", key: pair.privateKey, signUntil: new Date(NOW + 60_000), issuer }, sql);
const setup = (overrides: Parameters<typeof createIdentityOAuthIssuanceRoutes>[0] = {}) =>
  createIdentityOAuthIssuanceRoutes({
    authorize,
    issuer: async () => issuer,
    withActiveSigner: signer,
    resolve: async ({ appId, request: input }) => {
      expect(appId).toBe("third-party-issuer");
      expect(input).toEqual(statement());
      return authorityState();
    },
    now: () => NOW / 1000,
    ...overrides,
  });

describe("Core closed OAuth issuer contract", () => {
  test("authenticates before parsing, resolving or using the signer", async () => {
    let calls = 0;
    const routes = setup({
      authorize: async (c) => c.json({ code: "UNAUTHORIZED" }, 401),
      resolve: async () => {
        calls += 1;
        return authorityState();
      },
      withActiveSigner: async (...args) => {
        calls += 1;
        return signer(...args);
      },
    });
    for (const path of ["/oauth/token", "/oauth/ready", "/oauth/new-access"]) {
      expect((await routes.request(path, { method: "POST", body: "not JSON" })).status).toBe(401);
    }
    expect(calls).toBe(0);
  });
  test("keeps the authenticated third-party issuer and derives current JWT claims", async () => {
    const response = await request(setup(), statement());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { tokens } = await response.json();
    const access = await jwtVerify(tokens[0], pair.publicKey, { issuer, audience: "cloud", currentDate: new Date(NOW) });
    expect(access.protectedHeader).toEqual({ alg: "RS256", kid: "platform-oauth-key" });
    expect(access.payload).toMatchObject({
      sub: USER_ID,
      id: USER_ID,
      uid: "alice",
      auth_epoch: 7,
      token_use: "access",
      principal_type: "user",
      client_id: "test-client",
      azp: "test-client",
      exp: NOW / 1000 + 3600,
    });
    const id = await jwtVerify(tokens[1], pair.publicKey, { issuer, audience: "test-client", currentDate: new Date(NOW) });
    expect(id.payload).toMatchObject({
      sub: USER_ID,
      name: "Alice Current",
      email: "alice@example.test",
      nonce: "oidc-nonce",
      groups: ["current-group"],
    });
  });
  test("rejects unknown claims, old grant references, invalid batches and lifetimes before resolution", async () => {
    const body = statement();
    let resolved = 0;
    const routes = setup({
      resolve: async () => {
        resolved += 1;
        return authorityState();
      },
    });
    for (const bad of [
      { ...body, claims: { admin: true } },
      { ...body, issuerAppId: "oauth" },
      { ...body, subject: { ...body.subject, uid: "injected" } },
      { ...body, tokens: [{ ...body.tokens[0], grant: { kind: "authorization_code", code: "private" } }] },
      { ...body, tokens: [{ kind: "user_id", expiresIn: 3600 }] },
      { ...body, tokens: [body.tokens[0], body.tokens[0]] },
      { ...body, tokens: [{ kind: "service_access", expiresIn: 3600 }] },
      { ...body, tokens: [{ kind: "user_access", expiresIn: 3601 }] },
      { ...body, tokens: [{ kind: "user_access", expiresIn: 0 }] },
      { ...body, terminalLoginId: USER_ID, loginExpiresAt: null },
      { ...body, scopes: ["read"], tokens: body.tokens },
      { ...body, resource: "https://cloud.example.test/api" },
      { ...body, resource: "urn:test#fragment", audiences: ["urn:test#fragment"] },
    ])
      expect((await request(routes, bad)).status).toBe(400);
    expect(resolved).toBe(0);
  });
  test("independently clamps every signature to the login end", async () => {
    const end = new Date(NOW + 10_000);
    const routes = setup({ resolve: async () => ({ ...authorityState(), notAfter: end }) });
    const response = await request(routes, statement());
    expect(response.status).toBe(200);
    const { tokens } = await response.json();
    expect(tokens.map((token: string) => decodeJwt(token).exp)).toEqual([NOW / 1000 + 10, NOW / 1000 + 10]);
    expect((await request(setup({ resolve: async () => ({ ...authorityState(), notAfter: new Date(NOW) }) }), statement())).status).toBe(
      403,
    );
  });
  test("a user statement without an absolute login end retains the one-hour token ceiling", async () => {
    const routes = setup({ resolve: async () => ({ ...authorityState(), notAfter: null }) });
    const response = await request(routes, { ...statement(), loginExpiresAt: null });
    expect(response.status).toBe(200);
    const { tokens } = await response.json();
    expect(decodeJwt(tokens[0]).exp).toBe(NOW / 1000 + 3600);
  });
  test("signer readiness needs no private grant or registry read", async () => {
    const routes = setup({
      resolve: async () => {
        throw new Error("Readiness resolved authority");
      },
    });
    expect((await request(routes, {}, "/oauth/ready")).status).toBe(204);
  });
  test("delegates notice delivery without delaying or coupling token issuance", async () => {
    const notices: unknown[] = [];
    const routes = setup({
      notifyNewAccess: async (notice) => {
        notices.push(notice);
      },
    });
    expect((await request(routes, statement())).status).toBe(200);
    expect(notices).toEqual([]);
    const notice = {
      familyId: USER_ID,
      userId: USER_ID,
      clientId: "cloud-cli",
      clientName: "Third-party client",
      createdAt: new Date(NOW).toISOString(),
    };
    expect((await request(routes, notice, "/oauth/new-access")).status).toBe(204);
    expect(notices).toEqual([
      { familyId: USER_ID, userId: USER_ID, kind: "app", clientName: "Third-party client", createdAt: new Date(NOW).toISOString() },
    ]);
  });
});

databaseSuite()("Core platform facts for OAuth issuers", () => {
  let userId: string, clientId: string, serviceId: string;
  beforeAll(async () => {
    await migrateAppApproval();
    await migrateOAuthClients();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,auth_epoch)
      VALUES (${crypto.randomUUID()},'local','user',7) RETURNING id`;
    userId = user!.id;
    serviceId = crypto.randomUUID();
    clientId = `third-party-${crypto.randomUUID()}`;
    await sql`INSERT INTO auth.service_accounts(id,name,kind,status) VALUES (${serviceId}::uuid,'Issuer service','standalone','active')`;
    await sql`INSERT INTO auth.oauth_clients(client_id,issuer_app_id,status,name)
      VALUES (${clientId},'third-party-issuer','active','Third-party client')`;
  });
  afterAll(async () => {
    await sql`DELETE FROM auth.oauth_clients WHERE client_id=${clientId}`;
    await sql`DELETE FROM auth.service_accounts WHERE id=${serviceId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
  });
  const liveRoutes = () =>
    createIdentityOAuthIssuanceRoutes({
      authorize,
      issuer: async () => issuer,
      now: () => Math.floor(Date.now() / 1000),
      withActiveSigner: async (_purpose, use) =>
        sql.begin((db) =>
          use(
            {
              kid: "platform-oauth-key",
              key: pair.privateKey,
              signUntil: new Date(NOW + 60_000),
              issuer,
            },
            db,
          ),
        ),
    });
  const liveStatement = (): OAuthAuthorityStatement => ({ ...statement(), clientId, subject: { kind: "user", userId, authEpoch: 7 } });
  test("rejects unknown, disabled and wrong-owner clients; deletion rejects the next issue", async () => {
    const routes = liveRoutes();
    const input = liveStatement();
    expect((await request(routes, input)).status).toBe(200);
    expect((await request(routes, { ...input, clientId: "unknown" })).status).toBe(403);
    await sql`UPDATE auth.oauth_clients SET status='disabled' WHERE client_id=${clientId}`;
    expect((await request(routes, input)).status).toBe(403);
    await sql`UPDATE auth.oauth_clients SET status='active',issuer_app_id='another-issuer' WHERE client_id=${clientId}`;
    expect((await request(routes, input)).status).toBe(403);
    await sql`UPDATE auth.oauth_clients SET status='deleted',issuer_app_id='third-party-issuer' WHERE client_id=${clientId}`;
    expect((await request(routes, input)).status).toBe(403);
    // Restore this shared fixture directly; the public registry service never resurrects an ID.
    await sql`UPDATE auth.oauth_clients SET status='active' WHERE client_id=${clientId}`;
  });
  test("rejects stale epoch, account expiry, invalid category, and absent users", async () => {
    const routes = liveRoutes();
    const input = liveStatement();
    expect((await request(routes, { ...input, subject: { kind: "user", userId, authEpoch: 6 } })).status).toBe(403);
    expect((await request(routes, { ...input, subject: { kind: "user", userId: USER_ID, authEpoch: 7 } })).status).toBe(403);
    await sql`UPDATE auth.users SET account_expires='2000-01-01' WHERE id=${userId}::uuid`;
    expect((await request(routes, input)).status).toBe(403);
    await sql`UPDATE auth.users SET account_expires=NULL WHERE id=${userId}::uuid`;
    const [saved] = await sql<{ value: string }[]>`SELECT value FROM settings.entries WHERE key='user.category.login.enabled'`;
    try {
      await sql`INSERT INTO settings.entries(key,value) VALUES ('user.category.login.enabled',${await encryptValue(false)})
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`;
      expect((await request(routes, input)).status).toBe(403);
    } finally {
      if (saved) await sql`UPDATE settings.entries SET value=${saved.value} WHERE key='user.category.login.enabled'`;
      else await sql`DELETE FROM settings.entries WHERE key='user.category.login.enabled'`;
    }
  });
  test("checks live service status, shape and exact registry binding", async () => {
    const routes = liveRoutes();
    const input: OAuthAuthorityStatement = {
      ...liveStatement(),
      subject: { kind: "service_account", serviceAccountId: serviceId },
      scopes: ["read"],
      nonce: null,
      loginExpiresAt: null,
      tokens: [{ kind: "service_access", expiresIn: 60 }],
    };
    expect((await request(routes, input)).status).toBe(403);
    await sql`UPDATE auth.oauth_clients SET service_account_id=${serviceId}::uuid WHERE client_id=${clientId}`;
    expect((await request(routes, input)).status).toBe(200);
    await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${serviceId}::uuid`;
    expect((await request(routes, input)).status).toBe(403);
    await sql`UPDATE auth.service_accounts SET status='active',kind='resource_bound',app_id='issuer',resource_type='cloud.app',resource_id='issuer' WHERE id=${serviceId}::uuid`;
    expect((await request(routes, input)).status).toBe(403);
    await sql`UPDATE auth.service_accounts SET kind='standalone',app_id=NULL,resource_type=NULL,resource_id=NULL WHERE id=${serviceId}::uuid`;
    await sql`UPDATE auth.oauth_clients SET service_account_id=NULL WHERE client_id=${clientId}`;
  });
  test("identity claims exclude personal groups while retaining ordinary ancestors", async () => {
    const personal = crypto.randomUUID(),
      team = crypto.randomUUID();
    const suffix = crypto.randomUUID();
    try {
      await sql`INSERT INTO auth.groups(id,cn,name,provider) VALUES
        (${personal}::uuid,${`local:private-${suffix}`},${`private-${suffix}`},'local'),
        (${team}::uuid,${`local:team-${suffix}`},${`team-${suffix}`},'local')`;
      await sql`INSERT INTO auth.personal_groups(group_id,owner_id,group_name,gid_number)
        VALUES (${personal}::uuid,${userId}::uuid,${`private-${suffix}`},1500002)`;
      await sql`INSERT INTO auth.user_groups_v2 VALUES (${userId}::uuid,${personal}::uuid)`;
      await sql`INSERT INTO auth.group_groups_v2 VALUES (${team}::uuid,${personal}::uuid)`;
      const response = await request(liveRoutes(), liveStatement());
      expect(response.status).toBe(200);
      const { tokens } = await response.json();
      expect(decodeJwt(tokens[0]).groups).toBeUndefined();
      expect(decodeJwt(tokens[1]).groups).toEqual([`team-${suffix}`]);
    } finally {
      await sql`DELETE FROM auth.personal_groups WHERE group_id=${personal}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${personal}::uuid,${team}::uuid)`;
    }
  });
  const terminal = async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const now = clock!.now;
    setSystemTime(now);
    const deviceId = crypto.randomUUID(),
      loginId = crypto.randomUUID(),
      grantId = crypto.randomUUID(),
      otherUserId = crypto.randomUUID();
    const saved = new Map<string, unknown>();
    for (const key of ["app.url", "user.app_approval.enabled", "user.app_approval.origin"]) saved.set(key, await settings.get(key));
    await settings.set("app.url", issuer);
    await settings.set("user.app_approval.enabled", true);
    await settings.set("user.app_approval.origin", "https://terminal-login.example.test");
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES (${otherUserId}::uuid,${otherUserId},'local','user')`;
    await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted)
      VALUES (${deviceId}::uuid,${issuer},${userId}::uuid,'Phone','{}',false)`;
    await sql`INSERT INTO auth.app_logins(id,issuer,user_id,auth_epoch,category,browser_hash,challenge,comparison,state,approved_by,
      expires_at,kind,device_authorization_id,client_id,scopes,lifetime_seconds,oauth_issuer_app_id,oauth_client_name,oauth_grant_expires_at)
      VALUES (${loginId}::uuid,${issuer},${userId}::uuid,7,'login','hash','challenge','012345','approved',${deviceId}::uuid,
        now()+interval '5 minutes','terminal',${grantId}::uuid,${clientId},ARRAY['openid','profile','email','groups'],3600,
        'third-party-issuer','Terminal client',now()+interval '5 minutes')`;
    return {
      deviceId,
      loginId,
      otherUserId,
      input: { ...liveStatement(), terminalLoginId: loginId, loginExpiresAt: new Date(now.getTime() + 1800_000).toISOString() },
      cleanup: async () => {
        await sql`DELETE FROM auth.app_logins WHERE id=${loginId}::uuid`;
        await sql`DELETE FROM auth.app_devices WHERE id=${deviceId}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${otherUserId}::uuid`;
        for (const [key, value] of saved) await settings.set(key, value);
        setSystemTime(NOW);
      },
    };
  };
  test.each([
    "happy",
    "expired-ui",
    "issuer",
    "client",
    "scopes",
    "extra-scopes",
    "epoch",
    "lifetime",
    "deadline",
    "revoked-device",
    "device-owner",
    "login-owner",
    "device-issuer",
    "missing-device",
    "pending",
    "denied",
    "consumed",
    "approval-disabled",
  ] as const)("consumes only the exact live terminal approval: %s", async (scenario) => {
    const f = await terminal();
    try {
      if (scenario === "expired-ui") await sql`UPDATE auth.app_logins SET expires_at=now()-interval '1 second' WHERE id=${f.loginId}::uuid`;
      if (scenario === "issuer") await sql`UPDATE auth.app_logins SET oauth_issuer_app_id='another-issuer' WHERE id=${f.loginId}::uuid`;
      if (scenario === "client") await sql`UPDATE auth.app_logins SET client_id='another-client' WHERE id=${f.loginId}::uuid`;
      if (scenario === "scopes") await sql`UPDATE auth.app_logins SET scopes=ARRAY['openid'] WHERE id=${f.loginId}::uuid`;
      if (scenario === "extra-scopes") await sql`UPDATE auth.app_logins SET scopes=scopes || ARRAY['write'] WHERE id=${f.loginId}::uuid`;
      if (scenario === "epoch") await sql`UPDATE auth.app_logins SET auth_epoch=6 WHERE id=${f.loginId}::uuid`;
      if (scenario === "lifetime") await sql`UPDATE auth.app_logins SET lifetime_seconds=30 WHERE id=${f.loginId}::uuid`;
      if (scenario === "deadline")
        await sql`UPDATE auth.app_logins SET oauth_grant_expires_at=now()-interval '1 second' WHERE id=${f.loginId}::uuid`;
      if (scenario === "revoked-device") await sql`UPDATE auth.app_devices SET revoked_at=now() WHERE id=${f.deviceId}::uuid`;
      if (scenario === "device-owner") await sql`UPDATE auth.app_devices SET user_id=${f.otherUserId}::uuid WHERE id=${f.deviceId}::uuid`;
      if (scenario === "login-owner") await sql`UPDATE auth.app_logins SET user_id=${f.otherUserId}::uuid WHERE id=${f.loginId}::uuid`;
      if (scenario === "device-issuer") await sql`UPDATE auth.app_devices SET issuer='https://other.test' WHERE id=${f.deviceId}::uuid`;
      if (scenario === "missing-device") await sql`DELETE FROM auth.app_devices WHERE id=${f.deviceId}::uuid`;
      if (scenario === "pending" || scenario === "denied" || scenario === "consumed")
        await sql`UPDATE auth.app_logins SET state=${scenario} WHERE id=${f.loginId}::uuid`;
      if (scenario === "approval-disabled") await settings.set("user.app_approval.enabled", false);
      const allowed = scenario === "happy" || scenario === "expired-ui";
      expect((await request(liveRoutes(), f.input)).status).toBe(allowed ? 200 : 403);
      const [login] = await sql`SELECT state FROM auth.app_logins WHERE id=${f.loginId}::uuid`;
      expect(login.state).toBe(allowed ? "consumed" : ["pending", "denied", "consumed"].includes(scenario) ? scenario : "approved");
    } finally {
      await f.cleanup();
    }
  });
  test("issuance waits for the paired device before locking its terminal login", async () => {
    const f = await terminal();
    let issuance: Promise<Response> | undefined;
    let issuerPid: number | undefined;
    try {
      const routes = createIdentityOAuthIssuanceRoutes({
        authorize,
        issuer: async () => issuer,
        now: () => Math.floor(Date.now() / 1000),
        withActiveSigner: async (_purpose, use) =>
          sql.begin(async (db) => {
            await db`SET LOCAL statement_timeout='5s'`;
            const [backend] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            issuerPid = backend!.pid;
            return use({ kid: "platform-oauth-key", key: pair.privateKey, signUntil: new Date(Date.now() + 60_000), issuer }, db);
          }),
      });
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM auth.app_devices WHERE id=${f.deviceId}::uuid FOR UPDATE`;
        const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        issuance = Promise.resolve(request(routes, f.input));
        let blocked = false;
        const deadline = performance.now() + 3000;
        while (performance.now() < deadline) {
          if (issuerPid !== undefined) {
            const [waiting] = await tx<{ blocked: boolean }[]>`SELECT ${holder!.pid}=ANY(pg_blocking_pids(${issuerPid})) AS blocked`;
            if (waiting?.blocked) {
              blocked = true;
              break;
            }
          }
          await Bun.sleep(10);
        }
        expect(blocked).toBe(true);
        // A device decision holds device -> login. Signing must preserve that order.
        expect(await tx`SELECT id FROM auth.app_logins WHERE id=${f.loginId}::uuid FOR UPDATE NOWAIT`).toHaveLength(1);
      });
      expect((await issuance)?.status).toBe(200);
    } finally {
      await issuance;
      await f.cleanup();
    }
  });
  test("terminal consumption rolls back with signing and concurrent requests consume it once", async () => {
    const f = await terminal();
    try {
      const failed = createIdentityOAuthIssuanceRoutes({
        authorize,
        issuer: async () => issuer,
        now: () => Math.floor(Date.now() / 1000),
        withActiveSigner: async (_purpose, use) =>
          sql.begin(async (db) => {
            await use({ kid: "platform-oauth-key", key: pair.privateKey, signUntil: new Date(Date.now() + 60_000), issuer }, db);
            throw new Error("Signing transaction failed before commit");
          }),
      });
      expect((await request(failed, f.input)).status).toBe(500);
      expect((await sql`SELECT state FROM auth.app_logins WHERE id=${f.loginId}::uuid`)[0].state).toBe("approved");
      const outcomes = await Promise.all([request(liveRoutes(), f.input), request(liveRoutes(), f.input)]);
      expect(outcomes.map((r) => r.status).sort()).toEqual([200, 403]);
    } finally {
      await f.cleanup();
    }
  });
});
