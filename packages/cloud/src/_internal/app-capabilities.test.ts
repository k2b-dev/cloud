import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { z } from "zod";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { dispatchCapability } from "../api/capabilities";
import { formatAppKey, importAppPublicKey } from "../app-key";
import * as executions from "../capabilities/executions";
import { appCaller, invokeCapability } from "../capabilities/server-invoke";
import { env } from "../config/env";
import { type CapabilityAppExecutionContext, type CapabilityExecutionContext, defineCapabilities } from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import { UserSchema } from "../contracts/shared";
import * as appKeys from "../services/app-keys";
import * as invocation from "../services/identity/invocation-token";
import * as settings from "../services/settings";
import { createAppCapabilityRoutes } from "./app-capabilities";
import { compileCapabilities, invokeCompiledCapability, parseCapabilityManifest } from "./capabilities";
import { bindProcessApplicationId, clearProcessApplicationId } from "./process-identity";

useUnitClients();
const now = new Date("2030-01-02T03:04:05Z");
const keyId = "22222222-2222-4222-8222-222222222222";
const fixture = APP_KEY_FIXTURES[0];
const appKey = { appId: "mail", keyId, installationId: "11111111-1111-4111-8111-111111111111", seed: fixture.seed };
const pair = await generateKeyPair("RS256", { extractable: true });
const signer = {
  kid: "33333333-3333-4333-8333-333333333333",
  key: pair.privateKey,
  signUntil: new Date("2030-01-02T04:00:00Z"),
  issuer: "https://cloud.example.test",
};
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: signer.kid, alg: "RS256", use: "sig" }] });
const options = { issuer: signer.issuer, key: jwks, now };
const input = z.object({ text: z.string().max(100).describe("Text to echo.") }).strict();
const data = z.object({ text: z.string() }).strict();
let seen: CapabilityAppExecutionContext | undefined;
const definitions = defineCapabilities({
  protocolVersion: 2,
  queries: {
    echo: {
      title: "Echo",
      description: "Generic platform query.",
      input,
      data,
      openWorld: false,
      run: (value) => ({ ok: true, data: { data: value } }),
      app: {
        permission: "geo:query",
        run: (value, context) => {
          seen = context;
          return { ok: true, data: { data: value } };
        },
      },
    },
    private: {
      title: "Private",
      description: "Person only.",
      input,
      data,
      openWorld: false,
      run: (value) => ({ ok: true, data: { data: value } }),
    },
  },
  actions: {
    "echo-action": {
      title: "Echo action",
      description: "Generic platform action.",
      input,
      data,
      openWorld: false,
      destructive: false,
      idempotency: "none",
      run: (value) => ({ ok: true, data: { data: value } }),
      app: {
        permission: "geo:query",
        run: (value, context) => {
          seen = context;
          return { ok: true, data: { data: value } };
        },
      },
    },
  },
});
const compiled = compileCapabilities("core", definitions);
const entry: CapabilityRegistryEntry = {
  appId: "core",
  appName: "Core",
  appIcon: "ti ti-box",
  appDescription: "Provider",
  endpoint: "http://provider.test/api/_internal/capabilities/v1",
  manifest: compiled.manifest,
};
const context: CapabilityAppExecutionContext = {
  actor: { kind: "app", appId: "mail", keyId },
  accessSubject: { type: "none" },
  user: null,
  locale: "de",
  requestId: "app-capability-test",
  origin: "app",
  signal: new AbortController().signal,
};
const keyOverride = Object.getOwnPropertyDescriptor(env, "CLOUD_APP_KEY")!;
const coreOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
beforeEach(() => {
  setSystemTime(now);
  seen = undefined;
});
afterEach(() => {
  Object.defineProperty(env, "CLOUD_APP_KEY", keyOverride);
  if (coreOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = coreOrigin;
  clearProcessApplicationId();
  setSystemTime();
});

test("an app handler is explicit, validated and preserved through manifest parsing", async () => {
  expect(parseCapabilityManifest(compiled.manifest, "core").queries.find((operation) => operation.localId === "echo")?.appPermission).toBe(
    "geo:query",
  );
  for (const kind of ["query", "action"] as const) {
    const capabilityId = kind === "query" ? "echo" : "echo-action";
    const operation = (kind === "query" ? compiled.queries : compiled.actions).get(capabilityId)!;
    const result = await invokeCompiledCapability({
      compiled,
      kind,
      localId: capabilityId,
      input: { text: "hello" },
      expectedSchemaHash: operation.manifest.schemaHash,
      context,
    });
    expect(result).toEqual({ ok: true, data: { data: { text: "hello" } } });
    expect(seen?.actor).toEqual(context.actor);
    expect(seen?.accessSubject).toEqual({ type: "none" });
  }
  const privateQuery = compiled.queries.get("private")!;
  expect(
    await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "private",
      input: { text: "hello" },
      expectedSchemaHash: privateQuery.manifest.schemaHash,
      context,
    }),
  ).toMatchObject({ ok: false, error: { status: 403 } });
});

