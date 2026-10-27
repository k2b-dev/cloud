import { afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import { sql } from "bun";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { z } from "zod";
import { person } from "../_internal/define-app.test-fixture";
import * as executions from "../capabilities/executions";
import { createNestedCapabilityQuery } from "../capabilities/nested";
import { appAccess } from "../contracts/app-access";
import { auth } from "../server/middleware/auth";
import { requireInvocation } from "../server/middleware/invocation";
import type { InvocationPrincipalClaims, ResolvedInvocationAuthority } from "../services/identity/invocation-actor";
import { authorityFromParentInvocation } from "../services/identity/invocation-authority";
import { type CloudInvocationClaims, signInvocationToken, verifyInvocationToken } from "../services/identity/invocation-token";
import { issueInvocationToken } from "../services/identity/issue-invocation";
import { type NestedInvocationLease, nestedInvocationLeases } from "../services/identity/nested-invocation";
import { type MandatePolicyV1, mandatePolicyAllows } from "../services/mandates";
import { dispatchCapability } from "./capabilities";
import { createIdentityChildInvocationRoutes } from "./identity-child-invocation";

const now = new Date("2026-10-26T10:00:00Z");
const issuer = "https://cloud.test";
const kid = "44444444-4444-4444-8444-444444444444";
const parentId = "11111111-1111-4111-8111-111111111111";
const schemaHash = "a".repeat(64);
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;
let records: executions.CapabilityExecutionInput[];
let recording: ReturnType<typeof spyOn<typeof executions, "recordCapabilityExecution">>;
beforeAll(async () => {
  pair = await generateKeyPair("RS256", { extractable: true });
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "RS256" }] });
});
beforeEach(() => {
  setSystemTime(now);
  records = [];
  recording = spyOn(executions, "recordCapabilityExecution").mockImplementation(async (input) => {
    records.push(input);
    return parentId;
  });
});
afterEach(() => {
  recording.mockRestore();
  setSystemTime();
});
const signer = () => ({ key: pair.privateKey, kid, issuer, signUntil: new Date(now.getTime() + 60_000) });
const verify: typeof verifyInvocationToken = (token, expected, options) =>
  verifyInvocationToken(token, expected, { ...options, issuer, key: keys, now });

