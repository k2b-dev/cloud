import assert from "node:assert/strict";
import { sql } from "bun";
import { decodeJwt, decodeProtectedHeader, type JWTPayload } from "jose";
import { z } from "zod";
import * as client from "./reference-client";

assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/cloud_oauth_verify_[a-z0-9_]+$/);
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const checks: string[] = [];
const check = (name: string) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const start = async (role: "core" | "oauth", version: "baseline" | "current", workload?: string) => {
  const directory = version === "baseline" ? "/baseline/packages/oauth" : "/workspace/packages/oauth";
  const ready = Promise.withResolvers<void>();
  const revoked = Promise.withResolvers<void>();
  const child = Bun.spawn(["bun", "src/verification/server.ts"], {
    cwd: directory,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      APP_ID: role,
      OAUTH_VERIFY_VERSION: version,
      CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: role === "core" && version === "current" ? "43".repeat(32) : "",
      CLOUD_CORE_INTERNAL_ORIGIN: "http://127.0.0.1:4301",
      CLOUD_IDENTITY_JWKS_ORIGIN: "http://127.0.0.1:4301",
      CLOUD_OAUTH_JWKS_ORIGIN: client.issuer,
      CLOUD_APP_CREDENTIAL: workload ?? "",
    },
    ipc(message) {
      if (message === "ready") ready.resolve();
      if (message === "revoked") revoked.resolve();
    },
  });
  children.push(child);
  void child.exited.then((code) => ready.reject(new Error(`${role}/${version} exited before readiness (${code})`)));
  const timer = setTimeout(() => ready.reject(new Error(`${role}/${version} readiness timeout`)), 60_000);
  try {
    await ready.promise;
  } finally {
    clearTimeout(timer);
  }
  return {
    child,
    revoke: async () => {
      child.send("revoke-browser-sessions");
      const timeout = setTimeout(() => revoked.reject(new Error("Session revocation timeout")), 15_000);
      try {
        await revoked.promise;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
};
const stop = async (child: ReturnType<typeof Bun.spawn>) => {
  if (child.exitCode !== null) return;
  child.send("stop");
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    assert.equal(await child.exited, 0, "Fixture process must shut down cleanly");
  } finally {
    clearTimeout(timer);
  }
};
// Routing fixture only: actual public handlers run in separate Core/OAuth
// processes. Gateway discovery/deployment is not part of this protocol proof.
const gateway = Bun.serve({
  hostname: "127.0.0.1",
  port: 4300,
  fetch(request) {
    const url = new URL(request.url);
    url.port =
      url.pathname.startsWith("/api/auth/") ||
      url.pathname.startsWith("/api/admin/identity/") ||
      url.pathname.startsWith("/.well-known/cloud-")
        ? "4301"
        : "4302";
    return fetch(new Request(url, request), { redirect: "manual" });
  },
});

const stableClaims = (claims: JWTPayload) => {
  const { iat, exp, jti, nonce, ...stable } = claims;
  assert.equal(typeof iat, "number");
  assert.equal(typeof exp, "number");
  if (claims.token_use === "access") assert.equal(typeof jti, "string");
  return { fields: Object.keys(claims).sort(), values: stable };
};
const discovery = async () => {
  const configuration = await client.json(await client.request("/.well-known/openid-configuration"));
  assert.deepEqual(await client.json(await client.request("/.well-known/oauth-authorization-server")), configuration);
  return configuration;
};
const workloadCredential = async (cookie: string) => {
  const response = await client.request("/api/admin/identity/workloads/oauth/credentials", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Reference OAuth authority", scopes: ["identity:oauth-issue"] }),
  });
  return z.object({ token: z.string() }).parse(await client.json(response, 201)).token;
};
const actor = async (token: string, status = 200) =>
  client.json(
    await client.request("/_verify/actor", {
      headers: { authorization: `Bearer ${token}` },
    }),
    status,
  );
