import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { z } from "zod";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import {
  type CapabilityDispatchDependencies,
  createCapabilityRoutes,
  dispatchCapability,
  loadCapabilityCatalogPage,
} from "../api/capabilities";
import * as executions from "../capabilities/executions";
import {
  type CapabilityAppExecutionContext,
  CapabilityCatalogSchema,
  type CapabilityExecutionContext,
  CapabilityManifestSchema,
  CapabilityQueryManifestSchema,
  CloudResourceReaderViewSchema,
  defineCapabilities,
  ResourceReadableInputSchema,
} from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import { LocalUserSchema } from "../contracts/shared";
import { sql } from "../runtime/clients";
import { signAppQueryInvocation, verifyAppQueryInvocation, verifyInvocationToken } from "../services/identity/invocation-token";
import { compileCapabilities, invokeCompiledCapability, parseCapabilityManifest } from "./capabilities";

import * as resourcePrincipals from "./resource-principals";

useUnitClients();

let activePrincipals: ReturnType<typeof spyOn<typeof resourcePrincipals, "activeResourcePrincipals">>;
beforeEach(() => {
  activePrincipals = spyOn(resourcePrincipals, "activeResourcePrincipals").mockImplementation(async (principals) => principals);
});

const now = new Date("2026-10-29T00:00:00Z");
const workload = {
  appId: "chat",
  serviceAccountId: "11111111-1111-4111-8111-111111111111",
  credentialId: "22222222-2222-4222-8222-222222222222",
  scope: "identity:invoke" as const,
};
const input = ResourceReadableInputSchema;
let seen: unknown;
const definitions = defineCapabilities({
  protocolVersion: 2,
  types: {
    item: {
      title: "Item",
      description: "An inventory item",
      reader: "item.read",
      access: {
        readable: async (_input, context) => {
          seen = context;
          return [];
        },
      },
    },
  },
  queries: {
    "item.read": {
      title: "Read item",
      description: "Read the authorized item.",
      input: z.object({ id: z.string().min(1).max(512).describe("Resource ID.") }).strict(),
      data: z.object({ view: CloudResourceReaderViewSchema }),
      openWorld: false,
      run: async () => ({
        ok: true as const,
        data: { data: { view: { title: "Item", permission: "read" as const } } },
      }),
    },
    private: {
      title: "Private query",
      description: "Requires a person.",
      input,
      data: z.object({ readable: z.array(z.uuid()) }).strict(),
      openWorld: false,
      run: async () => ({ ok: true, data: { data: { readable: [] } } }),
    },
  },
  actions: {
    change: {
      title: "Change",
      description: "A person action",
      input,
      data: z.object({}).strict(),
      openWorld: false,
      destructive: false,
      idempotency: "none",
      run: async () => ({ ok: true, data: { data: {} } }),
    },
  },
});
const compiled = compileCapabilities("spaces", definitions);
const entry: CapabilityRegistryEntry = {
  appId: "spaces",
  appName: "Spaces",
  appIcon: "ti ti-box",
  appDescription: "Provider",
  endpoint: "http://provider.test/api/_internal/capabilities/v1",
  manifest: compiled.manifest,
};
const context: CapabilityAppExecutionContext = {
  actor: { kind: "app", appId: "chat" },
  accessSubject: { type: "none" },
  user: null,
  locale: "en",
  requestId: "app-query-test",
  origin: "app",
  signal: new AbortController().signal,
};
const requestInput = { id: "Abc123", principals: [{ type: "user" as const, userId: workload.serviceAccountId }] };
const pair = await generateKeyPair("RS256", { extractable: true });
const signer = {
  kid: "33333333-3333-4333-8333-333333333333",
  key: pair.privateKey,
  signUntil: new Date("2026-10-29T01:00:00Z"),
  issuer: "https://cloud.example.test",
};
const key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: signer.kid, alg: "RS256", use: "sig" }] });
afterEach(() => {
  activePrincipals.mockRestore();
  setSystemTime();
  seen = undefined;
});

test("generated app-only queries validate in the registry and older readers drop them", () => {
  const manifest = parseCapabilityManifest(compiled.manifest, "spaces");
  const query = manifest.queries.find((query) => query.localId === "item.readable")!;
  expect(query.appOnly).toBe(true);
  expect(CapabilityQueryManifestSchema.omit({ appOnly: true }).safeParse(query).success).toBe(false);
  expect(CapabilityManifestSchema.parse({ ...compiled.manifest, queries: [query] }).resourceTypes).toEqual([
    { type: "item", readable: true, view: true },
  ]);
});