test("declarations reject malformed app admission and keep its permission in the schema binding", () => {
  const original = definitions.queries.echo;
  const personOnly = compileCapabilities("core", { protocolVersion: 2, queries: { echo: { ...original, app: undefined } } });
  expect(personOnly.queries.get("echo")!.manifest.schemaHash).not.toBe(compiled.queries.get("echo")!.manifest.schemaHash);
  const changedPermission = compileCapabilities("core", {
    protocolVersion: 2,
    queries: {
      echo: {
        ...original,
        app: { ...original.app, permission: "mail:read" },
      },
    },
  });
  expect(changedPermission.queries.get("echo")!.manifest.schemaHash).not.toBe(compiled.queries.get("echo")!.manifest.schemaHash);
  expect(() =>
    compileCapabilities("core", {
      protocolVersion: 2,
      queries: { echo: { ...original, stream: { direction: "read", maxBytes: 1024, read: async () => new Response() } } },
    }),
  ).toThrow("app calls cannot use streams");
});

test("app invocation binds the app key, operation kind, target, permission, input and schema", async () => {
  for (const kind of ["query", "action"] as const) {
    const capabilityId = kind === "query" ? "echo" : "echo-action";
    const operation = (kind === "query" ? compiled.queries : compiled.actions).get(capabilityId)!;
    const expected = {
      appId: "core",
      kind,
      capabilityId,
      permission: "geo:query",
      input: { text: "hello" },
      schemaHash: operation.manifest.schemaHash,
    };
    const signed = await invocation.signAppCapabilityInvocation({
      app: { appId: "vendor-web", keyId },
      ...expected,
      targetAppId: expected.appId,
      requestId: "test",
      signer,
    });
    expect(await invocation.verifyAppCapabilityInvocation(signed.token, expected, options)).toMatchObject({
      sub: "vendor-web",
      key_id: keyId,
    });
    for (const change of [
      { appId: "other" },
      { kind: kind === "query" ? ("action" as const) : ("query" as const) },
      { capabilityId: "private" },
      { permission: "mail:read" },
      { input: { text: "changed" } },
      { schemaHash: "f".repeat(64) },
    ]) {
      expect(await invocation.verifyAppCapabilityInvocation(signed.token, { ...expected, ...change }, options)).toBeNull();
    }
    expect(
      await invocation.verifyInvocationToken(
        signed.token,
        { targetAppId: "core", operation: `capability.${kind}:${capabilityId}`, schemaHash: expected.schemaHash },
        options,
      ),
    ).toBeNull();
  }
});

for (const appId of ["mail", "vendor-web"]) {
  test(`Core admits ${appId} only with its declared capability permission and records app/key audit`, async () => {
    const record = spyOn(executions, "recordCapabilityExecution").mockResolvedValue("recorded");
    try {
      for (const allowed of [true, false]) {
        let sent = 0;
        const response = await dispatchCapability({
          request: new Request("http://core.test/invoke"),
          kind: "queries",
          origin: "app",
          appId: "core",
          capabilityId: "echo",
          input: { text: "hello" },
          appCaller: { appId, keyId },
          dependencies: {
            getCapability: async () => entry,
            getApp: async () => ({
              id: appId,
              name: appId,
              description: "Caller",
              icon: "ti ti-box",
              baseUrl: "http://app.test",
              routes: [],
              platformPermissions: allowed ? ["geo:query"] : [],
            }),
            checkAppCapabilityRate: async (id) => {
              expect(id).toBe(appId);
              return { limited: false, resetIn: 1000 };
            },
            withActiveSigner: async (_purpose, callback) => callback(signer, {} as never),
            fetch: async () => {
              sent++;
              return Response.json({ data: { text: "hello" } });
            },
          },
        });
        expect(response.status).toBe(allowed ? 200 : 403);
        expect(sent).toBe(allowed ? 1 : 0);
        expect(record).toHaveBeenLastCalledWith(
          expect.objectContaining({ actorKind: "app", actorAppId: appId, actorKeyId: keyId, userId: null }),
        );
      }
    } finally {
      record.mockRestore();
    }
  });
}

