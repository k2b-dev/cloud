import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { toPgTextArray } from "@k2b/cloud/services";
import * as settings from "@k2b/cloud/services/settings";
import { sql } from "bun";
import { decodeJwt, generateKeyPair, jwtVerify } from "jose";
import { z } from "zod";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import type { OAuthNewAccessNotice } from "../notifications";
import { notifyPendingOAuthNewAccess } from "./identity-oauth-device-approval";
import { createIdentityOAuthIssuanceRoutes } from "./identity-oauth-issuance";

const USER_ID = "68df7d96-aaab-420a-ab1e-62a67e44d3be";
const userAccess = {
  kind: "user_access" as const,
  grant: { kind: "authorization_code" as const, code: "opaque-code", nonce: "a5ae9b9c-94f4-49a8-a954-c87839affc3d" },
  expiresIn: 3_600 as const,
};

const authorityState = (overrides: Record<string, unknown> = {}) => ({
  authEpoch: 7,
  clientId: "test-client",
  clientScopes: ["openid", "profile"],
  clientAudiences: [],
  clientServiceAccountId: null,
  registrationKind: "managed",
  allowedProfiles: ["user"],
  accessMode: "profiles",
  specificAccess: false,
  grantedScopes: ["openid", "profile"],
  grantedAudiences: ["cloud", "test-client"],
  resource: null,
  nonce: null,
  notAfter: null,
  user: {
    id: USER_ID,
    uid: "alice",
    profile: "user",
    displayName: "Alice Current",
    givenName: "Alice",
    familyName: "Current",
    email: "alice@example.test",
    accountExpires: null,
    groups: ["current-group"],
  },
  serviceAccount: null,
  ...overrides,
});

const setup = async (authenticated = true, state = authorityState()) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  let authCalls = 0;
  const routes = createIdentityOAuthIssuanceRoutes({
    authenticate: (token) => {
      authCalls += 1;
      expect(token).toBe("broker");
      return authenticated;
    },
    withActiveSigner: async (_purpose, callback) =>
      callback(
        {
          kid: "70eb97eb-a2a4-4454-aca5-d1d84af1239c",
          key: privateKey,
          signUntil: new Date(Date.now() + 60_000),
          issuer: "https://cloud.example.test",
        },
        sql,
      ),
    issuer: async () => "https://cloud.example.test",
    resolve: async () => state,
    now: () => 1_788_220_800,
  });
  return { routes, publicKey, authCalls: () => authCalls };
};

