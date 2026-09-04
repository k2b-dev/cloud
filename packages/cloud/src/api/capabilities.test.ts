import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { generateKeyPair } from "jose";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../contracts/registry";
import { auth, type RequestAuthority } from "../server";
import type { signInvocationToken } from "../services/identity/invocation-token";
import type { withActiveIdentitySigner } from "../services/identity/key-ring";
import {
  createCapabilityRoutes as buildCapabilityRoutes,
  type CapabilityRouteDependencies,
  loadCapabilityCatalogPage,
  dispatchCapability as performDispatch,
} from "./capabilities";

const compiled = compileCapabilities(
  "demo",
  defineCapabilities({
    protocolVersion: 1,
    types: { item: { title: "Item", description: "One demo item." } },
    queries: {
      get: {
        title: "Get item",
        description: "Return one demo item.",
        input: z.object({ id: z.string().describe("Stable item id.") }).strict(),
        data: z.object({ id: z.string() }).strict(),
        openWorld: false,
        run: async ({ id }) => ok({ data: { id } }),
      },
    },
    actions: {
      rename: {
        title: "Rename item",
        description: "Rename one demo item.",
        input: z.object({ id: z.string().describe("Stable item id."), name: z.string().describe("New item name.") }).strict(),
        data: z.object({ id: z.string(), name: z.string() }).strict(),
        destructive: true,
        openWorld: false,
        idempotency: "none",
        approval: "rememberable",
        review: async ({ id, name }) => ok({ message: `Rename ${id} to ${name}.`, approvalScope: `item:${id}` }),
        run: async ({ id, name }) => ok({ data: { id, name } }),
      },
    },
  }),
);

const entry = (id = "demo"): CapabilityRegistryEntry => ({
  appId: id,
  appName: id,
  appIcon: "ti ti-box",
  appDescription: `${id} app`,
  endpoint: `http://${id}:3000/api/_internal/capabilities/v1`,
  manifest: { ...structuredClone(compiled.manifest), appId: id },
});

const summary = (capability: CapabilityRegistryEntry): AppRegistryEntry => ({
  id: capability.appId,
  name: capability.appName,
  icon: capability.appIcon,
  description: `${capability.appName} app`,
  baseUrl: `http://${capability.appId}:3000`,
  routes: [],
  capabilities: {
    protocolVersion: capability.manifest.protocolVersion,
    manifestHash: capability.manifest.manifestHash,
  },
});

const authenticate: NonNullable<CapabilityRouteDependencies["authenticate"]> = async (c, next) => {
  c.set("actor", resourceAuthority.actor);
  c.set("accessSubject", resourceAuthority.accessSubject);
  c.set("credentialKind", resourceAuthority.credentialKind);
  c.set("credentialScopes", resourceAuthority.scopes);
  return next();
};

let signerKey: CryptoKey | undefined;
const withActiveSigner: typeof withActiveIdentitySigner = async (_purpose, callback) => {
  signerKey ??= (await generateKeyPair("RS256")).privateKey;
  return callback(
    {
      kid: "33333333-3333-4333-8333-333333333333",
      key: signerKey,
      signUntil: new Date(Date.now() + 60_000),
      issuer: "https://cloud.example.test",
    },
    sql,
  );
};

const resourceAuthority: RequestAuthority = {
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Caller",
      kind: "resource_bound",
      status: "active",
      delegatedUserId: null,
      appId: "core",
      resourceType: "cloud.app",
      resourceId: "core",
      createdBy: null,
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    delegatedUser: null,
    scopes: ["read"],
    credentialId: "22222222-2222-4222-8222-222222222222",
  },
  accessSubject: { type: "service_account", serviceAccountId: "11111111-1111-4111-8111-111111111111" },
  credentialKind: "api_key",
  scopes: ["read"],
};

const credentialAuthenticate: NonNullable<CapabilityRouteDependencies["authenticate"]> = async (c, next) => {
  c.set("actor", resourceAuthority.actor);
  c.set("accessSubject", resourceAuthority.accessSubject);
  c.set("credentialKind", resourceAuthority.credentialKind);
  c.set("credentialScopes", resourceAuthority.scopes);
  const token = auth.session.getToken(c);
  if (token === "session-token") return next();
  if (token === "read-token") {
    c.set("oauthScopes", ["read"]);
    return next();
  }
  if (token === "write-token") {
    c.set("oauthScopes", ["write"]);
    return next();
  }
  if (token === "admin-token") {
    c.set("oauthScopes", ["admin"]);
    return next();
  }
  return c.json({ message: "Authentication required" }, 401);
};