async function fixture(
  options: {
    mandate?: boolean;
    scopes?: string[];
    sourceCurrent?: boolean;
    origin?: NestedInvocationLease["origin"];
    allowedTool?: boolean;
    hangProvider?: boolean;
    hangResolve?: boolean;
    network?: boolean;
    serviceAccount?: "standalone" | "resource_bound";
    targetDenied?: boolean;
    mandatePolicy?: MandatePolicyV1;
  } = {},
) {
  const root = await signInvocationToken({
    targetAppId: "chat",
    callingAppId: "core",
    operation: "capability.query:discussion.list",
    schemaHash,
    authority: {
      sub: person.id,
      principal_type: options.serviceAccount ? "service_account" : "user",
      access_subject_type: options.serviceAccount ? "service_account" : "user",
      access_subject_id: person.id,
      credential_kind: options.mandate ? "mandate" : options.serviceAccount ? "api_key" : "oauth",
      ...(options.serviceAccount ? { credential_id: parentId } : {}),
      scopes: options.scopes ?? ["read"],
      ...(options.mandate ? { mandate_id: parentId, mandate_revision: 3, workload_type: "report", workload_id: "one" } : {}),
    },
    requestId: "nested-request",
    issuedAt: now,
    jti: parentId,
    signer: signer(),
    issuer,
  });
  const authority = (claims: InvocationPrincipalClaims): ResolvedInvocationAuthority => {
    const delegation = {
      kind: "invocation" as const,
      callingAppId: claims.act.sub.slice(4),
      credentialKind: claims.credential_kind,
      invocationId: claims.jti,
      ...(claims.parent_invocation_id ? { parentInvocationId: claims.parent_invocation_id } : {}),
    };
    return {
      actor: options.serviceAccount
        ? {
            kind: "service_account",
            serviceAccount: {
              id: person.id,
              name: "Restricted Chat caller",
              kind: options.serviceAccount,
              status: "active",
              delegatedUserId: null,
              appId: options.serviceAccount === "resource_bound" ? "chat" : null,
              resourceType: options.serviceAccount === "resource_bound" ? "discussion" : null,
              resourceId: options.serviceAccount === "resource_bound" ? "one" : null,
              createdBy: null,
              createdAt: now.toISOString(),
            },
            delegatedUser: null,
            scopes: [...claims.scopes],
            credentialId: parentId,
            credentialExpiresAt: new Date(now.getTime() + 30_000).toISOString(),
            delegation,
          }
        : { kind: "user", user: person, delegation },
      accessSubject: options.serviceAccount
        ? { type: "service_account", serviceAccountId: person.id }
        : { type: "user", userId: person.id },
      credentialKind: "invocation",
      scopes: [...claims.scopes],
    };
  };
  const lease: NestedInvocationLease = {
    appId: "chat",
    deadline: now.getTime() + 10_000,
    origin: options.origin ?? "http",
    proof: { kind: "oauth", payload: { exp: Math.floor(now.getTime() / 1000) + 60 } },
    ...(options.origin === "assistant" ? { assistantTurn: { conversationId: person.id, turnId: parentId } } : {}),
  };
  let active = true;
  let used = false;
  const leases: typeof nestedInvocationLeases = {
    create: async () => {},
    read: async () => (active ? lease : null),
    take: async () => {
      if (!active || used) return null;
      used = true;
      return lease;
    },
    revoke: async () => {
      active = false;
    },
  };
  let child: CloudInvocationClaims | null = null;
  let providerCalls = 0;
  let entered: () => void = () => {};
  const providerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let stopped: () => void = () => {};
  const providerStopped = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const provider = new Hono()
    .use(
      "*",
      requireInvocation(() => ({ targetAppId: "spaces", operation: "capability.query:item.read", schemaHash }), {
        verify: async (token, expected, options) => {
          child = await verify(token, expected, options);
          return child;
        },
        resolve: async (claims) => {
          if (!active) return null;
          return authority(claims);
        },
        getApp: async () => ({ id: "spaces", access: options.targetDenied ? appAccess.roles(["admin"]) : appAccess.signedIn() }),
      }),
    )
    .post("/api/_internal/capabilities/v1/queries/item.read", auth.readOnly, async (c) => {
      providerCalls++;
      entered();
      if (options.hangProvider)
        await new Promise<void>((resolve) =>
          c.req.raw.signal.addEventListener(
            "abort",
            () => {
              stopped();
              resolve();
            },
            { once: true },
          ),
        );
      return Response.json({ data: { id: "item-one" } });
    });
  const providerServer = options.network ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: provider.fetch }) : undefined;
  const routes = createIdentityChildInvocationRoutes({
    verify,
    leases,
    resolve: async () => (options.hangResolve ? new Promise<null>(() => {}) : authority(root.claims)),
    sourceCurrent: async () => options.sourceCurrent ?? true,
    authorizeTurn: async (_turn, userId, query) => {
      expect(userId).toBe(person.id);
      expect(query).toBe("spaces.item.read");
      return options.allowedTool ?? true;
    },
    dispatch: (params) =>
      dispatchCapability({
        ...params,
        dependencies: {
          getCapability: async () => ({
            appId: "spaces",
            appName: "Spaces",
            appIcon: "ti ti-box",
            appDescription: "Items",
            endpoint: new URL("/api/_internal/capabilities/v1", providerServer?.url ?? "http://spaces.test").href,
            manifest: {
              protocolVersion: 2,
              appId: "spaces",
              manifestHash: schemaHash,
              types: [],
              actions: [],
              commands: [],
              queries: [
                {
                  localId: "item.read",
                  title: "Read",
                  description: "Read one item",
                  schemaHash,
                  openWorld: false,
                  inputSchema: z.toJSONSchema(z.object({ id: z.string() }).strict()),
                  dataSchema: z.toJSONSchema(z.object({ id: z.string() }).strict()),
                },
              ],
            },
          }),
          withActiveSigner: async (_purpose, use) => use(signer(), sql),
          signInvocation: (params) =>
            issueInvocationToken(params, {
              resolve: async () => authority(root.claims),
              getApp: async () => ({ id: "spaces", access: options.targetDenied ? appAccess.roles(["admin"]) : appAccess.signedIn() }),
            }),
          withMandateIssueAuthority: async (input, use) => {
            const policy = options.mandatePolicy;
            if (!policy) return fail(err.forbidden("Revoked mandate"));
            expect(input.ownerAppId).toBe("core");
            if (!mandatePolicyAllows(policy, { ...input, appId: input.targetAppId, actionApproval: input.actionApproval ?? "none" }))
              return fail(err.forbidden("Outside mandate policy"));
            return ok(
              await use({
                mandateId: parentId,
                mandateRevision: 3,
                subject: { type: "user", id: person.id },
                ownerAppId: "core",
                workloadType: "report",
                workloadId: "one",
                targetAppId: input.targetAppId,
                operation: input.operation,
                policy,
              }),
            );
          },
          fetch: async (input, init) =>
            providerServer ? fetch(input, init) : provider.request(input instanceof Request ? input : new Request(input, init)),
        },
      }),
  });
  const request = (
    body: unknown = { targetApp: "spaces", capabilityId: "item.read", input: { id: "item-one" } },
    token = root.token,
    signal?: AbortSignal,
  ) =>
    routes.request(
      new Request("http://core.test/invoke-child", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    );
  return {
    root,
    lease,
    leases,
    request,
    authority,
    child: () => child,
    providerCalls: () => providerCalls,
    providerEntered,
    providerStopped,
    routes,
    stop: () => providerServer?.stop(true),
  };
}