describe("Core OAuth issuance authority", () => {
  test("authenticates the configured broker secret before any signer or grant access", async () => {
    const previous = process.env.CLOUD_OAUTH_BROKER_SECRET;
    const { privateKey } = await generateKeyPair("RS256");
    let signerCalls = 0;
    const routes = createIdentityOAuthIssuanceRoutes({
      withActiveSigner: async (_purpose, callback) => {
        signerCalls += 1;
        return callback({ kid: "test", key: privateKey, signUntil: new Date(Date.now() + 60_000), issuer: "https://cloud.test" }, sql);
      },
      resolve: async () => {
        throw new Error("Unauthorized request reached grant resolution");
      },
    });
    const secret = "ab".repeat(32);
    try {
      for (const configured of [undefined, "", "invalid", secret]) {
        if (configured === undefined) delete process.env.CLOUD_OAUTH_BROKER_SECRET;
        else process.env.CLOUD_OAUTH_BROKER_SECRET = configured;
        for (const authorization of [
          undefined,
          "Bearer ",
          "Bearer invalid",
          `Bearer ${"cd".repeat(32)}`,
          `Basic ${secret}`,
          ...(configured === secret ? [] : [`Bearer ${secret}`]),
        ]) {
          for (const path of ["/oauth/ready", "/oauth/token"]) {
            const response = await routes.request(path, {
              method: "POST",
              headers: authorization ? { authorization } : {},
              body: "not JSON",
            });
            expect(response.status).toBe(401);
          }
        }
      }
      expect(signerCalls).toBe(0);
      process.env.CLOUD_OAUTH_BROKER_SECRET = secret;
      const ready = await routes.request("/oauth/ready", { method: "POST", headers: { authorization: `Bearer ${secret}` } });
      expect(ready.status).toBe(204);
      expect(signerCalls).toBe(1);
      const malformed = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        body: "not JSON",
      });
      expect(malformed.status).toBe(400);
    } finally {
      if (previous === undefined) delete process.env.CLOUD_OAUTH_BROKER_SECRET;
      else process.env.CLOUD_OAUTH_BROKER_SECRET = previous;
    }
  });
  test("derives the user access-token authority from current state", async () => {
    const { routes, publicKey } = await setup();
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer broker", "content-type": "application/json" },
      body: JSON.stringify({ tokens: [userAccess] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { tokens: string[] };
    const verified = await jwtVerify(body.tokens[0]!, publicKey, {
      issuer: "https://cloud.example.test",
      audience: "cloud",
      currentDate: new Date(1_788_220_800_000),
    });
    expect(verified.protectedHeader).toMatchObject({ alg: "RS256", kid: "70eb97eb-a2a4-4454-aca5-d1d84af1239c" });
    expect(verified.payload).toMatchObject({
      sub: authorityState().user?.id,
      uid: "alice",
      id: authorityState().user?.id,
      token_use: "access",
      principal_type: "user",
      auth_epoch: 7,
      client_id: "test-client",
      scope: "openid profile",
      exp: 1_788_224_400,
    });
  });

  test("requires the exact OAuth broker before parsing the body", async () => {
    const { routes, authCalls } = await setup(false);
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer broker", "content-type": "application/json" },
      body: "not-json",
    });
    expect(response.status).toBe(401);
    expect(authCalls()).toBe(1);
    expect(
      (
        await routes.request("/oauth/ready", {
          method: "POST",
          headers: { authorization: "Bearer broker" },
        })
      ).status,
    ).toBe(401);
  });

  test("probes broker and active OAuth signer readiness without consuming a grant", async () => {
    const { routes } = await setup();
    const response = await routes.request("/oauth/ready", {
      method: "POST",
      headers: { authorization: "Bearer broker" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("derives service-account binding from current state", async () => {
    const serviceAccountId = "cce0b815-8f75-4dad-b28f-ab40c0967718";
    const state = authorityState({
      user: null,
      clientServiceAccountId: serviceAccountId,
      clientScopes: ["read"],
      grantedScopes: ["read"],
      serviceAccount: {
        id: serviceAccountId,
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId: "mail",
        resourceType: "mailbox",
        resourceId: "inbox",
      },
    });
    const { routes, publicKey } = await setup(true, state);
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer broker", "content-type": "application/json" },
      body: JSON.stringify({
        tokens: [
          {
            kind: "service_access",
            grant: {
              kind: "client_credentials",
              grantId: "dd8cc597-4268-43f2-abdf-ec008245ef10",
              nonce: "a771d825-b5d4-44d7-a0c2-17f97f37bd02",
            },
            expiresIn: 3_600,
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tokens: string[] };
    const verified = await jwtVerify(body.tokens[0]!, publicKey, {
      issuer: "https://cloud.example.test",
      audience: "cloud",
      currentDate: new Date(1_788_220_800_000),
    });
    expect(verified.payload.auth_epoch).toBeUndefined();
    expect(verified.payload).toMatchObject({
      sub: serviceAccountId,
      service_account_id: serviceAccountId,
      service_account_kind: "resource_bound",
      app_id: "mail",
      resource_type: "mailbox",
      resource_id: "inbox",
    });
  });

  test("signs a standalone agent account without a resource binding and refuses a smuggled one", async () => {
    const serviceAccountId = "5b1c9f6e-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
    const grant = {
      kind: "client_credentials" as const,
      grantId: "dd8cc597-4268-43f2-abdf-ec008245ef10",
      nonce: "a771d825-b5d4-44d7-a0c2-17f97f37bd02",
    };
    const account = {
      id: serviceAccountId,
      kind: "agent",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
    };
    const request = (routes: Awaited<ReturnType<typeof setup>>["routes"]) =>
      routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({ tokens: [{ kind: "service_access", grant, expiresIn: 3_600 }] }),
      });

    const agent = await setup(
      true,
      authorityState({
        user: null,
        clientServiceAccountId: serviceAccountId,
        clientScopes: ["read"],
        grantedScopes: ["read"],
        serviceAccount: account,
      }),
    );
    const response = await request(agent.routes);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tokens: string[] };
    const verified = await jwtVerify(body.tokens[0]!, agent.publicKey, {
      issuer: "https://cloud.example.test",
      audience: "cloud",
      currentDate: new Date(1_788_220_800_000),
    });
    expect(verified.payload.auth_epoch).toBeUndefined();
    expect(verified.payload).toMatchObject({
      sub: serviceAccountId,
      principal_type: "service_account",
      service_account_id: serviceAccountId,
      service_account_kind: "agent",
      app_id: null,
      resource_type: null,
      resource_id: null,
    });

    for (const invalid of [
      { ...account, appId: "mail" },
      { ...account, status: "disabled" },
      { ...account, kind: "user_delegated", delegatedUserId: "7d2a3b4c-5d6e-4f70-8192-a3b4c5d6e7f8" },
    ]) {
      const denied = await setup(
        true,
        authorityState({
          user: null,
          clientServiceAccountId: serviceAccountId,
          clientScopes: ["read"],
          grantedScopes: ["read"],
          serviceAccount: invalid,
        }),
      );
      expect((await request(denied.routes)).status).toBe(403);
    }
  });

  test("rejects arbitrary claims and expanded lifetimes", async () => {
    const { routes } = await setup();
    for (const token of [
      { ...userAccess, admin: true },
      { ...userAccess, userId: "forged" },
      ...[3601, 0, 1.5].flatMap((expiresIn) => [
        { ...userAccess, expiresIn },
        { ...userAccess, kind: "user_id", expiresIn },
        {
          kind: "service_access",
          grant: {
            kind: "client_credentials",
            grantId: "dd8cc597-4268-43f2-abdf-ec008245ef10",
            nonce: "a771d825-b5d4-44d7-a0c2-17f97f37bd02",
          },
          expiresIn,
        },
      ]),
      { ...userAccess, kind: "arbitrary" },
      {
        kind: "service_access",
        grant: {
          kind: "client_credentials",
          grantId: "dd8cc597-4268-43f2-abdf-ec008245ef10",
          nonce: "a771d825-b5d4-44d7-a0c2-17f97f37bd02",
        },
        requestedScope: "admin",
        expiresIn: 3_600,
      },
    ]) {
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({ tokens: [token] }),
      });
      expect(response.status).toBe(400);
    }
  });

  test("signs access and ID tokens for a shorter requested lifetime", async () => {
    const { routes, publicKey } = await setup();
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer broker", "content-type": "application/json" },
      body: JSON.stringify({
        tokens: [
          { ...userAccess, expiresIn: 600 },
          { ...userAccess, kind: "user_id", expiresIn: 600 },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = z.object({ tokens: z.array(z.string()) }).parse(await response.json());
    for (const token of body.tokens) {
      const verified = await jwtVerify(token, publicKey, { currentDate: new Date(1_788_220_800_000) });
      expect(verified.payload.exp).toBe(1_788_221_400);
      expect(verified.payload.auth_epoch).toBe(token === body.tokens[0] ? 7 : undefined);
    }
  });

  test("independently clamps refreshed access and ID tokens to the family's absolute expiry", async () => {
    const now = 1_788_220_800;
    const grant = { kind: "refresh_token", tokenId: USER_ID, nonce: userAccess.grant.nonce };
    for (const remaining of [120, 0, -1]) {
      const { routes, publicKey } = await setup(true, authorityState({ notAfter: new Date((now + remaining) * 1000) }));
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [
            { kind: "user_access", grant, expiresIn: 3600 },
            { kind: "user_id", grant, expiresIn: 3600 },
          ],
        }),
      });
      expect(response.status).toBe(remaining > 0 ? 200 : 403);
      if (remaining > 0) {
        const body = z.object({ tokens: z.array(z.string()) }).parse(await response.json());
        for (const token of body.tokens) {
          const verified = await jwtVerify(token, publicKey, { currentDate: new Date(now * 1000) });
          expect(verified.payload.exp).toBe(now + remaining);
        }
      } else {
        expect(await response.json()).toEqual({ message: "Forbidden" });
      }
    }
  });

  test("rejects stale principal, scope, audience, and access authority", async () => {
    for (const [token, state] of [
      [userAccess, authorityState({ grantedScopes: ["openid", "write"] })],
      [userAccess, authorityState({ resource: "https://attacker.example.test" })],
      [userAccess, authorityState({ allowedProfiles: ["guest"] })],
      [userAccess, authorityState({ accessMode: "specific", specificAccess: false })],
      [userAccess, authorityState({ user: { ...authorityState().user!, accountExpires: new Date(1_788_220_799_000) } })],
    ] as const) {
      const { routes } = await setup(true, state);
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({ tokens: [token] }),
      });
      expect(response.status).toBe(403);
    }
  });

  test("checks account expiry after waiting for the signer and resolving authority", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    let now = 1_788_220_800;
    const routes = createIdentityOAuthIssuanceRoutes({
      authenticate: () => true,
      issuer: async () => "https://cloud.example.test",
      now: () => now,
      withActiveSigner: async (_purpose, callback) => {
        now += 10;
        return callback(
          { kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000), issuer: "https://cloud.example.test" },
          sql,
        );
      },
      resolve: async () => authorityState({ user: { ...authorityState().user, accountExpires: new Date(1_788_220_805_000) } }),
    });
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer broker", "content-type": "application/json" },
      body: JSON.stringify({ tokens: [userAccess] }),
    });
    expect(response.status).toBe(403);
  });
});