test("app handlers receive no grant authority and undeclared queries and Actions never run", async () => {
  for (const [kind, localId, appId, ok] of [
    ["query", "item.readable", "chat", true],
    ["query", "item.readable", "mail", true],
    ["query", "private", "chat", false],
    ["action", "change", "chat", false],
  ] as const) {
    const operation = kind === "query" ? compiled.queries.get(localId)! : compiled.actions.get(localId)!;
    const result = await invokeCompiledCapability({
      compiled,
      kind,
      localId,
      input: requestInput,
      expectedSchemaHash: operation.manifest.schemaHash,
      context: { ...context, actor: { kind: "app", appId } },
    });
    expect(result.ok).toBe(ok);
  }
  expect(seen).toMatchObject({ actor: { kind: "app", appId: "mail" }, accessSubject: { type: "none" }, user: null });
  expect(seen).not.toHaveProperty("authority");
  expect(seen).not.toHaveProperty("query");
});

test("app tokens bind the exact input, target, query and schema, expire, and never become person invocations", async () => {
  setSystemTime(now);
  const schemaHash = compiled.manifest.queries.find((query) => query.localId === "item.readable")!.schemaHash;
  const signed = await signAppQueryInvocation({
    workload,
    targetAppId: "spaces",
    capabilityId: "item.readable",
    schemaHash,
    input: requestInput,
    requestId: context.requestId,
    signer,
  });
  const expected = { appId: "spaces", capabilityId: "item.readable", schemaHash, input: requestInput };
  expect(await verifyAppQueryInvocation(signed.token, expected, { issuer: signer.issuer, key, now })).toMatchObject({
    sub: "chat",
    token_use: "app_query",
  });
  expect(
    verifyAppQueryInvocation(signed.token, expected, {
      issuer: signer.issuer,
      key: async () => {
        throw new Error("Key service unavailable");
      },
      now,
    }),
  ).rejects.toThrow("Key service unavailable");
  expect(await verifyAppQueryInvocation("invalid-token", expected, { issuer: signer.issuer, key, now })).toBeNull();
  for (const changed of [
    { appId: "notebooks" },
    { capabilityId: "private" },
    { schemaHash: "a".repeat(64) },
    { input: { ...requestInput, principals: [] } },
  ])
    expect(await verifyAppQueryInvocation(signed.token, { ...expected, ...changed }, { issuer: signer.issuer, key, now })).toBeNull();
  expect(
    await verifyAppQueryInvocation(signed.token, expected, { issuer: signer.issuer, key, now: new Date("2026-10-29T00:01:00Z") }),
  ).toBeNull();
  expect(
    await verifyInvocationToken(
      signed.token,
      { targetAppId: "spaces", operation: "capability.query:item.readable", schemaHash },
      { issuer: signer.issuer, key, now },
    ),
  ).toBeNull();
});

test("dispatcher enforces platform permission, input bounds, app rate limit and app audit before forwarding", async () => {
  setSystemTime(now);
  const recorded: Parameters<typeof executions.recordCapabilityExecution>[0][] = [];
  const record = spyOn(executions, "recordCapabilityExecution").mockImplementation(async (row) => {
    recorded.push(row);
    return workload.credentialId;
  });
  const forwarded: string[] = [];
  const dependencies: CapabilityDispatchDependencies = {
    getCapability: async () => entry,
    getApp: async (id) => ({
      id,
      platformPermissions: id === "chat" ? ["resources:readers"] : [],
      name: id,
      description: "",
      icon: "",
      routes: [],
      baseUrl: "http://caller.test",
    }),
    checkAppQueryRate: async () => ({ limited: false }),
    withActiveSigner: async (_, callback) => callback(signer, sql),
    fetch: async (url, init) => {
      forwarded.push(String(url));
      expect(new Headers(init?.headers).get("authorization")).not.toContain("workload-secret");
      return Response.json({ data: { readable: [] } });
    },
  };
  const dispatch = (changes: Partial<Parameters<typeof dispatchCapability>[0]> = {}) =>
    dispatchCapability({
      request: new Request("http://core.test/invoke"),
      workload,
      kind: "queries",
      appId: "spaces",
      capabilityId: "item.readable",
      input: requestInput,
      origin: "app",
      dependencies,
      ...changes,
    });
  try {
    expect((await dispatch()).status).toBe(200);
    expect(forwarded).toEqual(["http://provider.test/api/_internal/capabilities/v1/app-queries/item.readable"]);
    expect(recorded[0]).toMatchObject({
      actorKind: "app",
      actorId: null,
      userId: null,
      accessSubject: null,
      viaAppId: "chat",
      status: "succeeded",
    });
    expect((await dispatch({ capabilityId: "private" })).status).toBe(403);
    const notAdmitted = await dispatch({ workload: { ...workload, appId: "mail" } });
    expect(notAdmitted.status).toBe(403);
    expect(await notAdmitted.json()).toMatchObject({ code: "APP_QUERY_NOT_ADMITTED" });
    expect((await dispatch({ dependencies: { ...dependencies, getApp: async () => null } })).status).toBe(503);
    expect((await dispatch({ kind: "actions", capabilityId: "change" })).status).toBe(403);
    expect((await dispatch({ input: { ...requestInput, principals: Array(501).fill(requestInput.principals[0]) } })).status).toBe(400);
    expect((await dispatch({ input: { ...requestInput, id: ["Abc123", "Def456"] } })).status).toBe(400);
    expect((await dispatch({ dependencies: { ...dependencies, checkAppQueryRate: async () => ({ limited: true }) } })).status).toBe(429);
    expect(
      (
        await dispatch({
          dependencies: {
            ...dependencies,
            checkAppQueryRate: async () => {
              throw new Error("Valkey down");
            },
          },
        })
      ).status,
    ).toBe(503);
    expect(forwarded).toHaveLength(1);
  } finally {
    record.mockRestore();
  }
});