test("Core signs the exact read-only child and the target verifies it; audit keeps the original actor and via-app", async () => {
  const f = await fixture();
  const response = await f.request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { id: "item-one" } });
  expect(f.child()).toMatchObject({
    sub: person.id,
    aud: "app:spaces",
    act: { sub: "app:chat" },
    credential_kind: "oauth",
    scopes: ["read"],
    parent_invocation_id: parentId,
    request_id: "nested-request",
    exp: now.getTime() / 1000 + 10,
  });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    actorId: person.id,
    viaAppId: "chat",
    parentInvocationId: parentId,
    requestId: "nested-request",
    status: "succeeded",
  });
});

test("rejects attempted authority, scope, operation-kind and deadline injection", async () => {
  for (const extra of [
    { scopes: ["admin"] },
    { authority: { sub: person.id } },
    { kind: "action" },
    { deadline: now.getTime() + 60_000 },
  ]) {
    const f = await fixture();
    expect((await f.request({ targetApp: "spaces", capabilityId: "item.read", input: { id: "item-one" }, ...extra })).status).toBe(400);
    expect(f.providerCalls()).toBe(0);
  }
});

test("scope ceilings, revoked source, revoked parent and revoked mandate fail before provider access", async () => {
  for (const options of [{ scopes: ["write"] }, { sourceCurrent: false }, { mandate: true }]) {
    const f = await fixture(options);
    expect((await f.request()).status).toBe(403);
    expect(f.providerCalls()).toBe(0);
  }
  const f = await fixture();
  await f.leases.revoke(parentId);
  expect((await f.request()).status).toBe(403);
  expect(f.providerCalls()).toBe(0);
});

test("one dependency budget is atomic across concurrent attempts and prohibits loops", async () => {
  const f = await fixture();
  expect((await Promise.all([f.request(), f.request()])).map((response) => response.status).sort()).toEqual([200, 403]);
  expect(f.providerCalls()).toBe(1);
  const sameApp = await fixture();
  expect((await sameApp.request({ targetApp: "chat", capabilityId: "item.read", input: {} })).status).toBe(403);
});

test("child tokens cannot be exchanged, forged or widened at signing", async () => {
  const f = await fixture();
  const params = {
    targetAppId: "spaces",
    callingAppId: "chat",
    operation: "capability.query:item.read",
    schemaHash,
    authority: authorityFromParentInvocation(f.root.claims),
    parent: f.root.claims,
    issuedAt: now,
    signer: signer(),
    issuer,
  };
  const child = await signInvocationToken(params);
  expect((await f.request(undefined, child.token)).status).toBe(403);
  expect((await f.request(undefined, `${child.token.slice(0, -10)}aaaaaaaaaa`)).status).toBe(403);
  await expect(signInvocationToken({ ...params, authority: { ...params.authority, scopes: ["admin"] } })).rejects.toThrow("cannot widen");
  await expect(signInvocationToken({ ...params, operation: "capability.action.run:delete" })).rejects.toThrow("cannot widen");
  await expect(signInvocationToken({ ...params, parent: child.claims, targetAppId: "notebooks", callingAppId: "spaces" })).rejects.toThrow(
    "cannot widen",
  );
});

test("Assistant tool restrictions survive the hop", async () => {
  const f = await fixture({ origin: "assistant", allowedTool: false });
  expect((await f.request()).status).toBe(403);
  expect(f.providerCalls()).toBe(0);
  expect((await (await fixture({ origin: "assistant", allowedTool: true })).request()).status).toBe(200);
});

