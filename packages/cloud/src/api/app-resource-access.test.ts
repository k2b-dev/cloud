import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import { bindResourceAppAccess, probeAuthority } from "../_internal/app-access-resources";
import { person } from "../_internal/define-app.test-fixture";
import { appAccess, compileAppAccess } from "../contracts/app-access";
import * as rateLimitMiddleware from "../server/middleware/rate-limit";
import * as invocationActor from "../services/identity/invocation-actor";
import * as invocationToken from "../services/identity/invocation-token";
import { createResourceAppAccessRoutes } from "./app-resource-access";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  setSystemTime();
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("resource probe accepts only Core's signed target/operation-bound invocation and returns no app content", async () => {
  setSystemTime(new Date("2026-10-28T12:00:00Z"));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const verify = invocationToken.verifyAppAccessProbe;
  spies.push(
    spyOn(invocationToken, "verifyAppAccessProbe").mockImplementation((token, expected) =>
      verify(token, expected, { issuer: "https://cloud.test", key: async () => publicKey }),
    ),
  );
  const resolve = spyOn(invocationActor, "resolveInvocationAuthority").mockResolvedValue({
    actor: { kind: "user", user: person },
    accessSubject: { type: "user", userId: person.id },
    credentialKind: "invocation",
    scopes: ["read"],
  });
  spies.push(resolve);
  let right = true;
  const declaration = appAccess.resources({ adapters: { workspace: { hasAnyRight: async () => right } } });
  const app = { id: "resource-probe", access: compileAppAccess(declaration) };
  const stop = bindResourceAppAccess(app.id, declaration);
  const router = createResourceAppAccessRoutes(app);
  const token = (overrides: Partial<Parameters<typeof invocationToken.signAppAccessProbe>[0]> = {}) =>
    invocationToken.signAppAccessProbe({
      appId: app.id,
      authority: {
        sub: person.id,
        principal_type: "user",
        access_subject_type: "user",
        access_subject_id: person.id,
        credential_kind: "session",
        scopes: [],
      },
      signer: { kid: "11111111-1111-4111-8111-111111111111", key: privateKey, signUntil: new Date("2100-01-01") },
      issuer: "https://cloud.test",
      ...overrides,
    });
  const probe = (bearer?: string) =>
    router.request("/check", { method: "POST", headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  try {
    expect((await probe()).status).toBe(401);
    expect((await probe(await token({ appId: "other" }))).status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    const signed = await token();
    for (const change of [
      { act: { sub: "app:other" } },
      { op: "search.query" },
      { unexpected: "claim" },
      { token_use: "invocation" },
      { parent_invocation_id: "33333333-3333-4333-8333-333333333333" },
      { access_subject_id: "33333333-3333-4333-8333-333333333333" },
      { credential_kind: "mandate", mandate_id: "33333333-3333-4333-8333-333333333333" },
    ]) {
      const invalid = await new SignJWT({ ...decodeJwt<import("jose").JWTPayload>(signed), ...change })
        .setProtectedHeader({ alg: "RS256", typ: "cloud-invocation+jwt", kid: "11111111-1111-4111-8111-111111111111" })
        .sign(privateKey);
      expect((await probe(invalid)).status).toBe(401);
    }
    const response = await probe(signed);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    right = false;
    expect((await probe(signed)).status).toBe(403);
    stop();
    expect((await probe(signed)).status).toBe(403);
    const rebind = bindResourceAppAccess(app.id, declaration);
    spies.push({ mockRestore: rebind });
    resolve.mockResolvedValue(null);
    expect((await probe(signed)).status).toBe(401);
  } finally {
    stop();
  }
});

test("Core evaluates a remote adapter with a scoped probe; another app sends credentials only to Core", async () => {
  setSystemTime(new Date("2026-10-28T12:00:00Z"));
  const { bindProcessApplicationId, clearProcessApplicationId } = await import("../_internal/process-identity");
  const { canUseApp } = await import("../services/app-access");
  const registry = await import("../_internal/registry");
  const coreTransport = await import("../services/identity/core-origin");
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const sign = invocationToken.signAppAccessProbe;
  const verify = invocationToken.verifyAppAccessProbe;
  spies.push(
    spyOn(invocationToken, "signAppAccessProbe").mockImplementation((params) =>
      sign({
        ...params,
        signer: { kid: "11111111-1111-4111-8111-111111111111", key: privateKey, signUntil: new Date("2100-01-01") },
        issuer: "https://cloud.test",
      }),
    ),
  );
  spies.push(
    spyOn(invocationToken, "verifyAppAccessProbe").mockImplementation((token, expected, options) =>
      verify(token, expected, { ...options, issuer: "https://cloud.test", key: async () => publicKey }),
    ),
  );
  const current = {
    actor: { kind: "user" as const, user: person, sessionKind: "app" as const },
    accessSubject: { type: "user" as const, userId: person.id },
    credentialKind: "session" as const,
    scopes: [],
  };
  spies.push(
    spyOn(invocationActor, "resolveInvocationAuthority").mockResolvedValue({
      ...current,
      actor: {
        ...current.actor,
        delegation: { kind: "invocation", callingAppId: "core", credentialKind: "session", invocationId: "fixture" },
      },
      credentialKind: "invocation",
    }),
  );
  const authMiddleware = await import("../server/middleware/auth");
  spies.push(
    spyOn(authMiddleware.auth.session, "authenticateRequest").mockImplementation(async (_c, token) => {
      if (token === "original-session")
        return {
          user: person,
          data: { userId: person.id, sid: "phone", authEpoch: 0, kind: "app", deviceId: "phone", expiresAt: "2026-10-29T12:00:00Z" },
        };
      if (token === "broader-session")
        return {
          user: { ...person, roles: ["admin"] },
          data: { userId: person.id, sid: "web", authEpoch: 0, kind: "web", expiresAt: "2026-10-29T12:00:00Z" },
        };
      return null;
    }),
  );
  let right = true;
  const declaration = appAccess.resources({ adapters: { workspace: { hasAnyRight: async () => right } } });
  const target = {
    id: "resource-remote",
    name: "Resources",
    icon: "ti ti-box",
    description: "Fixture",
    routes: [],
    baseUrl: "http://resource.test",
    access: compileAppAccess(declaration),
  };
  const registryRead = spyOn(registry, "getApp").mockResolvedValue(target);
  spies.push(registryRead);
  spies.push(spyOn(coreTransport, "coreOrigin").mockResolvedValue("http://core.test"));
  const ownerRoutes = createResourceAppAccessRoutes(target);
  spies.push(spyOn(rateLimitMiddleware, "rateLimit").mockReturnValue(async (_c, next) => next()));
  const coreRoutes = createResourceAppAccessRoutes({ id: "core", access: appAccess.signedIn() });
  const visited: string[] = [];
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const request = new Request(input, init);
          visited.push(new URL(request.url).hostname);
          if (new URL(request.url).hostname === "resource.test") {
            expect(request.headers.get("cookie")).toBeNull();
            expect(request.headers.get("authorization")).not.toBe("Bearer original-session");
            const stop = bindResourceAppAccess(target.id, declaration);
            try {
              return await ownerRoutes.fetch(new Request("http://resource.test/check", request));
            } finally {
              stop();
            }
          }
          expect(new URL(request.url).hostname).toBe("core.test");
          expect(request.headers.get("authorization")).toBe("Bearer original-session");
          expect(request.headers.get("cookie")).toBeNull();
          // Simulate the separate Core process for this hop.
          clearProcessApplicationId();
          bindProcessApplicationId("core");
          try {
            return await coreRoutes.fetch(new Request(`http://core.test/apps/${target.id}`, request));
          } finally {
            clearProcessApplicationId();
            bindProcessApplicationId("other");
          }
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    ),
  );
  try {
    clearProcessApplicationId();
    bindProcessApplicationId("core");
    expect(await canUseApp(current, target)).toBe(true);
    right = false;
    expect(await canUseApp(current, target)).toBe(false);
    clearProcessApplicationId();
    bindProcessApplicationId("other");
    right = true;
    const { Hono } = await import("hono");
    const source = new Hono<import("../server/middleware/auth").AuthContext>()
      .use(authMiddleware.auth.requireRole("authenticated"))
      .get("/pwa/", async (c) => c.json(await canUseApp(authMiddleware.auth.getAuthority(c), target)));
    registryRead.mockClear();
    const response = await source.request("http://other.test/pwa/", {
      headers: { authorization: "Bearer wrong", cookie: "session_token=broader-session; pwa_session=original-session" },
    });
    expect(await response.json()).toBe(true);
    expect(registryRead).toHaveBeenCalledTimes(1);
    expect(visited).toEqual(["resource.test", "resource.test", "core.test", "resource.test"]);
    spyOn(registry, "getApp").mockResolvedValueOnce(null);
    expect(
      (await coreRoutes.request("/apps/unknown", { method: "POST", headers: { authorization: "Bearer original-session" } })).status,
    ).toBe(404);
    spyOn(rateLimitMiddleware, "rateLimit").mockReturnValue(async (c) => c.body(null, 429));
    const throttledCore = createResourceAppAccessRoutes({ id: "core", access: appAccess.signedIn() });
    const before = visited.length;
    expect(
      (await throttledCore.request(`/apps/${target.id}`, { method: "POST", headers: { authorization: "Bearer original-session" } })).status,
    ).toBe(429);
    expect(visited).toHaveLength(before);
  } finally {
    clearProcessApplicationId();
  }
});

test("Core requires an authenticated source and never accepts invocation/probe credentials for relay", async () => {
  const routes = createResourceAppAccessRoutes({ id: "core", access: appAccess.signedIn() });
  const response = await routes.request("/apps/unknown", { method: "POST" });
  expect(response.status).toBe(401);
});

test("probe authority preserves credential ceilings, including subject-only and existing mandates", async () => {
  setSystemTime(new Date("2026-10-28T12:00:00Z"));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const user = { kind: "user" as const, user: person };
  const subject = { type: "user" as const, userId: person.id };
  const serviceAccount = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Fixture",
    kind: "standalone" as const,
    appId: null,
    resourceType: null,
    resourceId: null,
    delegatedUserId: null,
    createdAt: "2026-01-01T00:00:00Z",
    status: "active" as const,
    createdBy: null,
  };
  const base = { actor: user, accessSubject: subject, credentialKind: "session" as const, scopes: [] };
  const mandates = [
    { kind: "invocation" as const, callingAppId: "core", credentialKind: "mandate" as const, invocationId: "fixture" },
    {
      kind: "invocation" as const,
      callingAppId: "core",
      credentialKind: "mandate" as const,
      invocationId: "fixture",
      mandateId: "33333333-3333-4333-8333-333333333333",
      mandateRevision: 1,
      workloadType: "job",
      workloadId: "fixture",
    },
  ];
  const cases: import("../server/middleware/auth").RequestAuthority[] = [
    base,
    { ...base, actor: { ...user, sessionKind: "app" } },
    { ...base, credentialKind: "oauth", scopes: ["read"] },
    {
      ...base,
      actor: { kind: "service_account", serviceAccount, credentialId: "key", delegatedUser: null, scopes: ["read"] },
      accessSubject: { type: "service_account", serviceAccountId: serviceAccount.id },
      credentialKind: "api_key",
      scopes: ["read"],
    },
    {
      ...base,
      actor: {
        kind: "service_account",
        serviceAccount: { ...serviceAccount, kind: "user_delegated", delegatedUserId: person.id },
        credentialId: "key",
        delegatedUser: person,
        scopes: [],
      },
      credentialKind: "api_key",
    },
    {
      ...base,
      actor: {
        kind: "service_account",
        serviceAccount: { ...serviceAccount, kind: "resource_bound", appId: "resources", resourceType: "workspace", resourceId: "one" },
        credentialId: "key",
        delegatedUser: null,
        scopes: ["read"],
      },
      accessSubject: { type: "service_account", serviceAccountId: serviceAccount.id },
      credentialKind: "api_key",
      scopes: ["read"],
    },
    ...mandates.map((delegation) => ({ ...base, actor: { ...user, delegation }, credentialKind: "invocation" as const })),
    {
      ...base,
      actor: { ...user, delegation: { kind: "invocation", callingAppId: "other", credentialKind: "oauth", invocationId: "nested" } },
      credentialKind: "invocation",
      scopes: ["read"],
    },
  ];
  const routes = createResourceAppAccessRoutes({ id: "core", access: appAccess.signedIn() });
  for (const authority of cases) {
    const expected = probeAuthority(authority);
    const signed = await invocationToken.signAppAccessProbe({
      appId: "resources",
      authority: expected,
      issuer: "https://cloud.test",
      signer: { kid: "11111111-1111-4111-8111-111111111111", key: privateKey, signUntil: new Date("2100-01-01") },
    });
    const claims = await invocationToken.verifyAppAccessProbe(signed, "resources", {
      issuer: "https://cloud.test",
      key: async () => publicKey,
    });
    expect(claims).toMatchObject(expected);
    expect(
      await invocationToken.verifyInvocationToken(
        signed,
        { targetAppId: "resources", operation: "app-access.check", schemaHash: null },
        { issuer: "https://cloud.test", key: async () => publicKey },
      ),
    ).toBeNull();
    expect((await routes.request("/apps/resources", { method: "POST", headers: { authorization: `Bearer ${signed}` } })).status).toBe(401);
  }
});
