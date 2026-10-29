import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { z } from "zod";
import {
  type CapabilityDispatchDependencies,
  createCapabilityRoutes,
  dispatchCapability,
  loadCapabilityCatalogPage,
} from "../api/capabilities";
import * as executions from "../capabilities/executions";
import { type CapabilityAppExecutionContext, type CapabilityExecutionContext, defineCapabilities } from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import { LocalUserSchema } from "../contracts/shared";
import { signAppQueryInvocation, verifyAppQueryInvocation, verifyInvocationToken } from "../services/identity/invocation-token";
import { validateCapabilityCallers } from "./app-queries";
import { compileCapabilities, invokeCompiledCapability, parseCapabilityManifest } from "./capabilities";

const now = new Date("2026-10-29T00:00:00Z");
const workload = {
  appId: "chat",
  serviceAccountId: "11111111-1111-4111-8111-111111111111",
  credentialId: "22222222-2222-4222-8222-222222222222",
  scope: "identity:invoke" as const,
};
const input = z
  .object({ id: z.string().max(6).describe("Element ID"), userIds: z.array(z.uuid()).max(500).describe("Candidate people") })
  .strict();
let seen: unknown;
const definitions = defineCapabilities({
  protocolVersion: 2,
  queries: {
    readable: {
      title: "Check readers",
      description: "Return a yes/no subset.",
      input,
      data: z.object({ readable: z.array(z.uuid()).max(500) }).strict(),
      openWorld: false,
      callers: ["chat"],
      run: async (_: z.output<typeof input>, context: CapabilityExecutionContext | CapabilityAppExecutionContext) => {
        seen = context;
        return ok({ data: { readable: [] } });
      },
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
const requestInput = { id: "Abc123", userIds: [workload.serviceAccountId] };
const pair = await generateKeyPair("RS256", { extractable: true });
const signer = {
  kid: "33333333-3333-4333-8333-333333333333",
  key: pair.privateKey,
  signUntil: new Date("2026-10-29T01:00:00Z"),
  issuer: "https://cloud.example.test",
};
const key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: signer.kid, alg: "RS256", use: "sig" }] });
afterEach(() => {
  setSystemTime();
  seen = undefined;
});

test("callers validate at compile and live registration; Actions reject them", () => {
  expect(parseCapabilityManifest(compiled.manifest, "spaces").queries.find((query) => query.localId === "readable")?.callers).toEqual([
    "chat",
  ]);
  expect(() => validateCapabilityCallers(compiled.manifest, new Set(["chat"]))).not.toThrow();
  expect(() => validateCapabilityCallers(compiled.manifest)).not.toThrow();
  const typo = structuredClone(compiled.manifest);
  typo.queries[0]!.callers = ["chta"];
  expect(() => validateCapabilityCallers(typo)).toThrow("unknown caller app chta");
  expect(() => validateCapabilityCallers(compiled.manifest, new Set(["chta"]))).toThrow("unknown caller app chat");
  expect(() =>
    compileCapabilities("spaces", { ...definitions, queries: { readable: { ...definitions.queries.readable, callers: ["Bad ID"] } } }),
  ).toThrow();
  // @ts-expect-error Actions cannot acquire app callers, even through a declared value.
  const action: import("../contracts/capabilities").CapabilityActionDefinition = { ...definitions.actions.change, callers: ["chat"] };
  expect(() => compileCapabilities("spaces", { protocolVersion: 2, actions: { change: action } })).toThrow('unsupported field "callers"');
});

test("app handlers receive no grant authority and undeclared queries and Actions never run", async () => {
  for (const [kind, localId, appId, ok] of [
    ["query", "readable", "chat", true],
    ["query", "readable", "mail", false],
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
  expect(seen).toMatchObject({ actor: { kind: "app", appId: "chat" }, accessSubject: { type: "none" }, user: null });
  expect(seen).not.toHaveProperty("authority");
  expect(seen).not.toHaveProperty("query");
});

test("app tokens bind the exact input, target, query and schema, expire, and never become person invocations", async () => {
  setSystemTime(now);
  const schemaHash = compiled.manifest.queries.find((query) => query.localId === "readable")!.schemaHash;
  const signed = await signAppQueryInvocation({
    workload,
    targetAppId: "spaces",
    capabilityId: "readable",
    schemaHash,
    input: requestInput,
    requestId: context.requestId,
    signer,
  });
  const expected = { appId: "spaces", capabilityId: "readable", schemaHash, input: requestInput };
  expect(await verifyAppQueryInvocation(signed.token, expected, { issuer: signer.issuer, key, now })).toMatchObject({
    sub: "chat",
    token_use: "app_query",
  });
  for (const changed of [
    { appId: "notebooks" },
    { capabilityId: "private" },
    { schemaHash: "a".repeat(64) },
    { input: { ...requestInput, userIds: [] } },
  ])
    expect(await verifyAppQueryInvocation(signed.token, { ...expected, ...changed }, { issuer: signer.issuer, key, now })).toBeNull();
  expect(
    await verifyAppQueryInvocation(signed.token, expected, { issuer: signer.issuer, key, now: new Date("2026-10-29T00:01:00Z") }),
  ).toBeNull();
  expect(
    await verifyInvocationToken(
      signed.token,
      { targetAppId: "spaces", operation: "capability.query:readable", schemaHash },
      { issuer: signer.issuer, key, now },
    ),
  ).toBeNull();
});

test("dispatcher enforces callers, input bounds, app rate limit and app audit before forwarding", async () => {
  setSystemTime(now);
  const recorded: Parameters<typeof executions.recordCapabilityExecution>[0][] = [];
  const record = spyOn(executions, "recordCapabilityExecution").mockImplementation(async (row) => {
    recorded.push(row);
    return workload.credentialId;
  });
  const forwarded: string[] = [];
  const dependencies: CapabilityDispatchDependencies = {
    getCapability: async () => entry,
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
      capabilityId: "readable",
      input: requestInput,
      origin: "app",
      dependencies,
      ...changes,
    });
  try {
    expect((await dispatch()).status).toBe(200);
    expect(forwarded).toEqual(["http://provider.test/api/_internal/capabilities/v1/app-queries/readable"]);
    expect(recorded[0]).toMatchObject({
      actorKind: "app",
      actorId: null,
      userId: null,
      accessSubject: null,
      viaAppId: "chat",
      status: "succeeded",
    });
    expect((await dispatch({ capabilityId: "private" })).status).toBe(403);
    expect((await dispatch({ workload: { ...workload, appId: "mail" } })).status).toBe(403);
    expect((await dispatch({ kind: "actions", capabilityId: "change" })).status).toBe(403);
    expect((await dispatch({ input: { ...requestInput, userIds: Array(501).fill(workload.credentialId) } })).status).toBe(400);
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
      localId: "readable",
      input: requestInput,
      expectedSchemaHash: compiled.queries.get("readable")!.manifest.schemaHash,
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
        capabilityId: "readable",
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
    const routeCompiled = compileCapabilities("spaces", { ...definitions, queries: { "item.readable": definitions.queries.readable } });
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
    expect(catalog.apps[0]!.manifest.queries.map((query) => query.localId)).toEqual(["private"]);
  } finally {
    record.mockRestore();
  }
});