test("declared app queries reject person authority at dispatch and execution, without a handler guard", async () => {
  const person = LocalUserSchema.parse({
    id: workload.serviceAccountId,
    uid: "person",
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Reader",
    sn: "Test",
    displayName: "Reader Test",
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
  const personContext: CapabilityExecutionContext = {
    ...context,
    actor: { kind: "user", user: person },
    accessSubject: { type: "user", userId: person.id },
    user: person,
  };
  seen = undefined;
  expect(
    await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "item.readable",
      input: requestInput,
      expectedSchemaHash: compiled.queries.get("item.readable")!.manifest.schemaHash,
      context: personContext,
    }),
  ).toMatchObject({ ok: false, error: { code: "FORBIDDEN", status: 403 } });
  expect(seen).toBeUndefined();
  const record = spyOn(executions, "recordCapabilityExecution").mockResolvedValue(workload.credentialId);
  let forwarded = false;
  try {
    for (const origin of ["http", "mcp", "assistant", "app"] as const) {
      const result = await dispatchCapability({
        request: new Request("http://core.test/invoke"),
        kind: "queries",
        appId: "spaces",
        capabilityId: "item.readable",
        input: requestInput,
        origin,
        authority: { actor: personContext.actor, accessSubject: personContext.accessSubject, credentialKind: "session", scopes: [] },
        dependencies: {
          getCapability: async () => entry,
          fetch: async () => {
            forwarded = true;
            return Response.json({ data: { readable: [] } });
          },
        },
      });
      expect(result.status).toBe(403);
    }
    expect(forwarded).toBe(false);
    expect(seen).toBeUndefined();
    const routeCompiled = compiled;
    const routes = createCapabilityRoutes({
      authenticate: async (c, next) => {
        c.set("actor", personContext.actor);
        c.set("accessSubject", personContext.accessSubject);
        c.set("credentialKind", "session");
        return next();
      },
      listApps: async () => [],
      getCapability: async () => ({ ...entry, manifest: routeCompiled.manifest }),
      fetch: async () => {
        forwarded = true;
        return Response.json({ data: { readable: [] } });
      },
    });
    const response = await routes.request("/capabilities/v1/queries/spaces/item.readable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: requestInput }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN", message: "App authority required for this query" });
    expect(forwarded).toBe(false);
    const catalog = await loadCapabilityCatalogPage(
      { limit: 10 },
      {
        listApps: async () => [
          {
            id: "spaces",
            name: "Spaces",
            icon: "ti ti-box",
            description: "Provider",
            baseUrl: "http://provider.test",
            routes: [],
            capabilities: { protocolVersion: 2, manifestHash: compiled.manifest.manifestHash },
          },
        ],
        getCapability: async () => entry,
      },
    );
    expect(CapabilityCatalogSchema.parse(catalog).apps[0]!.manifest.resourceTypes).toEqual([{ type: "item", readable: true, view: true }]);
    expect(catalog.apps[0]!.manifest.queries.map((query) => query.localId)).toEqual(["item.read", "private"]);
  } finally {
    record.mockRestore();
  }
});