test("a cancelled parent request never starts a child provider request", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  expect((await f.request(undefined, f.root.token, controller.signal)).status).toBe(499);
  expect(f.providerCalls()).toBe(0);
});

test("cancellation reaches an in-flight nested Query and the audit records its failure", async () => {
  const f = await fixture({ hangProvider: true });
  const controller = new AbortController();
  const pending = f.request(undefined, f.root.token, controller.signal);
  await f.providerEntered;
  controller.abort();
  expect((await pending).status).toBe(499);
  expect(records[0]).toMatchObject({ status: "failed", errorCode: "REQUEST_CANCELLED" });
});

test("the child uses the parent's remaining deadline instead of starting a new Query budget", async () => {
  const f = await fixture({ hangProvider: true });
  f.lease.deadline = now.getTime() + 1050;
  expect((await f.request()).status).toBe(504);
  expect(records[0]).toMatchObject({ status: "timed_out", errorCode: "DEADLINE_EXCEEDED" });
});

test("the remaining parent budget also bounds live-authority preflight", async () => {
  const f = await fixture({ hangResolve: true });
  f.lease.deadline = now.getTime() + 20;
  expect((await f.request()).status).toBe(504);
  expect(f.providerCalls()).toBe(0);
});

test("lease metadata cannot skip a source check using a turn outside the Assistant origin", async () => {
  const f = await fixture();
  await expect(
    nestedInvocationLeases.create(f.root.claims, {
      ...f.lease,
      assistantTurn: { conversationId: person.id, turnId: parentId },
    }),
  ).rejects.toThrow("Turn authority requires");
});

test("HTTP disconnect propagates from the calling app through Core to the child provider", async () => {
  const f = await fixture({ network: true, hangProvider: true });
  const previousOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  const coreFinished = Promise.withResolvers<void>();
  const coreRoutes = new Hono().route("/api/_internal/identity/v1", f.routes);
  const core = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      try {
        return await coreRoutes.fetch(request);
      } finally {
        coreFinished.resolve();
      }
    },
  });
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = core.url.origin;
  const chat = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      Response.json(
        await createNestedCapabilityQuery(request)(
          { appId: "spaces", capabilityId: "item.read", input: { id: "item-one" } },
          z.object({ id: z.string() }),
        ),
      ),
  });
  const controller = new AbortController();
  try {
    const pending = fetch(chat.url, {
      method: "POST",
      headers: { authorization: `Bearer ${f.root.token}` },
      signal: controller.signal,
    }).catch(() => null);
    await f.providerEntered;
    controller.abort();
    await pending;
    await f.providerStopped;
    await coreFinished.promise;
    expect(f.providerCalls()).toBe(1);
    expect(records[0]).toMatchObject({ status: "failed", errorCode: "REQUEST_CANCELLED" });
  } finally {
    controller.abort();
    chat.stop(true);
    core.stop(true);
    f.stop();
    if (previousOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
    else process.env.CLOUD_CORE_INTERNAL_ORIGIN = previousOrigin;
  }
});

test("the child route preserves application-scoped credentials, resource binding and target entry policy", async () => {
  for (const options of [
    { serviceAccount: "standalone" as const, scopes: ["chat:read"] },
    { serviceAccount: "resource_bound" as const, scopes: ["read"] },
    { targetDenied: true },
  ]) {
    const f = await fixture(options);
    expect((await f.request()).status).toBe(403);
    expect(f.providerCalls()).toBe(0);
    expect(records.at(-1)).toMatchObject({ parentInvocationId: parentId, status: "denied", errorCode: "app_access_denied" });
  }
});

test("a mandate allowing the parent does not implicitly permit its child Query", async () => {
  const policy: MandatePolicyV1 = { version: 1, apps: ["chat"], operations: ["capability.query:discussion.list"], actions: "deny" };
  expect(mandatePolicyAllows(policy, { appId: "chat", operation: "capability.query:discussion.list", actionApproval: "none" })).toBe(true);
  const f = await fixture({ mandate: true, mandatePolicy: policy });
  expect((await f.request()).status).toBe(403);
  expect(f.providerCalls()).toBe(0);
  expect(records.at(-1)).toMatchObject({ parentInvocationId: parentId, status: "denied", errorCode: "MANDATE_FORBIDDEN" });
});