/** The new-access notice is sent after the response; wait for it instead of assuming an order. */
const eventually = async (check: () => boolean | Promise<boolean>, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const notifiedAt = async (familyId: string) =>
  (await sql<{ notified_at: Date | null }[]>`SELECT notified_at FROM oauth.refresh_token_families WHERE id=${familyId}::uuid`)[0]
    ?.notified_at ?? null;

const withFrozenTime = async (run: () => Promise<void>) => {
  const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;
  setSystemTime(clock!.now);
  try {
    await run();
  } finally {
    setSystemTime();
  }
};

const withDatabase = databaseSuite();

const epochAuthorityFixture = async (notify?: (notice: OAuthNewAccessNotice) => Promise<unknown>) => {
  const userId = crypto.randomUUID();
  const otherUserId = crypto.randomUUID();
  const clientId = `epoch-${crypto.randomUUID()}`;
  const otherClientId = `epoch-other-${crypto.randomUUID()}`;
  const authEpoch = 5;
  const notices: OAuthNewAccessNotice[] = [];
  const { privateKey } = await generateKeyPair("RS256");
  await sql`INSERT INTO auth.users (id, uid, provider, profile, auth_epoch)
    VALUES (${userId}::uuid, ${userId}, 'local', 'user', ${authEpoch}),
      (${otherUserId}::uuid, ${otherUserId}, 'local', 'user', ${authEpoch})`;
  for (const id of [clientId, otherClientId]) {
    await sql`INSERT INTO oauth.clients (name, client_id, redirect_uris, scopes, audiences)
      VALUES (${id}, ${id}, ARRAY['https://client.example.test/callback'], ARRAY['openid', 'offline_access'], ARRAY['cloud'])`;
  }
  const routes = createIdentityOAuthIssuanceRoutes({
    authenticate: () => true,
    notifyNewAccess: async (notice) => {
      notices.push(notice);
      await notify?.(notice);
    },
    issuer: async () => "https://cloud.example.test",
    now: () => Math.floor(Date.now() / 1000),
    withActiveSigner: (_purpose, callback) =>
      sql.begin((db) =>
        callback(
          {
            kid: crypto.randomUUID(),
            key: privateKey,
            signUntil: new Date(Date.now() + 60_000),
            issuer: "https://cloud.example.test",
          },
          db,
        ),
      ),
  });
  return {
    userId,
    otherUserId,
    clientId,
    otherClientId,
    authEpoch,
    notices,
    code: async (scopes: string[] = ["openid", "offline_access"], epoch: number | null = authEpoch, confirmed = true) => {
      const code = crypto.randomUUID();
      const nonce = crypto.randomUUID();
      await sql`INSERT INTO oauth.codes (code, client_id, user_id, auth_epoch, redirect_uri, scopes, audiences, used, authority_nonce, confirmed_at)
        VALUES (${code}, ${clientId}, ${userId}::uuid, ${epoch}, 'https://client.example.test/callback',
          ${toPgTextArray(scopes)}::text[], ARRAY['cloud', ${clientId}], true, ${nonce}::uuid, CASE WHEN ${confirmed} THEN now() ELSE NULL END)`;
      return { kind: "authorization_code" as const, code, nonce };
    },
    reserve: async (options: { clientId?: string; userId?: string; authEpoch?: number; status?: string } = {}) => {
      const [family] = await sql<{ id: string; expires_at: Date }[]>`
        INSERT INTO oauth.refresh_token_families (client_id, user_id, auth_epoch, scopes, audiences, status, expires_at, notified_at)
        VALUES (${options.clientId ?? clientId}, ${options.userId ?? userId}::uuid, ${options.authEpoch ?? authEpoch},
          ARRAY['openid', 'offline_access'], ARRAY['cloud', ${clientId}], ${options.status ?? "reserved"}, now() + interval '2 minutes',
          CASE WHEN ${options.status ?? "reserved"} = 'reserved' THEN now() ELSE NULL END)
        RETURNING id, expires_at
      `;
      return family!;
    },
    issue: (grant: Record<string, unknown>, idToken = false) =>
      routes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [{ kind: "user_access", grant, expiresIn: 3600 }, ...(idToken ? [{ kind: "user_id", grant, expiresIn: 3600 }] : [])],
        }),
      }),
    cleanup: async () => {
      await sql`DELETE FROM oauth.clients WHERE client_id IN (${clientId}, ${otherClientId})`;
      await sql`DELETE FROM auth.users WHERE id IN (${userId}::uuid, ${otherUserId}::uuid)`;
    },
  };
};

