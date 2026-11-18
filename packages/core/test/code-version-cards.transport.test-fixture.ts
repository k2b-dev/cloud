import { spyOn } from "bun:test";
import { sql } from "@k2b/cloud";
import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { type CapabilityExecutionContext, CloudResourceReaderViewSchema } from "@k2b/cloud/contracts";
import { codeVersionCardsContract } from "@k2b/cloud/contracts/code-version-cards";
import type { RequestAuthority } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { z } from "zod";
import { compileCapabilities, invokeCompiledCapability, serializeCapabilityProviderResult } from "../../cloud/src/_internal/capabilities";
import { type CapabilityRouteDependencies, createCapabilityRoutes, dispatchCapability } from "../../cloud/src/api/capabilities";
import { createIdentityChildInvocationRoutes } from "../../cloud/src/api/identity-child-invocation";
import { signInvocationToken, verifyInvocationToken } from "../../cloud/src/services/identity/invocation-token";
import { type NestedInvocationLease, nestedInvocationLeases } from "../../cloud/src/services/identity/nested-invocation";
import { aiCapabilities } from "../src/capabilities";

/** Real public client, dispatcher, compiled provider and one-use child exchange; only identity and owner domain data are fixtures. */
export async function codeVersionCardTransport(authority: RequestAuthority) {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const kid = "55555555-5555-4555-8555-555555555555";
  const issuer = "https://card-transport.test";
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "RS256" }] });
  const signer = { key: pair.privateKey, kid, issuer, signUntil: new Date(Date.now() + 60_000) };
  const core = compileCapabilities("core", {
    protocolVersion: 2,
    queries: { "code.version.cards": aiCapabilities.queries["code.version.cards"] },
  });
  const resource = compileCapabilities("example", {
    protocolVersion: 2,
    types: { item: { title: "Item", description: "Fixture owner.", reader: "item.read" } },
    queries: {
      "item.read": {
        title: "Read owner",
        description: "Read the current owner permission.",
        openWorld: false,
        input: z.object({ id: z.string().describe("Owner identity.") }).strict(),
        data: z.object({ view: CloudResourceReaderViewSchema }).strict(),
        run: ({ id }) => ok({ data: { view: { title: `Owner ${id}`, permission: "admin" as const } } }),
      },
    },
  });
  const leases = new Map<string, NestedInvocationLease>();
  const taken = new Set<string>();
  const memoryLeases: typeof nestedInvocationLeases = {
    create: async (claims, lease) => {
      leases.set(claims.jti, lease);
    },
    read: async (id) => leases.get(id) ?? null,
    take: async (id) => {
      const lease = leases.get(id);
      if (!lease || taken.has(id)) return null;
      taken.add(id);
      return lease;
    },
    revoke: async (id) => {
      leases.delete(id);
    },
  };
  const createLease = spyOn(nestedInvocationLeases, "create").mockImplementation(memoryLeases.create);
  const revokeLease = spyOn(nestedInvocationLeases, "revoke").mockImplementation(memoryLeases.revoke);
  const previousOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.test";
  const responses: Array<{ bytes: number; data: z.output<typeof codeVersionCardsContract.data> }> = [];
  const childOwners: string[] = [];
  const publicResponseBytes: number[] = [];
  const resolve = async () => ({ ...authority, credentialKind: "invocation" as const });
  const verify: typeof verifyInvocationToken = (token, expected, options) =>
    verifyInvocationToken(token, expected, { ...options, issuer, key: keys });
  const getCapability: NonNullable<CapabilityRouteDependencies["getCapability"]> = async (appId) => ({
    appId,
    appName: appId,
    appIcon: "ti ti-code",
    appDescription: "Fixture",
    endpoint: `http://${appId}.test/api/_internal/capabilities/v1`,
    manifest: appId === "core" ? core.manifest : resource.manifest,
  });
  const getApp: NonNullable<CapabilityRouteDependencies["getApp"]> = async (id) => ({
    id,
    name: id,
    description: id,
    icon: "ti ti-code",
    baseUrl: `http://${id}.test`,
    routes: [`/app/${id}`],
  });
  const withActiveSigner: NonNullable<CapabilityRouteDependencies["withActiveSigner"]> = async (_purpose, use) => use(signer, sql);
  const child = createIdentityChildInvocationRoutes({
    verify,
    resolve,
    leases: memoryLeases,
    sourceCurrent: async () => true,
    dispatch: (params) =>
      dispatchCapability({
        ...params,
        dependencies: { getCapability, getApp, withActiveSigner, signInvocation: signInvocationToken, fetch: providerFetch },
      }),
  });
  const nested =
    (source: Request): NonNullable<CapabilityExecutionContext["query"]> =>
    async (invocation, schema) =>
      invokeCapabilityWithDataSchema({ ...invocation, kind: "query" }, schema, {
        locale: "de",
        transport: async (request) =>
          child.request(
            new Request("http://core.test/invoke-child", {
              method: "POST",
              headers: source.headers,
              body: JSON.stringify({ targetApp: invocation.appId, capabilityId: invocation.capabilityId, input: invocation.input }),
              signal: request.signal,
            }),
          ),
      });
  async function providerFetch(input: string | URL | Request, init?: RequestInit) {
    const request = input instanceof Request ? input : new Request(input, init);
    const card = new URL(request.url).hostname === "core.test";
    const compiled = card ? core : resource;
    const localId = card ? "code.version.cards" : "item.read";
    const operation = compiled.queries.get(localId)!;
    const claims = await verify(request.headers.get("authorization")!.slice(7), {
      targetAppId: card ? "core" : "example",
      operation: `capability.query:${localId}`,
      schemaHash: operation.manifest.schemaHash,
    });
    if (!claims) throw new Error("Invalid transport fixture signature");
    const actor = {
      ...authority.actor,
      delegation: {
        kind: "invocation" as const,
        callingAppId: claims.act.sub.slice(4),
        credentialKind: claims.credential_kind,
        invocationId: claims.jti,
        ...(claims.parent_invocation_id ? { parentInvocationId: claims.parent_invocation_id } : {}),
      },
    };
    const body = await request.json();
    if (!card) childOwners.push(body.input.id);
    const result = await invokeCompiledCapability({
      compiled,
      localId,
      kind: "query",
      input: body.input,
      expectedSchemaHash: operation.manifest.schemaHash,
      context: {
        authority: { ...authority, actor, credentialKind: "invocation" },
        actor,
        accessSubject: authority.accessSubject,
        user: actor.kind === "user" ? actor.user : actor.delegatedUser,
        origin: "http",
        requestId: claims.request_id ?? claims.jti,
        locale: "de",
        signal: request.signal,
        query: nested(request),
      },
    });
    const serialized = serializeCapabilityProviderResult(result);
    if (card && result.ok)
      responses.push({ bytes: Buffer.byteLength(serialized.body), data: codeVersionCardsContract.data.parse(result.data.data) });
    return new Response(serialized.body, { status: serialized.status, headers: { "content-type": "application/json" } });
  }
  const routes = new Hono().route(
    "/api",
    createCapabilityRoutes({
      getCapability,
      getApp,
      withActiveSigner,
      signInvocation: signInvocationToken,
      fetch: providerFetch,
      authenticate: async (c, next) => {
        c.set("actor", authority.actor);
        c.set("accessSubject", authority.accessSubject);
        c.set("credentialKind", authority.credentialKind);
        c.set("credentialScopes", authority.scopes);
        if (authority.credentialProof) c.set("credentialProof", authority.credentialProof);
        return next();
      },
    }),
  );
  return {
    invoke: <S extends z.ZodType>(invocation: Parameters<typeof invokeCapabilityWithDataSchema>[0], schema: S) =>
      invokeCapabilityWithDataSchema(invocation, schema, {
        locale: "de",
        transport: async (request) => {
          const response = await routes.request(request);
          publicResponseBytes.push(Buffer.byteLength(await response.clone().text()));
          return response;
        },
      }),
    responses,
    publicResponseBytes,
    childOwners,
    taken,
    dispose() {
      createLease.mockRestore();
      revokeLease.mockRestore();
      if (previousOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
      else process.env.CLOUD_CORE_INTERNAL_ORIGIN = previousOrigin;
    },
  };
}
