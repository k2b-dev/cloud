import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { suiteFor, useMigratedDatabase } from "../../../../../scripts/fixtures/test-infra";
import { compileCapabilities, invokeCompiledCapability } from "../../_internal/capabilities";
import * as registry from "../../_internal/registry";
import { aiChatTasks } from "../../ai/chat-tasks";
import { aiConversations } from "../../ai/store";
import { dispatchCapability } from "../../api/capabilities";
import { CapabilityInvocationBodySchema } from "../../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../../contracts/registry";
import { sql } from "../../runtime/clients";
import { type AuthContext, requireInvocation } from "../../server";
import { getEffectivePermission, hasPermission } from "../../server/services/access";
import { resolveInvocationAuthority } from "../identity/invocation-actor";
import { type CloudInvocationClaims, verifyInvocationToken } from "../identity/invocation-token";
import { issueInvocationToken } from "../identity/issue-invocation";
import type { withActiveIdentitySigner } from "../identity/key-ring";
import { CODE_VERSION_MANDATE_WORKLOAD_TYPE, type Mandate, mandates } from ".";

// Real database, invocation signature, admission middleware and resource resolver.
// The provider fixture substitutes only an app's domain storage and transport.
const suite = suiteFor("database", "valkey");
suite("Code version and person routine target mandates", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  let appLookup: ReturnType<typeof spyOn<typeof registry, "getApp">>;
  let capabilityLookup: ReturnType<typeof spyOn<typeof registry, "getCapability">>;
  let userId: string;
  let codeId: string;
  let writeAccessId: string;
  let codeMandate: Mandate;
  let signingKey: CryptoKey;
  let verificationKey: JWTVerifyGetKey;
  let fetched = 0;
  let ran = 0;
  let lastClaims: CloudInvocationClaims | undefined;
  let requestNumber = 0;
  const accessByTarget = new Map<string, string[]>();
  const issuer = "https://cloud.example.test";
  const kid = "33333333-3333-4333-8333-333333333333";

  const compiled = compileCapabilities("demo", {
    protocolVersion: 2,
    types: { folder: { title: "Folder", description: "A resource with independent grants." } },
    actions: {
      write: {
        title: "Write",
        description: "Write within one folder.",
        target: "folder",
        input: z.object({ title: z.string().describe("New title.") }).strict(),
        data: z.object({ wrote: z.string() }).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "none",
        approval: "none",
        run: async (_, context) => {
          const permission = await getEffectivePermission({
            accessIds: accessByTarget.get(context.target!.id) ?? [],
            subject: context.accessSubject,
          });
          const scopeAllows = context.actor.kind === "user" || context.actor.scopes.includes("write");
          if (!scopeAllows || !hasPermission(permission, "write")) return fail(err.forbidden("No resource access"));
          ran += 1;
          return ok({ data: { wrote: context.target!.id } });
        },
      },
    },
  });
  const entry: CapabilityRegistryEntry = {
    appId: "demo",
    appName: "Demo",
    appIcon: "ti ti-folder",
    appDescription: "Provider fixture",
    endpoint: "http://demo.test/api/_internal/capabilities/v1",
    manifest: compiled.manifest,
  };
  const withSigner: typeof withActiveIdentitySigner = async (_, use) =>
    sql.begin((db) =>
      use(
        {
          kid,
          key: signingKey,
          issuer,
          groupsAdmin: [],
          signUntil: new Date(Date.now() + 60_000),
        },
        db,
      ),
    );
  const provider = new Hono<AuthContext>();
  provider.post(
    "/api/_internal/capabilities/v1/actions/write",
    requireInvocation(
      () => ({
        targetAppId: "demo",
        operation: "capability.action.run:write",
        schemaHash: compiled.manifest.actions[0]!.schemaHash,
      }),
      {
        verify: (token, expected, options) => verifyInvocationToken(token, expected, { ...options, issuer, key: verificationKey }),
        resolve: (claims) => resolveInvocationAuthority(claims, sql, []),
      },
    ),
    async (c) => {
      const body = CapabilityInvocationBodySchema.parse(await c.req.json());
      const result = await invokeCompiledCapability({
        compiled,
        localId: "write",
        kind: "action",
        expectedSchemaHash: compiled.manifest.actions[0]!.schemaHash,
        ...body,
        context: {
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
          user: c.get("user") ?? null,
          requestId: c.req.header("x-request-id") ?? "fixture",
          locale: "en",
          origin: "app",
          signal: c.req.raw.signal,
        },
      });
      return result.ok ? Response.json(result.data) : Response.json(result.error, { status: result.error.status });
    },
  );
  const invoke = (mandate: { id: string; revision: number }, targetId: string) =>
    dispatchCapability({
      request: new Request("http://core.test/capability", { headers: { "x-request-id": `code-c2-${++requestNumber}` } }),
      kind: "actions",
      appId: "demo",
      capabilityId: "write",
      origin: "app",
      // Trusted Core admission; the runner bridge transport is covered by C4.
      codeRun: mandate.id === codeMandate.id ? true : undefined,
      input: { title: "Example" },
      target: { type: "demo.folder", id: targetId },
      mandate: { mandateId: mandate.id, mandateRevision: mandate.revision, ownerAppId: "core" },
      dependencies: {
        getCapability: async () => entry,
        withActiveSigner: withSigner,
        signInvocation: async (params) => {
          expect(params.authority.scopes).toEqual([]);
          const signed = await issueInvocationToken(params, { db: sql, groupsAdmin: [] });
          lastClaims = signed.claims;
          return signed;
        },
        fetch: async (url, init) => {
          fetched += 1;
          return provider.fetch(new Request(url, init));
        },
      },
    });

  beforeAll(async () => {
    database = await useMigratedDatabase("code_mandates");
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    verificationKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" }] });
    appLookup = spyOn(registry, "getApp").mockImplementation(async (id) => ({
      id,
      name: id,
      icon: "ti ti-folder",
      description: "Fixture",
      baseUrl: `http://${id}.test`,
      routes: [],
      // A code invocation must reach its own resource grants even when human entry needs an admin.
      access: id === "demo" ? { kind: "roles", roles: ["admin"] } : { kind: "signedIn" },
    }));
    capabilityLookup = spyOn(registry, "getCapability").mockResolvedValue(entry);
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES ('code-c2-person', 'local', 'user', 'Example Person') RETURNING id`;
    userId = user!.id;
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name, kind, status) VALUES ('code-c2', 'code', 'active') RETURNING id`;
    codeId = account!.id;
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(service_account_id, permission) VALUES (${codeId}::uuid, 'write') RETURNING id`;
    writeAccessId = access!.id;
    accessByTarget.set("a", [writeAccessId]);
    accessByTarget.set("b", [writeAccessId]);
    const created = await mandates.create({
      authority: { kind: "admin", userId },
      subject: { type: "service_account", id: codeId },
      ownerAppId: "core",
      workloadType: CODE_VERSION_MANDATE_WORKLOAD_TYPE,
      workloadId: "version-a",
      policy: {
        version: 1,
        apps: ["demo"],
        operations: ["capability.action.run:write"],
        actions: "preapproved",
        grants: [{ appId: "demo", capabilityId: "write", kind: "action", target: { type: "demo.folder", id: "a" }, fixedInput: {} }],
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    codeMandate = created.data;
  });
  afterAll(async () => {
    appLookup?.mockRestore();
    capabilityLookup?.mockRestore();
    await database?.drop();
  });

  test("right pair succeeds; the same operation at another accessible target never reaches the provider", async () => {
    expect((await invoke(codeMandate, "a")).status).toBe(200);
    const before = fetched;
    expect((await invoke(codeMandate, "b")).status).toBe(403);
    expect(fetched).toBe(before);
    expect(ran).toBe(1);
  });

  test("Code admission rejects non-mandate credentials and a different version", async () => {
    expect((await invoke(codeMandate, "a")).status).toBe(200);
    if (!lastClaims) throw new Error("No invocation issued");
    const resolved = await resolveInvocationAuthority(lastClaims, sql, []);
    expect(resolved?.scopes).toEqual([]);
    expect(resolved?.actor.kind === "service_account" && resolved.actor.scopes).toEqual(["read", "write"]);
    for (const changed of [
      { ...lastClaims, credential_kind: "api_key" as const },
      { ...lastClaims, workload_id: "another-version" },
      { ...lastClaims, scopes: ["admin"] },
      { ...lastClaims, mandate_revision: lastClaims.mandate_revision! + 1 },
    ])
      expect(await resolveInvocationAuthority(changed, sql, [])).toBeNull();
  });

  test("a matching mandate cannot replace the Code grant or inherit a signed-in grant", async () => {
    const [authenticated] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(authenticated_only, permission) VALUES (true, 'write') RETURNING id`;
    accessByTarget.set("a", [authenticated!.id]);
    const before = ran;
    try {
      expect((await invoke(codeMandate, "a")).status).toBe(403);
      expect(ran).toBe(before);
    } finally {
      accessByTarget.set("a", [writeAccessId]);
    }
  });

  test("per-version revisions, pauses and disabled Code principals stop calls", async () => {
    const denied = await mandates.create({
      authority: { kind: "admin", userId },
      subject: { type: "service_account", id: codeId },
      ownerAppId: "demo",
      workloadType: "other",
      workloadId: "not-a-code-version",
      policy: codeMandate.policy,
    });
    expect(denied.ok).toBe(false);
    const paused = await mandates.pause({
      mandateId: codeMandate.id,
      expectedRevision: codeMandate.revision,
      authority: { kind: "admin", userId },
    });
    expect(paused.ok).toBe(true);
    if (!lastClaims) throw new Error("No invocation issued");
    expect(await resolveInvocationAuthority(lastClaims, sql, [])).toBeNull();
    expect((await invoke(codeMandate, "a")).status).toBe(403);
    if (!paused.ok) throw new Error(paused.error.message);
    const resumed = await mandates.resume({
      mandateId: codeMandate.id,
      expectedRevision: paused.data.revision,
      authority: { kind: "admin", userId },
    });
    if (!resumed.ok) throw new Error(resumed.error.message);
    expect((await invoke(codeMandate, "a")).status).toBe(409);
    codeMandate = resumed.data;
    await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${codeId}::uuid`;
    expect((await invoke(codeMandate, "a")).status).toBe(403);
    await sql`UPDATE auth.service_accounts SET status='active' WHERE id=${codeId}::uuid`;
    expect((await invoke(codeMandate, "a")).status).toBe(200);
  });

  test("person routine uses the same target grant and retains current human entry checks", async () => {
    // The person's normal app entry remains mandatory; use the app's signed-in rule for this case.
    appLookup.mockImplementation(async (id) => ({
      id,
      name: id,
      icon: "ti ti-folder",
      description: "Fixture",
      baseUrl: `http://${id}.test`,
      routes: [],
      access: { kind: "signedIn" },
    }));
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(user_id, permission) VALUES (${userId}::uuid, 'write') RETURNING id`;
    accessByTarget.set("a", [writeAccessId, access!.id]);
    accessByTarget.set("b", [writeAccessId, access!.id]);
    const conversation = await aiConversations.createConversation({ ownerUserId: userId, title: "Routine" });
    const task = await aiChatTasks.create({
      userId,
      chatId: conversation.shortId,
      prompt: "Write in A",
      timezone: "UTC",
      schedule: { kind: "cron", cron: "0 9 * * *" },
      grants: [{ appId: "demo", capabilityId: "write", kind: "action", target: { type: "demo.folder", id: "a" }, fixedInput: {} }],
    });
    if (!task?.mandateId || !task.mandateRevision) throw new Error("Routine mandate missing");
    const mandate = { id: task.mandateId, revision: task.mandateRevision };
    const call = { capability: "demo.write", target: { type: "demo.folder", id: "a" }, refs: {}, input: { title: "Example" } };
    await aiChatTasks.authorizeCapability({
      mandate,
      appId: "demo",
      capabilityId: "write",
      kind: "action",
      input: call.input,
      call,
      approval: "none",
    });
    await expect(
      aiChatTasks.authorizeCapability({
        mandate,
        appId: "demo",
        capabilityId: "write",
        kind: "action",
        input: call.input,
        call: { ...call, target: { ...call.target, id: "b" } },
        approval: "none",
      }),
    ).rejects.toMatchObject({ code: "MANDATE_POLICY_DENIED" });
    expect((await invoke(mandate, "a")).status).toBe(200);
    const before = fetched;
    expect((await invoke(mandate, "b")).status).toBe(403);
    expect(fetched).toBe(before);
    accessByTarget.set("a", [writeAccessId]);
    expect((await invoke(mandate, "a")).status).toBe(403);
  });
});