withDatabase("Core OAuth issuance authority database resolution", () => {
  test("signed access and ID claims exclude personal groups and retain ordinary ancestors", () =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture();
      const personal = crypto.randomUUID();
      const team = crypto.randomUUID();
      try {
        await sql`UPDATE oauth.clients SET scopes=ARRAY['openid','groups'] WHERE client_id=${f.clientId}`;
        await sql`INSERT INTO auth.groups(id,cn,name,provider) VALUES
          (${personal}::uuid,'local:claim-private','claim-private','local'),(${team}::uuid,'local:claim-team','claim-team','local')`;
        await sql`INSERT INTO auth.personal_groups(group_id,owner_id,group_name,gid_number)
          VALUES(${personal}::uuid,${f.userId}::uuid,'claim-private',1500002)`;
        await sql`INSERT INTO auth.user_groups_v2 VALUES(${f.userId}::uuid,${personal}::uuid)`;
        await sql`INSERT INTO auth.group_groups_v2 VALUES(${team}::uuid,${personal}::uuid)`;
        const response = await f.issue(await f.code(["openid", "groups"]), true);
        expect(response.status).toBe(200);
        const body = z.object({ tokens: z.array(z.string()).length(2) }).parse(await response.json());
        for (const token of body.tokens) expect(decodeJwt(token).groups).toEqual(["claim-team"]);
      } finally {
        await sql`DELETE FROM auth.groups WHERE id IN (${personal}::uuid,${team}::uuid)`;
        await sql`DELETE FROM auth.personal_groups WHERE group_id=${personal}::uuid`;
        await f.cleanup();
      }
    }));

  test.each(["authorization_code", "device_code"] as const)("new offline access needs committed confirmation evidence: %s", (kind) =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture();
      try {
        await sql`UPDATE oauth.clients SET is_public=true,allow_device_grant=true WHERE client_id=${f.clientId}`;
        for (const confirmed of [false, true]) {
          const family = await f.reserve();
          let grant: Record<string, unknown>;
          let deviceId: string | undefined;
          if (kind === "authorization_code") grant = await f.code(undefined, undefined, confirmed);
          else {
            deviceId = crypto.randomUUID();
            const nonce = crypto.randomUUID();
            await sql`INSERT INTO oauth.device_authorizations(id,device_code_hash,user_code_hash,client_id,scopes,audiences,status,user_id,
              expires_at,authority_nonce,auth_epoch,confirmed_at)
              VALUES (${deviceId}::uuid,${deviceId},${deviceId},${f.clientId},ARRAY['openid','offline_access'],ARRAY['cloud',${f.clientId}],
                'consumed',${f.userId}::uuid,now()+interval '10 minutes',${nonce}::uuid,${f.authEpoch},CASE WHEN ${confirmed} THEN now() ELSE NULL END)`;
            grant = { kind, deviceAuthorizationId: deviceId, nonce };
          }
          const request = { ...grant, familyId: family.id };
          expect((await f.issue(request)).status).toBe(confirmed ? 200 : 403);
          if (confirmed) await eventually(async () => (await notifiedAt(family.id)) !== null, "the new-access notice");
          const [row] = await sql`SELECT status,notified_at FROM oauth.refresh_token_families WHERE id=${family.id}::uuid`;
          expect(row.status).toBe(confirmed ? "active" : "reserved");
          expect(f.notices).toHaveLength(confirmed ? 1 : 0);
          if (confirmed) {
            expect(f.notices[0]).toMatchObject({ familyId: family.id, userId: f.userId, kind: "app", clientName: f.clientId });
            expect((await f.issue(request)).status).toBe(403);
            expect(f.notices).toHaveLength(1);
          }
        }
      } finally {
        await f.cleanup();
      }
    }),
  );

  test("a notice that never finishes does not hold the token response", () =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture(() => new Promise(() => undefined));
      try {
        const family = await f.reserve();
        const grant = await f.code();
        const started = performance.now();
        expect((await f.issue({ ...grant, familyId: family.id })).status).toBe(200);
        expect(performance.now() - started).toBeLessThan(2_000);
        await eventually(() => f.notices.length === 1, "the notice attempt");
        const [row] = await sql`SELECT status,notified_at FROM oauth.refresh_token_families WHERE id=${family.id}::uuid`;
        expect(row.status).toBe("active");
        expect(row.notified_at).toBeNull();
      } finally {
        await f.cleanup();
      }
    }));

  test("a notice failure after commit keeps the token response successful and leaves a pending notice", () =>
    withFrozenTime(async () => {
      let attempts = 0;
      const f = await epochAuthorityFixture(async (notice) => {
        const [family] = await sql`SELECT status FROM oauth.refresh_token_families WHERE id=${notice.familyId}::uuid`;
        // This separate pool query sees the committed activation before any send occurs.
        expect(family.status).toBe("active");
        attempts += 1;
        throw new Error("The new-access notice could not be prepared");
      });
      try {
        const family = await f.reserve();
        const grant = await f.code();
        expect((await f.issue({ ...grant, familyId: family.id })).status).toBe(200);
        await eventually(() => attempts === 1, "the failed notice attempt");
        await Bun.sleep(50);
        expect(attempts).toBe(1);
        const [pending] = await sql`SELECT status,notified_at FROM oauth.refresh_token_families WHERE id=${family.id}::uuid`;
        expect(pending.status).toBe("active");
        expect(pending.notified_at).toBeNull();
      } finally {
        await f.cleanup();
      }
    }));

  test("rotation long after the browser confirmation needs no fresh evidence and sends no notice", () =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture();
      try {
        const family = await f.reserve({ status: "active" });
        await sql`UPDATE oauth.refresh_token_families SET created_at=now()-interval '2 days',notified_at=now()-interval '2 days'
          WHERE id=${family.id}::uuid`;
        const nonce = crypto.randomUUID();
        const [token] = await sql<{ id: string }[]>`INSERT INTO oauth.refresh_tokens(family_id,token_prefix,secret_hash,generation,status,
          expires_at,authority_nonce,authority_reserved_at,authority_scopes,authority_audiences)
          VALUES (${family.id}::uuid,${crypto.randomUUID().replaceAll("-", "").slice(0, 24)},'unused',1,'issuing',now()+interval '2 minutes',
            ${nonce}::uuid,now(),ARRAY['openid','offline_access'],ARRAY['cloud',${f.clientId}]) RETURNING id`;
        expect((await f.issue({ kind: "refresh_token", tokenId: token!.id, nonce })).status).toBe(200);
        expect(f.notices).toHaveLength(0);
      } finally {
        await f.cleanup();
      }
    }));

  test("maintenance retries pending new-access notices, respects cancellation and marks only successful sends", () =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture();
      try {
        const family = await f.reserve({ status: "active" });
        let attempts = 0;
        const notify = async (notice: OAuthNewAccessNotice) => {
          if (notice.familyId !== family.id) throw new Error("Not this test's family");
          attempts += 1;
          if (attempts === 1) throw new Error("The new-access notice could not be prepared");
        };
        await notifyPendingOAuthNewAccess(notify, AbortSignal.abort());
        expect(attempts).toBe(0);
        await notifyPendingOAuthNewAccess(notify);
        expect(attempts).toBe(1);
        const [pending] = await sql`SELECT notified_at FROM oauth.refresh_token_families WHERE id=${family.id}::uuid`;
        expect(pending.notified_at).toBeNull();
        await notifyPendingOAuthNewAccess(notify);
        expect(attempts).toBe(2);
        const [sent] = await sql`SELECT notified_at FROM oauth.refresh_token_families WHERE id=${family.id}::uuid`;
        expect(sent.notified_at).toBeInstanceOf(Date);
        await notifyPendingOAuthNewAccess(notify);
        expect(attempts).toBe(2);
      } finally {
        await f.cleanup();
      }
    }));

  test("maintenance still tells about access that ended before the notice went out, but not about a reservation", () =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture();
      try {
        const signedOut = await f.reserve({ status: "active" });
        const neverActive = await f.reserve();
        await sql`UPDATE oauth.refresh_token_families SET status='revoked',revoked_at=now(),expires_at=now()-interval '1 second'
          WHERE id IN (${signedOut.id}::uuid, ${neverActive.id}::uuid)`;
        const sent: string[] = [];
        await notifyPendingOAuthNewAccess(async (notice) => {
          if (notice.familyId !== signedOut.id && notice.familyId !== neverActive.id) throw new Error("Not this test's family");
          sent.push(notice.familyId);
        });
        expect(sent).toEqual([signedOut.id]);
        expect(await notifiedAt(signedOut.id)).toBeInstanceOf(Date);
      } finally {
        await f.cleanup();
      }
    }));

  test("code epochs must match the user before the code is marked issued", () =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture();
      try {
        for (const epoch of [f.authEpoch - 1, null]) {
          const grant = await f.code(["openid"], epoch);
          expect((await f.issue(grant)).status).toBe(403);
          const [row] = await sql<
            { authority_issued_at: Date | null }[]
          >`SELECT authority_issued_at FROM oauth.codes WHERE code = ${grant.code}`;
          expect(row?.authority_issued_at).toBeNull();
        }
      } finally {
        await f.cleanup();
      }
    }));

  test("code issuance activates one matching reservation and caps both token expiries", () =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture();
      try {
        const family = await f.reserve();
        const grant = await f.code();
        const response = await f.issue({ ...grant, familyId: family.id }, true);
        expect(response.status).toBe(200);
        const body = z.object({ tokens: z.array(z.string()) }).parse(await response.json());
        expect(body.tokens).toHaveLength(2);
        for (const token of body.tokens) expect(decodeJwt(token).exp).toBe(Math.floor(family.expires_at.getTime() / 1000));
        expect(decodeJwt(body.tokens[0]!).auth_epoch).toBe(f.authEpoch);
        expect(decodeJwt(body.tokens[1]!).auth_epoch).toBeUndefined();
        const [row] = await sql<{ status: string }[]>`SELECT status FROM oauth.refresh_token_families WHERE id = ${family.id}::uuid`;
        expect(row?.status).toBe("active");
        // A fresh grant cannot activate an already active family either.
        const second = await f.code();
        expect((await f.issue({ ...second, familyId: family.id })).status).toBe(403);
        const [unissued] = await sql<
          { authority_issued_at: Date | null }[]
        >`SELECT authority_issued_at FROM oauth.codes WHERE code = ${second.code}`;
        expect(unissued?.authority_issued_at).toBeNull();
      } finally {
        await f.cleanup();
      }
    }));

  for (const mismatch of ["client", "user", "epoch", "expired"] as const) {
    test(`code issuance refuses a reservation with a different ${mismatch}`, () =>
      withFrozenTime(async () => {
        const f = await epochAuthorityFixture();
        try {
          const family = await f.reserve({
            ...(mismatch === "client" ? { clientId: f.otherClientId } : {}),
            ...(mismatch === "user" ? { userId: f.otherUserId } : {}),
            ...(mismatch === "epoch" ? { authEpoch: f.authEpoch - 1 } : {}),
          });
          if (mismatch === "expired")
            await sql`UPDATE oauth.refresh_token_families SET expires_at = now() - interval '1 minute' WHERE id = ${family.id}::uuid`;
          const grant = await f.code();
          expect((await f.issue({ ...grant, familyId: family.id })).status).toBe(403);
          const [row] = await sql<{ status: string }[]>`SELECT status FROM oauth.refresh_token_families WHERE id = ${family.id}::uuid`;
          expect(row?.status).toBe("reserved");
          const [code] = await sql<
            { authority_issued_at: Date | null }[]
          >`SELECT authority_issued_at FROM oauth.codes WHERE code = ${grant.code}`;
          expect(code?.authority_issued_at).toBeNull();
        } finally {
          await f.cleanup();
        }
      }));
  }

  test("offline access requires a reservation and other code scopes exclude one", () =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture();
      try {
        expect((await f.issue(await f.code())).status).toBe(403);
        const family = await f.reserve();
        expect((await f.issue({ ...(await f.code(["openid"])), familyId: family.id })).status).toBe(403);
        const [row] = await sql<{ status: string }[]>`SELECT status FROM oauth.refresh_token_families WHERE id = ${family.id}::uuid`;
        expect(row?.status).toBe("reserved");
      } finally {
        await f.cleanup();
      }
    }));

  test("issuance waits for the account row before it holds the grant, so a concurrent account deletion completes", () =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture();
      try {
        const grant = await f.code(["openid"]);
        let issued: ReturnType<typeof f.issue> | undefined;
        await sql.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '5s'`;
          const [self] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await tx`SELECT id FROM auth.users WHERE id = ${f.userId}::uuid FOR UPDATE`;
          issued = f.issue(grant);
          let blocked = false;
          for (let attempt = 0; attempt < 1_000 && !blocked; attempt += 1) {
            const [row] = await sql<{ waiting: boolean }[]>`
              SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${self!.pid}::integer = ANY(pg_blocking_pids(pid))) AS waiting`;
            blocked = row!.waiting;
          }
          expect(blocked).toBe(true);
          // Account deletion cascades into the account's grants; a grant locked before the account would deadlock here.
          await tx`DELETE FROM oauth.codes WHERE code = ${grant.code}`;
          await tx`DELETE FROM auth.users WHERE id = ${f.userId}::uuid`;
        });
        expect((await issued!).status).toBe(403);
      } finally {
        await f.cleanup();
      }
    }));

  test("refresh issuance refuses a family from an earlier account epoch", () =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture();
      try {
        const family = await f.reserve({ status: "active", authEpoch: f.authEpoch - 1 });
        const nonce = crypto.randomUUID();
        const [token] = await sql<{ id: string }[]>`
        INSERT INTO oauth.refresh_tokens (family_id, token_prefix, secret_hash, generation, status, expires_at,
          authority_nonce, authority_reserved_at, authority_scopes, authority_audiences)
        VALUES (${family.id}::uuid, ${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}, 'unused', 1, 'issuing', now() + interval '2 minutes',
          ${nonce}::uuid, now(), ARRAY['openid'], ARRAY['cloud', ${f.clientId}]) RETURNING id
      `;
        expect((await f.issue({ kind: "refresh_token", tokenId: token!.id, nonce })).status).toBe(403);
        const [row] = await sql<
          { authority_issued_at: Date | null }[]
        >`SELECT authority_issued_at FROM oauth.refresh_tokens WHERE id = ${token!.id}::uuid`;
        expect(row?.authority_issued_at).toBeNull();
      } finally {
        await f.cleanup();
      }
    }));

  test("loads current principal and client authority in the issuance request", async () => {
    const userId = crypto.randomUUID();
    const clientId = `core-authority-${crypto.randomUUID()}`;
    const code = crypto.randomUUID();
    const authorityNonce = crypto.randomUUID();
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn, mail)
        VALUES (${userId}::uuid, ${`user-${userId}`}, 'local', 'user', 'Current User', 'Current', 'User', 'current@example.test')
      `;
      await sql`
        INSERT INTO oauth.clients (name, client_id, redirect_uris, scopes, audiences, allowed_profiles, access_mode, registration_kind, is_public)
        VALUES (${`Core authority ${userId}`}, ${clientId}, ARRAY['https://client.example.test/callback'],
          ARRAY['openid', 'profile'], ARRAY['cloud'], ARRAY['user'], 'profiles', 'managed', false)
      `;
      await sql`
        INSERT INTO oauth.codes (code, client_id, user_id, redirect_uri, scopes, audiences, used, authority_nonce, auth_epoch)
        VALUES (${code}, ${clientId}, ${userId}::uuid, 'https://client.example.test/callback', ARRAY['openid', 'profile'],
          ARRAY['cloud', ${clientId}], true, ${authorityNonce}::uuid, 0)
      `;
      const routes = createIdentityOAuthIssuanceRoutes({
        authenticate: () => true,
        withActiveSigner: async (_purpose, callback) =>
          sql.begin((db) =>
            callback(
              { kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000), issuer: "https://cloud.example.test" },
              db,
            ),
          ),
        issuer: async () => "https://cloud.example.test",
      });
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [
            {
              kind: "user_access",
              grant: { kind: "authorization_code", code, nonce: authorityNonce },
              expiresIn: 3_600,
            },
          ],
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { tokens: string[] };
      expect(
        (await jwtVerify(body.tokens[0]!, publicKey, { issuer: "https://cloud.example.test", audience: clientId })).payload,
      ).toMatchObject({
        sub: userId,
        uid: `user-${userId}`,
      });
      const replay = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [{ kind: "user_access", grant: { kind: "authorization_code", code, nonce: authorityNonce }, expiresIn: 3_600 }],
        }),
      });
      expect(replay.status).toBe(403);
      const legacyCode = crypto.randomUUID();
      const legacyNonce = crypto.randomUUID();
      await sql`
        INSERT INTO oauth.codes (
          code, client_id, user_id, redirect_uri, scopes, audiences, used, authority_nonce, authority_issued_at
        ) VALUES (
          ${legacyCode}, ${clientId}, ${userId}::uuid, 'https://client.example.test/callback', ARRAY['openid'],
          ARRAY['cloud', ${clientId}], true, ${legacyNonce}::uuid, now()
        )
      `;
      const legacyReplay = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [
            {
              kind: "user_access",
              grant: { kind: "authorization_code", code: legacyCode, nonce: legacyNonce },
              expiresIn: 3_600,
            },
          ],
        }),
      });
      expect(legacyReplay.status).toBe(403);
    } finally {
      await sql`DELETE FROM oauth.codes WHERE code = ${code}`;
      await sql`DELETE FROM oauth.clients WHERE client_id = ${clientId}`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("derives client-credentials authority from the current bound service account", async () => {
    const serviceAccountId = crypto.randomUUID();
    const clientId = `service-authority-${crypto.randomUUID()}`;
    const grantId = crypto.randomUUID();
    const grantNonce = crypto.randomUUID();
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    try {
      await sql`
        INSERT INTO auth.service_accounts (id, name, kind, status, app_id, resource_type, resource_id)
        VALUES (${serviceAccountId}::uuid, 'OAuth authority test', 'resource_bound', 'active', 'mail', 'mailbox', 'inbox')
      `;
      await sql`
        INSERT INTO oauth.clients (name, client_id, redirect_uris, scopes, audiences, service_account_id, allowed_profiles, access_mode, registration_kind, is_public)
        VALUES (${`Service authority ${serviceAccountId}`}, ${clientId}, ARRAY[]::text[], ARRAY['read'], ARRAY['cloud'],
          ${serviceAccountId}::uuid, ARRAY['user'], 'profiles', 'managed', false)
      `;
      await sql`
        INSERT INTO oauth.client_credentials_authority_grants (id, nonce, client_id, scopes, audiences)
        VALUES (${grantId}::uuid, ${grantNonce}::uuid, ${clientId}, ARRAY['read'], ARRAY['cloud', ${clientId}])
      `;
      const routes = createIdentityOAuthIssuanceRoutes({
        authenticate: () => true,
        withActiveSigner: async (_purpose, callback) =>
          sql.begin((db) =>
            callback(
              { kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000), issuer: "https://cloud.example.test" },
              db,
            ),
          ),
        issuer: async () => "https://cloud.example.test",
      });
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [{ kind: "service_access", grant: { kind: "client_credentials", grantId, nonce: grantNonce }, expiresIn: 3_600 }],
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { tokens: string[] };
      expect(
        (await jwtVerify(body.tokens[0]!, publicKey, { issuer: "https://cloud.example.test", audience: clientId })).payload,
      ).toMatchObject({
        sub: serviceAccountId,
        service_account_id: serviceAccountId,
        app_id: "mail",
        resource_type: "mailbox",
        resource_id: "inbox",
        scope: "read",
      });
      const replay = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [{ kind: "service_access", grant: { kind: "client_credentials", grantId, nonce: grantNonce }, expiresIn: 3_600 }],
        }),
      });
      expect(replay.status).toBe(403);
      const staleGrantId = crypto.randomUUID();
      const staleGrantNonce = crypto.randomUUID();
      await sql`
        INSERT INTO oauth.client_credentials_authority_grants (id, nonce, client_id, scopes, audiences)
        VALUES (${staleGrantId}::uuid, ${staleGrantNonce}::uuid, ${clientId}, ARRAY['read'], ARRAY['cloud', ${clientId}])
      `;
      await sql`UPDATE oauth.clients SET scopes = ARRAY[]::text[] WHERE client_id = ${clientId}`;
      const stale = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [
            {
              kind: "service_access",
              grant: { kind: "client_credentials", grantId: staleGrantId, nonce: staleGrantNonce },
              expiresIn: 3_600,
            },
          ],
        }),
      });
      expect(stale.status).toBe(403);
      const [staleGrant] = await sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM oauth.client_credentials_authority_grants WHERE id = ${staleGrantId}::uuid
      `;
      expect(staleGrant?.consumed_at).toBeNull();
    } finally {
      await sql`DELETE FROM oauth.clients WHERE client_id = ${clientId}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
    }
  });

  test("consumes one reserved refresh issuance exactly once", async () => {
    const userId = crypto.randomUUID();
    const clientId = `refresh-authority-${crypto.randomUUID()}`;
    const familyId = crypto.randomUUID();
    const tokenId = crypto.randomUUID();
    const authorityNonce = crypto.randomUUID();
    const familyExpiresAt = new Date(Date.now() + 120_000);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${userId}::uuid, ${`refresh-${userId}`}, 'local', 'user', 'Refresh User', 'Refresh', 'User')
      `;
      await sql`
        INSERT INTO oauth.clients (name, client_id, redirect_uris, scopes, audiences, allowed_profiles, access_mode, registration_kind, is_public)
        VALUES (${`Refresh authority ${userId}`}, ${clientId}, ARRAY['https://client.example.test/callback'],
          ARRAY['openid'], ARRAY['cloud'], ARRAY['user'], 'profiles', 'managed', false)
      `;
      await sql`
        INSERT INTO oauth.refresh_token_families (id, client_id, user_id, scopes, audiences, status, expires_at, auth_epoch)
        VALUES (${familyId}::uuid, ${clientId}, ${userId}::uuid, ARRAY['openid'], ARRAY['cloud', ${clientId}], 'active', ${familyExpiresAt}, 0)
      `;
      await sql`
        INSERT INTO oauth.refresh_tokens (
          id, family_id, token_prefix, secret_hash, status, generation, expires_at, authority_nonce, authority_reserved_at,
          authority_scopes, authority_audiences
        ) VALUES (
          ${tokenId}::uuid, ${familyId}::uuid, ${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}, 'not-used', 'issuing', 1,
          ${familyExpiresAt}, ${authorityNonce}::uuid, now(), ARRAY['openid'], ARRAY['cloud', ${clientId}]
        )
      `;
      const routes = createIdentityOAuthIssuanceRoutes({
        authenticate: () => true,
        withActiveSigner: async (_purpose, callback) =>
          sql.begin((db) =>
            callback(
              { kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000), issuer: "https://cloud.example.test" },
              db,
            ),
          ),
        issuer: async () => "https://cloud.example.test",
      });
      await sql`UPDATE oauth.clients SET audiences = ARRAY['cloud', 'https://new.example.test'] WHERE client_id = ${clientId}`;
      const request = () =>
        routes.request("/oauth/token", {
          method: "POST",
          headers: { authorization: "Bearer broker", "content-type": "application/json" },
          body: JSON.stringify({
            tokens: [
              { kind: "user_access", grant: { kind: "refresh_token", tokenId, nonce: authorityNonce }, expiresIn: 3_600 },
              { kind: "user_id", grant: { kind: "refresh_token", tokenId, nonce: authorityNonce }, expiresIn: 3_600 },
            ],
          }),
        });
      const issued = await request();
      expect(issued.status).toBe(200);
      const issuedBody = (await issued.json()) as { tokens: string[] };
      const verified = await jwtVerify(issuedBody.tokens[0]!, publicKey, { issuer: "https://cloud.example.test" });
      expect(verified.payload.aud).toEqual(["cloud", clientId]);
      expect(verified.payload.exp).toBe(Math.floor(familyExpiresAt.getTime() / 1000));
      const idToken = await jwtVerify(issuedBody.tokens[1]!, publicKey, { issuer: "https://cloud.example.test" });
      expect(idToken.payload.exp).toBe(verified.payload.exp);
      const [token] = await sql<{ authority_issued_at: Date | null }[]>`
        SELECT authority_issued_at FROM oauth.refresh_tokens WHERE id = ${tokenId}::uuid
      `;
      expect(token?.authority_issued_at).toBeInstanceOf(Date);
      expect((await request()).status).toBe(403);
    } finally {
      await sql`DELETE FROM oauth.refresh_token_families WHERE id = ${familyId}::uuid`;
      await sql`DELETE FROM oauth.clients WHERE client_id = ${clientId}`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});

withDatabase("Core terminal approval issuance boundary", () => {
  const saved = new Map<string, unknown>();
  const configKeys = ["app.url", "user.app_approval.enabled", "user.app_approval.origin"];
  beforeAll(async () => {
    const { migrate } = await import("../migrate/core/app-approval");
    await migrate();
    for (const key of configKeys) saved.set(key, await settings.get(key));
    await settings.set("app.url", "https://cloud.example.test");
    await settings.set("user.app_approval.enabled", true);
    await settings.set("user.app_approval.origin", "https://terminal-login.example.test");
  });
  afterAll(async () => {
    for (const key of configKeys) await settings.set(key, saved.get(key));
  });

  test("issuance waits for the device before locking the login, avoiding a concurrent decide deadlock", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const userId = crypto.randomUUID(),
      deviceId = crypto.randomUUID(),
      authorizationId = crypto.randomUUID(),
      otherAuthorizationId = crypto.randomUUID(),
      loginId = crypto.randomUUID(),
      nonce = crypto.randomUUID(),
      clientId = `issuance-lock-order-${crypto.randomUUID()}`;
    let issuancePid: number | undefined;
    let issuance: Promise<Response> | undefined;
    const routes = createIdentityOAuthIssuanceRoutes({
      authenticate: () => true,
      withActiveSigner: async (_purpose, callback) =>
        sql.begin(async (db) => {
          await db`SET LOCAL statement_timeout='5s'`;
          const [backend] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          issuancePid = backend!.pid;
          return callback(
            {
              kid: crypto.randomUUID(),
              key: privateKey,
              signUntil: new Date(Date.now() + 60_000),
              issuer: "https://cloud.example.test",
            },
            db,
          );
        }),
      issuer: async () => "https://cloud.example.test",
    });
    try {
      await sql`INSERT INTO auth.users(id,uid,provider,profile)
        VALUES (${userId}::uuid,${`terminal-lock-order-${userId}`},'local','user')`;
      await sql`INSERT INTO oauth.clients(name,client_id,redirect_uris,scopes,audiences,allowed_profiles,access_mode,registration_kind,is_public,allow_device_grant)
        VALUES ('Issuance lock order',${clientId},'{}',ARRAY['openid','profile'],ARRAY['cloud'],ARRAY['user'],'profiles','managed',true,true)`;
      await sql`INSERT INTO oauth.device_authorizations(id,device_code_hash,user_code_hash,client_id,scopes,audiences,status,user_id,expires_at,authority_nonce,auth_epoch)
        VALUES (${authorizationId}::uuid,${authorizationId},${authorizationId},${clientId},ARRAY['openid','profile'],ARRAY['cloud'],
          'consumed',${userId}::uuid,now()+interval '10 minutes',${nonce}::uuid,0)`;
      await sql`INSERT INTO oauth.device_authorizations(id,device_code_hash,user_code_hash,client_id,scopes,audiences,expires_at)
        VALUES (${otherAuthorizationId}::uuid,${otherAuthorizationId},${otherAuthorizationId},${clientId},ARRAY['openid'],ARRAY['cloud'],
          now()+interval '10 minutes')`;
      await sql`UPDATE oauth.device_authorizations SET login_lifetime_seconds=3600 WHERE id=${authorizationId}::uuid`;
      await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted)
        VALUES (${deviceId}::uuid,'https://cloud.example.test',${userId}::uuid,'Phone','{}',false)`;
      await sql`INSERT INTO auth.app_logins(id,issuer,user_id,auth_epoch,category,browser_hash,challenge,comparison,state,approved_by,expires_at,
        kind,device_authorization_id,client_id,scopes,lifetime_seconds)
        SELECT ${loginId}::uuid,'https://cloud.example.test',u.id,u.auth_epoch,'login','unusable','unusable','000123','approved',${deviceId}::uuid,
          now()+interval '5 minutes','terminal',${authorizationId}::uuid,${clientId},ARRAY['openid','profile'],3600
        FROM auth.users u WHERE u.id=${userId}::uuid`;

      // Transaction A models a signed decide: device first, then login.
      await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout='3s'`;
        const [locker] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx`SELECT id FROM auth.app_devices WHERE id=${deviceId}::uuid FOR UPDATE`;
        issuance = Promise.resolve(
          routes.request("/oauth/token", {
            method: "POST",
            headers: { authorization: "Bearer broker", "content-type": "application/json" },
            body: JSON.stringify({
              tokens: [
                { kind: "user_access", grant: { kind: "device_code", deviceAuthorizationId: authorizationId, nonce }, expiresIn: 3600 },
              ],
            }),
          }),
        );
        let blocked = false;
        const deadline = performance.now() + 3000;
        while (performance.now() < deadline) {
          if (issuancePid !== undefined) {
            const [waiting] = await tx<{ blocked: boolean }[]>`
              SELECT ${locker!.pid}=ANY(pg_blocking_pids(${issuancePid})) AS blocked`;
            if (waiting?.blocked) {
              blocked = true;
              break;
            }
          }
          await Bun.sleep(10);
        }
        expect(blocked).toBe(true);
        // The decision hook approves another grant of this user; its foreign key takes a key-share lock on the user.
        await tx`UPDATE oauth.device_authorizations SET status='approved',user_id=${userId}::uuid,decided_at=now()
          WHERE id=${otherAuthorizationId}::uuid`;
        // With the inverted order, issuance already holds this row and A deadlocks.
        const locked = await tx`SELECT id FROM auth.app_logins WHERE id=${loginId}::uuid FOR UPDATE`;
        expect(locked).toHaveLength(1);
      });
      const response = await issuance;
      expect(response?.status).toBe(200);
      expect(z.object({ tokens: z.array(z.string()).length(1) }).parse(await response!.json()).tokens).toHaveLength(1);
      const [login] = await sql`SELECT state FROM auth.app_logins WHERE id=${loginId}::uuid`;
      expect(login.state).toBe("consumed");
      const [grant] = await sql`SELECT authority_issued_at FROM oauth.device_authorizations WHERE id=${authorizationId}::uuid`;
      expect(grant.authority_issued_at).not.toBeNull();
    } finally {
      await issuance;
      await sql`DELETE FROM auth.app_logins WHERE id=${loginId}::uuid`;
      await sql`DELETE FROM oauth.clients WHERE client_id=${clientId}`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  }, 15_000);

  test.each([
    "happy",
    "browser",
    "revoked",
    "epoch",
    "login-epoch",
    "device-owner",
    "login-owner",
    "missing-device",
    "expired-ui",
    "disabled",
    "disabled-in-transaction",
    "issuer",
    "device-issuer",
  ] as const)("rechecks terminal approval authority before issuance: %s", async (scenario) => {
    const { privateKey } = await generateKeyPair("RS256");
    const routes = createIdentityOAuthIssuanceRoutes({
      authenticate: () => true,
      withActiveSigner: async (_purpose, callback) =>
        sql.begin(async (db) => {
          // Visible only to this transaction: the recheck must read settings on it, not on a second pool connection.
          if (scenario === "disabled-in-transaction") await db`DELETE FROM settings.entries WHERE key='user.app_approval.enabled'`;
          return callback(
            {
              kid: crypto.randomUUID(),
              key: privateKey,
              signUntil: new Date(Date.now() + 60_000),
              issuer: "https://cloud.example.test",
            },
            db,
          );
        }),
      issuer: async () => "https://cloud.example.test",
    });
    const userId = crypto.randomUUID(),
      otherUser = crypto.randomUUID(),
      clientId = `issuance-terminal-${crypto.randomUUID()}`;
    const deviceId = crypto.randomUUID(),
      authorizationId = crypto.randomUUID(),
      loginId = crypto.randomUUID(),
      nonce = crypto.randomUUID();
    try {
      for (const id of [userId, otherUser])
        await sql`INSERT INTO auth.users(id,uid,provider,profile)
          VALUES (${id}::uuid,${`terminal-issuance-${id}`},'local','user')`;
      await sql`INSERT INTO oauth.clients(name,client_id,redirect_uris,scopes,audiences,allowed_profiles,access_mode,registration_kind,is_public,allow_device_grant)
          VALUES ('Issuance test',${clientId},'{}',ARRAY['openid','profile'],ARRAY['cloud'],ARRAY['user'],'profiles','managed',true,true)`;
      await sql`INSERT INTO oauth.device_authorizations(id,device_code_hash,user_code_hash,client_id,scopes,audiences,status,user_id,expires_at,authority_nonce,auth_epoch)
          VALUES (${authorizationId}::uuid,${authorizationId},${authorizationId},${clientId},ARRAY['openid','profile'],ARRAY['cloud'],
            'consumed',${userId}::uuid,now()+interval '10 minutes',${nonce}::uuid,0)`;
      if (scenario !== "browser") {
        await sql`UPDATE oauth.device_authorizations SET login_lifetime_seconds=3600 WHERE id=${authorizationId}::uuid`;
        await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted)
            VALUES (${deviceId}::uuid,'https://cloud.example.test',${scenario === "device-owner" ? otherUser : userId}::uuid,'Phone','{}',false)`;
        await sql`INSERT INTO auth.app_logins(id,issuer,user_id,auth_epoch,category,browser_hash,challenge,comparison,state,approved_by,expires_at,
            kind,device_authorization_id,client_id,scopes,lifetime_seconds)
            SELECT ${loginId}::uuid,'https://cloud.example.test',u.id,u.auth_epoch,'login','unusable','unusable','000123','approved',${deviceId}::uuid,
              now()+interval '5 minutes','terminal',${authorizationId}::uuid,${clientId},ARRAY['openid','profile'],3600
            FROM auth.users u WHERE u.id=${scenario === "login-owner" ? otherUser : userId}::uuid`;
        if (scenario === "revoked") await sql`UPDATE auth.app_devices SET revoked_at=now() WHERE id=${deviceId}::uuid`;
        if (scenario === "epoch") await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${userId}::uuid`;
        if (scenario === "login-epoch") await sql`UPDATE auth.app_logins SET auth_epoch=auth_epoch-1 WHERE id=${loginId}::uuid`;
        if (scenario === "missing-device") await sql`DELETE FROM auth.app_devices WHERE id=${deviceId}::uuid`;
        if (scenario === "disabled") await settings.set("user.app_approval.enabled", false);
        if (scenario === "issuer") await settings.set("app.url", "https://other-cloud.example.test");
        if (scenario === "device-issuer")
          await sql`UPDATE auth.app_devices SET issuer='https://other-cloud.example.test' WHERE id=${deviceId}::uuid`;
        if (scenario === "expired-ui") {
          await sql`UPDATE auth.app_logins SET expires_at=now()-interval '1 second' WHERE id=${loginId}::uuid`;
          // Cleanup must retain the evidence needed by issuance after the sign-in UI closes.
          const { appApproval } = await import("@k2b/cloud/services");
          await appApproval.cleanup();
        }
      }
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [{ kind: "user_access", grant: { kind: "device_code", deviceAuthorizationId: authorizationId, nonce }, expiresIn: 3600 }],
        }),
      });
      const allowed = ["happy", "browser", "expired-ui"].includes(scenario);
      expect(response.status).toBe(allowed ? 200 : 403);
      const result = await response.json();
      if (allowed) expect(z.object({ tokens: z.array(z.string()).length(1) }).parse(result).tokens).toHaveLength(1);
      else expect(result).toEqual({ message: "Forbidden" });
      const [grant] = await sql`SELECT authority_issued_at FROM oauth.device_authorizations WHERE id=${authorizationId}::uuid`;
      expect(grant.authority_issued_at !== null).toBe(allowed);
      if (scenario !== "browser") {
        const [login] = await sql`SELECT state FROM auth.app_logins WHERE id=${loginId}::uuid`;
        expect(login.state).toBe(allowed ? "consumed" : "approved");
      }
    } finally {
      await settings.set("user.app_approval.enabled", true);
      await settings.set("app.url", "https://cloud.example.test");
      await sql`DELETE FROM oauth.clients WHERE client_id=${clientId}`;
      for (const id of [userId, otherUser]) await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    }
  });

  test.each([
    "changed",
    "current",
    "client",
    "scopes",
    "scopes-extra",
    "lifetime",
    "missing-lifetime",
    "user",
    "pending",
    "denied",
    "consumed",
    "family-lifetime",
  ] as const)("terminal offline access checks every binding before activating a family: %s", (epoch) =>
    withFrozenTime(async () => {
      const f = await epochAuthorityFixture();
      const deviceId = crypto.randomUUID(),
        authorizationId = crypto.randomUUID(),
        loginId = crypto.randomUUID(),
        nonce = crypto.randomUUID();
      try {
        await sql`UPDATE oauth.clients SET is_public=true,allow_device_grant=true WHERE client_id=${f.clientId}`;
        await sql`INSERT INTO oauth.device_authorizations(id,device_code_hash,user_code_hash,client_id,scopes,audiences,status,user_id,expires_at,authority_nonce,auth_epoch)
          SELECT ${authorizationId}::uuid,${authorizationId},${authorizationId},${f.clientId},ARRAY['openid','offline_access'],ARRAY['cloud',${f.clientId}],
            'consumed',u.id,now()+interval '10 minutes',${nonce}::uuid,u.auth_epoch FROM auth.users u WHERE u.id=${f.userId}::uuid`;
        await sql`UPDATE oauth.device_authorizations SET login_lifetime_seconds=3600 WHERE id=${authorizationId}::uuid`;
        await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted)
          VALUES (${deviceId}::uuid,'https://cloud.example.test',${f.userId}::uuid,'Phone','{}',false)`;
        await sql`INSERT INTO auth.app_logins(id,issuer,user_id,auth_epoch,category,browser_hash,challenge,comparison,state,approved_by,expires_at,
          kind,device_authorization_id,client_id,scopes,lifetime_seconds)
          SELECT ${loginId}::uuid,'https://cloud.example.test',u.id,u.auth_epoch,'login','unusable','unusable','000123','approved',${deviceId}::uuid,
            now()+interval '5 minutes','terminal',${authorizationId}::uuid,${f.clientId},ARRAY['openid','offline_access'],3600
          FROM auth.users u WHERE u.id=${f.userId}::uuid`;
        const family = await f.reserve();
        // Existing browser evidence does not override a mismatched terminal approval.
        if (epoch !== "current" && epoch !== "changed")
          await sql`UPDATE oauth.device_authorizations SET confirmed_at=now() WHERE id=${authorizationId}::uuid`;
        if (epoch === "client") await sql`UPDATE auth.app_logins SET client_id=${f.otherClientId} WHERE id=${loginId}::uuid`;
        if (epoch === "scopes") await sql`UPDATE auth.app_logins SET scopes=ARRAY['openid'] WHERE id=${loginId}::uuid`;
        if (epoch === "scopes-extra")
          await sql`UPDATE auth.app_logins SET scopes=ARRAY['openid','offline_access','profile'] WHERE id=${loginId}::uuid`;
        if (epoch === "missing-lifetime")
          await sql`UPDATE oauth.device_authorizations SET login_lifetime_seconds=NULL WHERE id=${authorizationId}::uuid`;
        if (epoch === "lifetime") await sql`UPDATE auth.app_logins SET lifetime_seconds=1800 WHERE id=${loginId}::uuid`;
        if (epoch === "user") await sql`UPDATE auth.app_logins SET user_id=${f.otherUserId}::uuid WHERE id=${loginId}::uuid`;
        if (["pending", "denied", "consumed"].includes(epoch))
          await sql`UPDATE auth.app_logins SET state=${epoch} WHERE id=${loginId}::uuid`;
        if (epoch === "family-lifetime")
          await sql`UPDATE oauth.refresh_token_families SET expires_at=now()+interval '2 hours' WHERE id=${family.id}::uuid`;
        if (epoch === "changed") await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${f.userId}::uuid`;

        const response = await f.issue({ kind: "device_code", deviceAuthorizationId: authorizationId, nonce, familyId: family.id });
        const allowed = epoch === "current";
        expect(response.status).toBe(allowed ? 200 : 403);
        const result = await response.json();
        if (allowed) {
          const { tokens } = z.object({ tokens: z.array(z.string()).length(1) }).parse(result);
          const [user] = await sql<{ auth_epoch: string }[]>`SELECT auth_epoch::text FROM auth.users WHERE id=${f.userId}::uuid`;
          expect(decodeJwt(tokens[0]!).auth_epoch).toBe(Number(user!.auth_epoch));
          expect(Number(user!.auth_epoch)).toBe(f.authEpoch);
        } else expect(result).toEqual({ message: "Forbidden" });
        const [reserved] = await sql`SELECT status,notified_at FROM oauth.refresh_token_families WHERE id=${family.id}::uuid`;
        expect(reserved.status).toBe(allowed ? "active" : "reserved");
        // A Cloud Login approval is the notice; a refused family stays a reservation with nothing to tell.
        expect(reserved.notified_at).not.toBeNull();
        expect(f.notices).toHaveLength(0);
        const [login] = await sql`SELECT state FROM auth.app_logins WHERE id=${loginId}::uuid`;
        expect(login.state).toBe(allowed ? "consumed" : ["pending", "denied", "consumed"].includes(epoch) ? epoch : "approved");
        const [grant] = await sql`SELECT authority_issued_at FROM oauth.device_authorizations WHERE id=${authorizationId}::uuid`;
        if (allowed) expect(grant.authority_issued_at).toBeInstanceOf(Date);
        else expect(grant.authority_issued_at).toBeNull();
      } finally {
        await sql`DELETE FROM auth.app_logins WHERE id=${loginId}::uuid`;
        await f.cleanup();
      }
    }),
  );
});