const exercise = async (
  clients: { public: client.Client; confidential: client.Client; service: client.Client; dynamic: client.Client },
  cookie: string,
  userId: string,
) => {
  const snapshot: Record<string, unknown> = { discovery: await discovery() };
  for (const [name, registration] of [
    ["public", clients.public],
    ["confidential", clients.confidential],
  ] as const) {
    const grant = await client.authorize(registration, cookie, { pkce: name === "public", groups: true });
    const issued = await client.tokens(await client.exchange(registration, grant, name === "confidential"));
    assert(issued.id_token && issued.refresh_token);
    const access = await client.verify(issued.access_token, "cloud");
    const id = await client.verify(issued.id_token, registration.clientId);
    assert.equal(access.sub, userId);
    assert.equal(access.token_use, "access");
    assert.equal(access.principal_type, "user");
    assert.equal(id.nonce, grant.nonce);
    assert.deepEqual(id.groups, ["Reference child", "Reference parent"]);
    assert.equal(typeof access.jti, "string");
    snapshot[name] = {
      access: stableClaims(access),
      id: stableClaims(id),
      fields: Object.keys(issued).sort(),
      userinfo: await client.userinfo(issued.access_token),
      actor: await actor(issued.access_token),
    };
    await client.error(await client.exchange(registration, grant), "invalid_grant");
    const rotated = await client.tokens(await client.refresh(registration, issued.refresh_token, "openid read"));
    assert(rotated.refresh_token && rotated.refresh_token !== issued.refresh_token);
    assert.equal(rotated.scope, "openid read");
    const rotatedAgain = await client.tokens(await client.refresh(registration, rotated.refresh_token));
    assert.equal(rotatedAgain.scope, "openid read");
    await client.error(await client.refresh(registration, issued.refresh_token), "invalid_grant");
    assert(rotatedAgain.refresh_token);
    await client.error(await client.refresh(registration, rotatedAgain.refresh_token), "invalid_grant");
    check(
      `${name}: code, ${name === "public" ? "PKCE" : "Basic"}, signatures, nested-group claims, UserInfo, refresh narrowing and replay`,
    );
  }
  const service = await client.tokens(await client.tokenRequest(clients.service, { grant_type: "client_credentials", scope: "read" }));
  const serviceClaims = await client.verify(service.access_token, "cloud");
  assert.equal(serviceClaims.principal_type, "service_account");
  assert.equal(serviceClaims.resource_id, "reference");
  snapshot.service = { claims: stableClaims(serviceClaims), fields: Object.keys(service).sort(), actor: await actor(service.access_token) };
  snapshot.invalidSecret = await client.error(
    await client.tokenRequest(
      { ...clients.service, clientSecret: "incorrect" },
      {
        grant_type: "client_credentials",
      },
    ),
    "invalid_client",
    401,
  );
  snapshot.invalidScope = await client.error(
    await client.tokenRequest(clients.service, { grant_type: "client_credentials", scope: "admin" }),
    "invalid_scope",
  );
  snapshot.invalidTarget = await client.error(
    await client.tokenRequest(clients.service, {
      grant_type: "client_credentials",
      resource: "https://unregistered.example.test/api",
    }),
    "invalid_target",
  );
  const bound = await client.authorize(clients.public, cookie, { resource: client.resource });
  const boundTokens = await client.tokens(await client.exchange(clients.public, bound));
  const boundClaims = await client.verify(boundTokens.access_token, client.resource);
  assert.deepEqual(boundClaims.aud, [client.resource]);
  assert(boundTokens.refresh_token);
  await client.error(await client.refresh(clients.public, boundTokens.refresh_token), "invalid_grant");
  const boundRefresh = await client.tokens(await client.refresh(clients.public, boundTokens.refresh_token, undefined, client.resource));
  assert(boundRefresh.refresh_token);
  const revoked = await client.request("/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: boundRefresh.refresh_token, client_id: clients.public.clientId }),
  });
  assert.equal(revoked.status, 200);
  await client.error(await client.refresh(clients.public, boundRefresh.refresh_token, undefined, client.resource), "invalid_grant");
  check("client credentials (form), scope/resource errors, resource-bound refresh and revocation");
  const dynamicGrant = await client.authorize(clients.dynamic, cookie, { resource: client.resource });
  const dynamic = await client.tokens(await client.exchange(clients.dynamic, dynamicGrant));
  assert(dynamic.id_token && dynamic.refresh_token);
  const dynamicClaims = await client.verify(dynamic.access_token, client.resource);
  const dynamicId = await client.verify(dynamic.id_token, clients.dynamic.clientId);
  assert.equal(dynamicId.nonce, dynamicGrant.nonce);
  assert.deepEqual(dynamicClaims.aud, [client.resource]);
  snapshot.dynamic = { access: stableClaims(dynamicClaims), id: stableClaims(dynamicId), fields: Object.keys(dynamic).sort() };
  assert.equal((await client.request("/oauth/userinfo", { headers: { authorization: `Bearer ${dynamic.access_token}` } })).status, 401);
  await actor(dynamic.access_token, 401);
  await client.tokens(await client.refresh(clients.dynamic, dynamic.refresh_token, undefined, client.resource));
  // Negative PKCE must be rejected, not merely accepted in the happy path.
  const wrongVerifier = await client.authorize(clients.public, cookie);
  await client.error(await client.exchange(clients.public, { ...wrongVerifier, verifier: "x".repeat(43) }), "invalid_grant");
  const noPkce = await client.request(
    `/oauth/authorize?${new URLSearchParams({ client_id: clients.public.clientId, redirect_uri: client.callback, response_type: "code" })}`,
    { headers: { cookie } },
  );
  assert.equal(noPkce.status, 302);
  assert.equal(new URL(noPkce.headers.get("location")!, client.issuer).searchParams.get("error"), "invalid_request");
  check("dynamic registration/consent/resource refresh; wrong or missing PKCE rejected; resource token cannot become a Cloud session");
  return snapshot;
};