test("Core returns recoverable overload without invoking the provider", async () => {
  const record = spyOn(executions, "recordCapabilityExecution").mockResolvedValue("recorded");
  try {
    const response = await dispatchCapability({
      request: new Request("http://core.test/invoke"),
      kind: "queries",
      origin: "app",
      appId: "core",
      capabilityId: "echo",
      input: { text: "hello" },
      appCaller: { appId: "vendor-web", keyId },
      dependencies: {
        getCapability: async () => entry,
        getApp: async () => ({
          id: "vendor-web",
          name: "Vendor",
          description: "Caller",
          icon: "ti ti-box",
          baseUrl: "http://app.test",
          routes: [],
          platformPermissions: ["geo:query"],
        }),
        checkAppCapabilityRate: async () => ({ limited: true, resetIn: 1750 }),
        fetch: async () => {
          throw new Error("Must not dispatch");
        },
      },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED", details: { retryAfter: 2 } });
  } finally {
    record.mockRestore();
  }
});

test("provider rechecks key revocation for an already issued token before app code", async () => {
  const expected = {
    appId: "core",
    kind: "query" as const,
    capabilityId: "echo",
    permission: "geo:query",
    input: { text: "hello" },
    schemaHash: compiled.queries.get("echo")!.manifest.schemaHash,
  };
  const signed = await invocation.signAppCapabilityInvocation({
    app: { appId: "mail", keyId },
    ...expected,
    targetAppId: "core",
    requestId: "test",
    signer,
  });
  const verifyReal = invocation.verifyAppCapabilityInvocation;
  const verify = spyOn(invocation, "verifyAppCapabilityInvocation").mockImplementation((token, expected) =>
    verifyReal(token, expected, options),
  );
  const active = spyOn(appKeys, "getActiveAppKey").mockResolvedValue({ keyId } as never);
  const locale = spyOn(settings, "get").mockResolvedValue("en");
  try {
    const routes = createAppCapabilityRoutes(compiled);
    const call = () =>
      routes.request("http://provider.test/queries/echo", {
        method: "POST",
        headers: { authorization: `Bearer ${signed.token}` },
        body: JSON.stringify({ input: expected.input }),
      });
    expect((await call()).status).toBe(200);
    seen = undefined;
    active.mockResolvedValue(null);
    expect((await call()).status).toBe(403);
    expect(seen).toBeUndefined();
    expect(active).toHaveBeenCalledWith({ appId: "mail", keyId });
  } finally {
    verify.mockRestore();
    active.mockRestore();
    locale.mockRestore();
  }
});

test("appCaller signs each Core transmission with the configured key and carries no visitor credentials", async () => {
  expect(() => appCaller()).toThrow("Start the application");
  bindProcessApplicationId("mail", ["geo:query"]);
  Object.defineProperty(env, "CLOUD_APP_KEY", { configurable: true, value: formatAppKey(appKey) });
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.test";
  const caller = appCaller({ locale: "de", requestId: "public-form" });
  let transmissions = 0;
  const proofs = new Set<string>();
  for (let index = 0; index < 2; index++) {
    const result = await invokeCapability(
      { kind: "query", appId: "core", capabilityId: "echo", input: { text: "hello" } },
      {
        ...caller,
        transport: async (request) => {
          transmissions++;
          expect(new URL(request.url).pathname).toBe("/api/_internal/identity/v1/invoke");
          expect(request.headers.has("cookie")).toBe(false);
          const token = request.headers.get("authorization")!.slice(7);
          proofs.add(token);
          const verified = await jwtVerify(token, await importAppPublicKey(fixture.publicKey), { algorithms: ["EdDSA"], currentDate: now });
          expect(verified.protectedHeader.kid).toBe(keyId);
          expect(await request.json()).toMatchObject({
            appCaller: true,
            targetApp: "core",
            metadata: { locale: "de", requestId: "public-form" },
          });
          return Response.json({ data: { text: "hello" } });
        },
      },
    );
    expect(result.ok).toBe(true);
  }
  expect(transmissions).toBe(2);
  expect(proofs.size).toBe(2);
});

test("person and OAuth authority keep the ordinary handler; legacy app contexts cannot reach app.run", async () => {
  let personCalls = 0;
  let appCalls = 0;
  const definition = definitions.queries.echo;
  const isolated = compileCapabilities(
    "core",
    defineCapabilities({
      protocolVersion: 2,
      queries: {
        echo: {
          ...definition,
          run: (value) => {
            personCalls++;
            return { ok: true, data: { data: value } };
          },
          app: {
            ...definition.app,
            run: (value) => {
              appCalls++;
              return { ok: true, data: { data: value } };
            },
          },
        },
      },
    }),
  );
  const user = UserSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    uid: "lea",
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Lea",
    sn: "Example",
    displayName: "Lea Example",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  });
  const person: CapabilityExecutionContext = {
    ...context,
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    user,
  };
  for (const credentialKind of ["session", "oauth"] as const) {
    const result = await invokeCompiledCapability({
      compiled: isolated,
      kind: "query",
      localId: "echo",
      input: { text: "hello" },
      expectedSchemaHash: isolated.queries.get("echo")!.manifest.schemaHash,
      context: { ...person, authority: { actor: person.actor, accessSubject: person.accessSubject, credentialKind, scopes: ["read"] } },
    });
    expect(result.ok).toBe(true);
  }
  expect(personCalls).toBe(2);
  expect(appCalls).toBe(0);
  const legacy = await invokeCompiledCapability({
    compiled: isolated,
    kind: "query",
    localId: "echo",
    input: { text: "hello" },
    expectedSchemaHash: isolated.queries.get("echo")!.manifest.schemaHash,
    context: { ...context, actor: { kind: "app", appId: "mail" } },
  });
  expect(legacy).toMatchObject({ ok: false, error: { status: 403 } });
  expect(appCalls).toBe(0);
});