const createCapabilityRoutes = (dependencies: CapabilityRouteDependencies = {}) =>
  buildCapabilityRoutes({ withActiveSigner, ...dependencies });
const dispatchCapability = (params: Parameters<typeof performDispatch>[0]) =>
  performDispatch({ authority: resourceAuthority, ...params, dependencies: { withActiveSigner, ...params.dependencies } });

describe("capability API", () => {
  test("paginates the live catalog deterministically", async () => {
    const apps = [entry("zeta"), entry("alpha"), entry("middle")];
    const byId = new Map(apps.map((app) => [app.appId, app]));
    const routes = createCapabilityRoutes({
      listApps: async () => apps.map(summary),
      getCapability: async (appId) => byId.get(appId) ?? null,
      authenticate,
    });

    const first = await routes.request("/capabilities/v1/catalog?limit=2");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      apps: [{ appId: "alpha" }, { appId: "middle" }],
      page: { hasMore: true, nextCursor: "middle" },
    });

    const second = await routes.request("/capabilities/v1/catalog?limit=2&cursor=middle");
    expect(await second.json()).toMatchObject({ apps: [{ appId: "zeta" }], page: { hasMore: false } });
  });

  test("projects localized app presentation into the capability catalog", async () => {
    const capability = entry();
    const app = {
      ...summary(capability),
      presentation: { baseLocale: "en", translations: { de: { name: "Demo-App", description: "Deutsche Beschreibung" } } },
    };
    const catalog = await loadCapabilityCatalogPage(
      { limit: 10 },
      { listApps: async () => [app], getCapability: async () => capability },
      "de-CH",
    );
    expect(catalog.apps[0]).toMatchObject({ appName: "Demo-App", appDescription: "Deutsche Beschreibung" });
  });

  test("projects de-CH capability presentation without changing stable IDs or schema hashes", async () => {
    const capability = {
      ...entry(),
      presentation: {
        baseLocale: "en",
        translations: {
          de: {
            types: { item: { title: "Element" } },
            queries: { get: { title: "Element lesen", input: { id: "Stabile Element-ID." } } },
          },
        },
      },
    } satisfies CapabilityRegistryEntry;
    const catalog = await loadCapabilityCatalogPage(
      { limit: 10 },
      { listApps: async () => [summary(capability)], getCapability: async () => capability },
      "de-CH",
    );
    const manifest = catalog.apps[0]?.manifest;
    expect(manifest?.types[0]).toMatchObject({ localId: "item", title: "Element" });
    expect(manifest?.queries[0]).toMatchObject({
      localId: "get",
      title: "Element lesen",
      schemaHash: compiled.manifest.queries[0]?.schemaHash,
    });
    expect(manifest?.queries[0]?.inputSchema).toMatchObject({ properties: { id: { description: "Stabile Element-ID." } } });
  });

  test("returns a structured error for an unavailable app", async () => {
    const routes = createCapabilityRoutes({ getCapability: async () => null, authenticate });
    const response = await routes.request("/capabilities/v1/queries/missing/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one" } }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "APP_UNAVAILABLE", message: "App missing is not currently available" });
  });

  test("localizes framework errors without changing their stable code", async () => {
    const routes = createCapabilityRoutes({ getCapability: async () => null, authenticate });
    const response = await routes.request("/capabilities/v1/queries/missing/get", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloud-locale": "de-CH" },
      body: JSON.stringify({ input: { id: "one" } }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "APP_UNAVAILABLE", message: "App missing ist derzeit nicht verfügbar" });
  });

  test("returns structured registry failures for dispatch and catalog", async () => {
    const routes = createCapabilityRoutes({
      listApps: async () => {
        throw new Error("registry offline");
      },
      getCapability: async () => {
        throw new Error("registry offline");
      },
      authenticate,
    });
    const invocation = await routes.request("/capabilities/v1/queries/demo/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one" } }),
    });
    expect(invocation.status).toBe(503);
    expect(await invocation.json()).toMatchObject({ code: "APP_UNAVAILABLE" });

    const catalog = await routes.request("/capabilities/v1/catalog");
    expect(catalog.status).toBe(503);
    expect(await catalog.json()).toMatchObject({ code: "APP_UNAVAILABLE" });
  });

  test("forwards only caller credentials and protocol headers", async () => {
    let forwarded: Headers | undefined;
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async (_input, init) => {
        forwarded = new Headers(init?.headers);
        return Response.json({ data: { id: "one" } });
      },
    });
    const response = await routes.request("/capabilities/v1/queries/demo/get", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        cookie: "session=ignored",
        "content-type": "application/json",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        tracestate: "cloud=test",
        "x-request-id": "request-123",
        "x-cloud-actor": "forged",
      },
      body: JSON.stringify({ input: { id: "one" } }),
    });
    expect(response.status).toBe(200);
    expect(forwarded?.get("authorization")).toStartWith("Bearer ey");
    expect(forwarded?.get("authorization")).not.toContain("secret");
    expect(forwarded?.get("cookie")).toBeNull();
    expect(forwarded?.get("x-cloud-actor")).toBeNull();
    expect(forwarded?.get("idempotency-key")).toBeNull();
    expect(forwarded?.get("traceparent")).toBe("00-11111111111111111111111111111111-2222222222222222-01");
    expect(forwarded?.get("tracestate")).toBe("cloud=test");
    expect(forwarded?.get("x-request-id")).toBe("request-123");
    expect(forwarded?.get("x-cloud-capability-schema-hash")).toBe(compiled.manifest.queries[0]?.schemaHash);
  });

  test("exchanges the source credential for one exact target invocation in jwt mode", async () => {
    let forwarded: Headers | undefined;
    let signed: Parameters<typeof signInvocationToken>[0] | null = null;
    let guardCalls = 0;
    {
      const response = await dispatchCapability({
        request: new Request("http://cloud.internal/api/capabilities/v1", {
          headers: {
            authorization: "Bearer cld_source-secret",
            cookie: "session_token=source-session",
            "x-request-id": "request-123",
          },
        }),
        kind: "queries",
        appId: "demo",
        capabilityId: "get",
        input: { id: "one" },
        authority: resourceAuthority,
        dependencies: {
          getCapability: async () => entry(),
          withActiveSigner: async (purpose, callback, options) => {
            guardCalls += 1;
            return withActiveSigner(purpose, callback, options);
          },
          signInvocation: async (params) => {
            signed = params;
            const iat = 100;
            return {
              token: "target-invocation",
              kid: "33333333-3333-4333-8333-333333333333",
              claims: {
                ...params.authority,
                iss: "https://cloud.example",
                aud: `app:${params.targetAppId}`,
                token_use: "invocation",
                act: { sub: `app:${params.callingAppId}` },
                op: params.operation,
                schema_hash: params.schemaHash,
                ver: 1,
                ...(params.requestId ? { request_id: params.requestId } : {}),
                jti: "44444444-4444-4444-8444-444444444444",
                iat,
                nbf: iat,
                exp: iat + 30,
              },
            };
          },
          fetch: async (_input, init) => {
            forwarded = new Headers(init?.headers);
            return Response.json({ data: { id: "one" } });
          },
        },
      });

      expect(response.status).toBe(200);
      expect(guardCalls).toBe(1);
      expect(signed).toMatchObject({
        targetAppId: "demo",
        callingAppId: "core",
        operation: "capability.query:get",
        schemaHash: compiled.manifest.queries[0]?.schemaHash,
      });
      expect(forwarded?.get("authorization")).toBe("Bearer target-invocation");
      expect(forwarded?.get("cookie")).toBeNull();
      expect(forwarded?.get("authorization")).not.toContain("cld_source-secret");
    }
  });

  test("bounds invocation signing inside the capability deadline", async () => {
    let fetched = false;
    {
      const response = await dispatchCapability({
        request: new Request("http://cloud.internal/api/capabilities/v1"),
        kind: "queries",
        appId: "demo",
        capabilityId: "get",
        input: { id: "one" },
        authority: resourceAuthority,
        dependencies: {
          getCapability: async () => entry(),
          queryTimeoutMs: 5,
          withActiveSigner,
          signInvocation: () => new Promise(() => undefined),
          fetch: async () => {
            fetched = true;
            return Response.json({ data: { id: "one" } });
          },
        },
      });

      expect(response.status).toBe(504);
      expect(fetched).toBeFalse();
      expect(await response.json()).toMatchObject({ code: "DEADLINE_EXCEEDED", details: { retrySafe: true } });
    }
  });

  test("drops malformed optional request IDs before real invocation signing and forwarding", async () => {
    {
      for (const requestId of ["contains spaces", "non-ascii-é", "x".repeat(201)]) {
        let forwarded: Headers | undefined;
        const response = await dispatchCapability({
          request: new Request("http://cloud.internal/api/capabilities/v1", { headers: { "x-request-id": requestId } }),
          kind: "queries",
          appId: "demo",
          capabilityId: "get",
          input: { id: "one" },
          authority: resourceAuthority,
          dependencies: {
            getCapability: async () => entry(),
            withActiveSigner,
            fetch: async (_input, init) => {
              forwarded = new Headers(init?.headers);
              return Response.json({ data: { id: "one" } });
            },
          },
        });
        expect(response.status).toBe(200);
        expect(forwarded?.get("x-request-id")).toBeNull();
        expect(forwarded?.get("authorization")).toStartWith("Bearer ey");
      }
    }
  });

  test("does not let an app workload credential bypass mandates through ordinary capability routes", async () => {
    const routes = createCapabilityRoutes({
      authenticate: async (c, next) => {
        c.set("credentialKind", "api_key");
        c.set("credentialScopes", ["identity:invoke"]);
        c.set("actor", resourceAuthority.actor);
        c.set("accessSubject", resourceAuthority.accessSubject);
        return next();
      },
      getCapability: async () => entry(),
    });
    const response = await routes.request("/capabilities/v1/queries/demo/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one" } }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  test("folds the caller's locale preference into one metadata header", async () => {
    let forwarded: Headers | undefined;
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async (_input, init) => {
        forwarded = new Headers(init?.headers);
        return Response.json({ data: { id: "one" } });
      },
    });
    const invoke = (headers: Record<string, string>) =>
      routes.request("/capabilities/v1/queries/demo/get", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ input: { id: "one" } }),
      });

    expect((await invoke({ "accept-language": "en;q=0.5, de-CH" })).status).toBe(200);
    expect(forwarded?.get("x-cloud-locale")).toBe("de-CH");
    expect(forwarded?.get("accept-language")).toBeNull();

    expect((await invoke({ cookie: "cloud.locale=fr; session_token=session-value", "accept-language": "de" })).status).toBe(200);
    expect(forwarded?.get("x-cloud-locale")).toBe("fr");

    expect((await invoke({})).status).toBe(200);
    expect(forwarded?.get("x-cloud-locale")).toBeNull();
  });

  test("prefers an explicit bearer over a session cookie and enforces its OAuth scope", async () => {
    let requested = false;
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate: credentialAuthenticate,
      fetch: async (input) => {
        requested = true;
        return String(input).endsWith("/review")
          ? Response.json({ message: "Rename one to Two.", approvalScope: "item:one" })
          : Response.json({ data: { id: "one", name: "Two" } });
      },
    });
    const headers = {
      authorization: "Bearer read-token",
      cookie: "other=private; session_token=session-token",
      "content-type": "application/json",
    };

    const action = await routes.request("/capabilities/v1/actions/demo/rename", {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { id: "one", name: "Two" } }),
    });
    expect(action.status).toBe(403);
    expect(await action.json()).toEqual({ code: "FORBIDDEN", message: "OAuth scope write or admin is required" });
    expect(requested).toBeFalse();

    const review = await routes.request("/capabilities/v1/actions/demo/rename/review", {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { id: "one", name: "Two" } }),
    });
    expect(review.status).toBe(200);
    expect(requested).toBeTrue();
  });

  test("does not fall back to a valid session cookie when an explicit bearer is invalid", async () => {
    const routes = createCapabilityRoutes({ authenticate: credentialAuthenticate });
    for (const authorization of ["Bearer invalid-token", "Bearer"]) {
      const response = await routes.request("/capabilities/v1/catalog", {
        headers: { authorization, cookie: "session_token=session-token" },
      });
      expect(response.status).toBe(401);
    }
  });

  test("enforces read and write OAuth scopes while leaving sessions and admin tokens unrestricted", async () => {
    const routes = createCapabilityRoutes({
      listApps: async () => [],
      getCapability: async () => entry(),
      authenticate: credentialAuthenticate,
      fetch: async (input) =>
        String(input).includes("/actions/") ? Response.json({ data: { id: "one", name: "Two" } }) : Response.json({ data: { id: "one" } }),
    });
    const request = (path: string, token: string, input?: unknown) =>
      routes.request(path, {
        method: input === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(input === undefined ? {} : { body: JSON.stringify({ input }) }),
      });

    expect((await request("/capabilities/v1/catalog", "read-token")).status).toBe(200);
    expect((await request("/capabilities/v1/queries/demo/get", "read-token", { id: "one" })).status).toBe(200);
    expect((await request("/capabilities/v1/actions/demo/rename", "read-token", { id: "one", name: "Two" })).status).toBe(403);
    expect((await request("/capabilities/v1/catalog", "write-token")).status).toBe(403);
    expect((await request("/capabilities/v1/actions/demo/rename/review", "write-token", { id: "one", name: "Two" })).status).toBe(403);
    expect((await request("/capabilities/v1/actions/demo/rename", "write-token", { id: "one", name: "Two" })).status).toBe(200);
    expect((await request("/capabilities/v1/catalog", "admin-token")).status).toBe(200);

    const sessionAction = await routes.request("/capabilities/v1/actions/demo/rename", {
      method: "POST",
      headers: { cookie: "session_token=session-token", "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one", name: "Two" } }),
    });
    expect(sessionAction.status).toBe(200);
  });

  test("enforces the declared Action idempotency policy before dispatch", async () => {
    let requested = false;
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async () => {
        requested = true;
        return Response.json({ data: { id: "one", name: "Two" } });
      },
    });
    const rejected = await routes.request("/capabilities/v1/actions/demo/rename", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "attempt-1" },
      body: JSON.stringify({ input: { id: "one", name: "Two" } }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_NOT_ALLOWED" });
    expect(requested).toBeFalse();

    const requiredEntry = entry();
    requiredEntry.manifest.actions[0] = { ...requiredEntry.manifest.actions[0]!, idempotency: "required" };
    const requiredRoutes = createCapabilityRoutes({ getCapability: async () => requiredEntry, authenticate });
    const missing = await requiredRoutes.request("/capabilities/v1/actions/demo/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one", name: "Two" } }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  });

  test("marks a lost non-idempotent Action response as outcome unknown", async () => {
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async () => {
        throw new Error("connection reset");
      },
    });
    const response = await routes.request("/capabilities/v1/actions/demo/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one", name: "Two" } }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "ACTION_OUTCOME_UNKNOWN", details: { retrySafe: false } });
  });

  test("marks unreadable and invalid non-idempotent Action responses as outcome unknown", async () => {
    const responses = [
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":'));
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      () => Response.json({ data: { id: 42, name: "Two" } }),
      () => Response.json({ data: { id: "one", name: "x".repeat(300 * 1024) } }),
    ];

    for (const appResponse of responses) {
      const routes = createCapabilityRoutes({ getCapability: async () => entry(), authenticate, fetch: async () => appResponse() });
      const response = await routes.request("/capabilities/v1/actions/demo/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { id: "one", name: "Two" } }),
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ code: "ACTION_OUTCOME_UNKNOWN", details: { retrySafe: false } });
    }
  });

  test("preserves valid provider errors for non-idempotent Actions", async () => {
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async () => Response.json({ code: "CONFLICT", message: "Name already exists" }, { status: 409 }),
    });
    const response = await routes.request("/capabilities/v1/actions/demo/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one", name: "Two" } }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "CONFLICT", message: "Name already exists" });
  });

  test("marks a cancelled in-flight non-idempotent Action as outcome unknown", async () => {
    const controller = new AbortController();
    const responsePromise = dispatchCapability({
      request: new Request("http://cloud.internal/api/capabilities/v1", { signal: controller.signal }),
      kind: "actions",
      appId: "demo",
      capabilityId: "rename",
      input: { id: "one", name: "Two" },
      dependencies: {
        getCapability: async () => entry(),
        fetch: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
            controller.abort();
          }),
      },
    });

    const response = await responsePromise;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "ACTION_OUTCOME_UNKNOWN", details: { retrySafe: false } });
  });

  test("distinguishes a retry-safe Query deadline from app unavailability", async () => {
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      queryTimeoutMs: 1,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    });
    const response = await routes.request("/capabilities/v1/queries/demo/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one" } }),
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "DEADLINE_EXCEEDED", details: { retrySafe: true } });
  });

  test("rejects oversized app responses with the shared public limit", async () => {
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async () => Response.json({ data: { id: "x".repeat(300 * 1024) } }),
    });
    const response = await routes.request("/capabilities/v1/queries/demo/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one" } }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  test("rejects input outside the live registered schema before calling the app", async () => {
    let requested = false;
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async () => {
        requested = true;
        return Response.json({ data: { id: "one" } });
      },
    });
    const response = await routes.request("/capabilities/v1/queries/demo/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: 42 } }),
    });

    expect(response.status).toBe(400);
    expect(requested).toBe(false);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("rejects oversized direct-dispatch input before calling the app", async () => {
    let requested = false;
    const response = await dispatchCapability({
      request: new Request("http://cloud.internal/api/capabilities/v1"),
      kind: "queries",
      appId: "demo",
      capabilityId: "get",
      input: { id: "x".repeat(300 * 1024) },
      dependencies: {
        getCapability: async () => entry(),
        fetch: async () => {
          requested = true;
          return Response.json({ data: { id: "one" } });
        },
      },
    });
    expect(response.status).toBe(400);
    expect(requested).toBe(false);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  test("rejects a successful app response outside the registered result schema", async () => {
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async () => Response.json({ data: { id: 42 } }),
    });
    const response = await routes.request("/capabilities/v1/queries/demo/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one" } }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "INVALID_APP_RESPONSE" });
  });

  test("preserves structured throttling errors from the owning app", async () => {
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async () => Response.json({ code: "RATE_LIMITED", message: "Retry later" }, { status: 429 }),
    });
    const response = await routes.request("/capabilities/v1/queries/demo/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one" } }),
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ code: "RATE_LIMITED", message: "Retry later" });
  });

  test("dispatches only advertised Action reviews through the read-only review route", async () => {
    let requestedUrl = "";
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json({ message: "Rename one to Two.", approvalScope: "item:one" });
      },
    });
    const response = await routes.request("/capabilities/v1/actions/demo/rename/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one", name: "Two" } }),
    });

    expect(response.status).toBe(200);
    expect(requestedUrl).toBe("http://demo:3000/api/_internal/capabilities/v1/actions/rename/review");
    expect(await response.json()).toEqual({ message: "Rename one to Two.", approvalScope: "item:one" });
  });

  test("rejects an Action review that is not advertised", async () => {
    let requested = false;
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async () => {
        requested = true;
        return Response.json({ message: "Unexpected review." });
      },
    });
    const response = await routes.request("/capabilities/v1/actions/demo/missing/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });

    expect(response.status).toBe(404);
    expect(requested).toBe(false);
  });

  test("rejects an invalid successful Action review", async () => {
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async () => Response.json({ message: 42 }),
    });
    const response = await routes.request("/capabilities/v1/actions/demo/rename/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one", name: "Two" } }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "INVALID_APP_RESPONSE" });
  });

  test("rejects a rememberable Action review without its app-owned scope", async () => {
    const routes = createCapabilityRoutes({
      getCapability: async () => entry(),
      authenticate,
      fetch: async () => Response.json({ message: "Rename one to Two." }),
    });
    const response = await routes.request("/capabilities/v1/actions/demo/rename/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "one", name: "Two" } }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "INVALID_APP_RESPONSE" });
  });
});

test("shared catalog loader rejects limits outside the public schema", async () => {
  await expect(loadCapabilityCatalogPage({ limit: 26 }, { listApps: async () => [] })).rejects.toThrow("between 1 and 25");
});