try {
  const fresh = process.env.OAUTH_VERIFY_FRESH === "1";
  let core = await start("core", fresh ? "current" : "baseline");
  let login = await client.login();
  let oauth = await start("oauth", fresh ? "current" : "baseline", fresh ? await workloadCredential(login.cookie) : undefined);
  const [account] = await sql<
    { id: string }[]
  >`SELECT id FROM auth.service_accounts WHERE app_id = 'oauth-test' AND resource_id = 'reference'`;
  assert(account);
  const clients = {
    public: await client.createClient(login.cookie, "Public reference", true),
    confidential: await client.createClient(login.cookie, "Confidential reference", false),
    service: await client.createClient(login.cookie, "Service reference", false, account.id),
    dynamic: await client.register(),
  };
  const before = await exercise(clients, login.cookie, login.userId);
  if (!fresh) {
    assert(login.token.includes(":"), "Baseline must create an opaque browser session");
    const pendingCode = await client.authorize(clients.public, login.cookie);
    const pendingResourceCode = await client.authorize(clients.public, login.cookie, { resource: client.resource });
    const previous = await client.tokens(
      await client.exchange(clients.confidential, await client.authorize(clients.confidential, login.cookie)),
    );
    assert(previous.refresh_token);
    const oldCookie = login.cookie;
    const oldToken = login.token;
    const legacyKid = decodeProtectedHeader(previous.access_token).kid;
    await stop(oauth.child);
    await stop(core.child);
    core = await start("core", "current");
    login = await client.login();
    oauth = await start("oauth", "current", await workloadCredential(login.cookie));
    assert.equal(decodeProtectedHeader(login.token).typ, "cloud-session+jwt");
    const [removed] = await sql<{ keys: string | null; state: string | null }[]>`
      SELECT to_regclass('oauth.keys')::text AS keys, to_regclass('oauth.issuance_state')::text AS state
    `;
    assert.deepEqual(removed, { keys: null, state: null });
    check("old replicas stopped; real schema upgrade; Core-only readiness; obsolete signing tables removed");
    // The hard cut rejects opaque browser sessions immediately, without Redis cleanup.
    await actor(oldToken, 401);
    await core.revoke();
    await actor(oldToken, 401);
    await actor(login.token, 401);
    const authorization = await client.request(
      `/oauth/authorize?${new URLSearchParams({
        client_id: clients.confidential.clientId,
        response_type: "code",
        redirect_uri: client.callback,
      })}`,
      { headers: { cookie: oldCookie } },
    );
    assert.equal(authorization.status, 302);
    assert.equal(new URL(authorization.headers.get("location")!, client.issuer).pathname, "/auth/login");
    login = await client.login();
    assert.equal(decodeJwt(login.token).token_use, "session");
    await actor(login.token);
    // External clients may still have a warm pre-upgrade JWKS cache.
    await client.reloadJwks();
    await assert.rejects(client.verify(previous.access_token, "cloud"));
    assert(previous.id_token);
    await assert.rejects(client.verify(previous.id_token, clients.confidential.clientId));
    assert.equal((await client.request("/oauth/userinfo", { headers: { authorization: `Bearer ${previous.access_token}` } })).status, 401);
    await actor(previous.access_token, 401);
    const upgradedRefresh = await client.tokens(await client.refresh(clients.confidential, previous.refresh_token));
    assert(decodeProtectedHeader(upgradedRefresh.access_token).kid !== legacyKid);
    await client.verify(upgradedRefresh.access_token, "cloud");
    await client.verify((await client.tokens(await client.exchange(clients.public, pendingCode))).access_token, "cloud");
    await client.verify((await client.tokens(await client.exchange(clients.public, pendingResourceCode))).access_token, client.resource);
    check("old browser and OAuth JWTs rejected; existing clients, refresh families, codes and resource bindings survive");
    assert.deepEqual(await exercise(clients, login.cookie, login.userId), before, "Public contract differs across upgrade");
    check("pre/post discovery, token response fields, stable JWT claims, UserInfo, actors and errors match exactly");
    const jwksResponse = await client.request("/.well-known/jwks.json");
    const etag = jwksResponse.headers.get("etag");
    assert(etag);
    assert.equal((await client.request("/.well-known/jwks.json", { headers: { "if-none-match": etag } })).status, 304);
    check("additive JWKS conditional GET (ETag/304)");
  } else {
    check("fresh current schema with Core-only issuance");
    const regression = Bun.spawn(
      [
        "bun",
        "test",
        "packages/oauth/src/contracts.test.ts",
        "packages/oauth/src/service/token-authority.test.ts",
        "packages/cloud/src/services/identity/session-token.test.ts",
        "packages/cloud/src/services/session/session.integration.test.ts",
        "packages/cloud/src/services/session/user.integration.test.ts",
        "packages/core/src/api/identity-oauth-issuance.test.ts",
      ],
      {
        cwd: "/workspace",
        env: {
          ...process.env,
          APP_ID: "core",
          CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: "43".repeat(32),
          CLOUD_IDENTITY_JWKS_ORIGIN: "http://127.0.0.1:4301",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(regression.stdout).text(),
      new Response(regression.stderr).text(),
      regression.exited,
    ]);
    console.log(stdout + stderr);
    assert.equal(code, 0, "Isolated regression suite failed");
    assert(!/\b[1-9][0-9]* skip\b/.test(stdout + stderr), "Database regressions must not silently skip");
    await Bun.write("/results/regressions.txt", stdout + stderr);
    check("existing contract, session-JWT and Core-authority regressions pass on the disposable database without skips");
  }
  await Bun.write(`/results/${fresh ? "fresh" : "upgrade"}.json`, JSON.stringify({ status: "passed", checks, contract: before }, null, 2));
} finally {
  for (const child of [...children].reverse()) await stop(child);
  await gateway.stop(true);
  await sql.close();
}
