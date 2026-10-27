import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "bun";
import { generateKeyPair } from "jose";
import { z } from "zod";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { dispatchCapability } from "../../api/capabilities";
import * as executions from "../../capabilities/executions";
import { listCapabilityExecutions, migrateCloudCapabilities } from "../../capabilities/executions";
import { requestCacheRedis } from "../request-cache-redis";
import { createApiToken } from "../service-account-credentials";
import { createTestBrowserSignIn } from "../session/session.test-fixture";
import { resolveInvocationAuthority } from "./invocation-actor";
import { authorityFromParentInvocation } from "./invocation-authority";
import { signInvocationToken } from "./invocation-token";
import { issueInvocationToken } from "./issue-invocation";
import { isNestedSourceCurrent, nestedInvocationLeases } from "./nested-invocation";

const suite = suiteFor("database", "valkey");
const now = new Date("2026-10-26T10:00:00Z");
const userId = crypto.randomUUID();
const accountId = crypto.randomUUID();
let session: { userId: string; sid: string };
let signer: { key: CryptoKey; kid: string; signUntil: Date };
const leases: string[] = [];
let recording: ReturnType<typeof spyOn<typeof executions, "recordCapabilityExecution">> | undefined;
let revoking: ReturnType<typeof spyOn<typeof nestedInvocationLeases, "revoke">> | undefined;
let creating: ReturnType<typeof spyOn<typeof nestedInvocationLeases, "create">> | undefined;

suite("nested invocation authority on shared infrastructure", () => {
  beforeAll(async () => {
    await migrateCloudCapabilities();
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
      VALUES (${userId}, ${userId}, 'local', 'user', 'Nested caller')`;
    await sql`INSERT INTO auth.service_accounts (id, name, kind, created_by)
      VALUES (${accountId}, 'Nested API caller', 'standalone', ${userId})`;
    session = await createTestBrowserSignIn(userId);
    signer = { key: (await generateKeyPair("RS256")).privateKey, kid: crypto.randomUUID(), signUntil: new Date(now.getTime() + 60_000) };
  });
  beforeEach(() => {
    setSystemTime(now);
  });
  afterEach(() => {
    recording?.mockRestore();
    recording = undefined;
    revoking?.mockRestore();
    revoking = undefined;
    creating?.mockRestore();
    creating = undefined;
    setSystemTime();
  });
  afterAll(async () => {
    for (const id of leases) {
      await (await requestCacheRedis()).send("DEL", [`identity:nested:v1:${id}`, `identity:nested:v1:${id}:used`]);
      await sql`DELETE FROM capabilities.executions WHERE invocation_id = ${id}::uuid`;
    }
    await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}`;
  });
  const parent = () =>
    signInvocationToken({
      targetAppId: "chat",
      callingAppId: "core",
      operation: "capability.query:discussion.list",
      schemaHash: null,
      authority: {
        sub: userId,
        principal_type: "user",
        access_subject_type: "user",
        access_subject_id: userId,
        credential_kind: "session",
        scopes: [],
      },
      issuedAt: now,
      signer,
      issuer: "https://cloud.test",
    });
  const proof = () => ({ kind: "session" as const, ...session, authEpoch: 0, expiresAt: new Date(now.getTime() + 60_000).toISOString() });

  test("public dispatch owns the active parent's lease and execution lineage through completion and cancellation", async () => {
    const writes: ReturnType<typeof executions.recordCapabilityExecution>[] = [];
    const record = executions.recordCapabilityExecution;
    recording = spyOn(executions, "recordCapabilityExecution").mockImplementation((input) => {
      const write = record(input);
      writes.push(write);
      return write;
    });
    const root = await parent();
    const resolved = await resolveInvocationAuthority(root.claims, sql, []);
    expect(resolved).not.toBeNull();
    if (!resolved) return;
    for (const phase of ["complete", "provider", "signer", "slow-revoke", "lease-error", "lease-timeout"] as const) {
      const cancel = phase === "provider" || phase === "signer";
      if (phase === "slow-revoke") revoking = spyOn(nestedInvocationLeases, "revoke").mockImplementation(() => new Promise<void>(() => {}));
      if (phase === "lease-error") creating = spyOn(nestedInvocationLeases, "create").mockRejectedValue(new Error("Valkey unavailable"));
      if (phase === "lease-timeout")
        creating = spyOn(nestedInvocationLeases, "create").mockImplementation(() => new Promise<void>(() => {}));
      let releaseSigning: () => void = () => {};
      const signingGate = new Promise<void>((resolve) => {
        releaseSigning = resolve;
      });
      let signingFinished: () => void = () => {};
      const signerFinished = new Promise<void>((resolve) => {
        signingFinished = resolve;
      });
      const id = crypto.randomUUID();
      leases.push(id);
      const requestId = `nested-${id}`;
      const controller = new AbortController();
      let entered: () => void = () => {};
      const upstreamEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = dispatchCapability({
        request: new Request("http://core.test/api/capabilities/v1/queries/chat/discussion.list", {
          method: "POST",
          headers: { "x-request-id": requestId },
          signal: controller.signal,
        }),
        kind: "queries",
        origin: "http",
        appId: "chat",
        capabilityId: "discussion.list",
        input: {},
        authority: { ...resolved, credentialKind: "session", credentialProof: proof() },
        dependencies: {
          getCapability: async () => ({
            appId: "chat",
            appName: "Chat",
            appIcon: "ti ti-message",
            appDescription: "Discussions",
            endpoint: "http://chat.test/api/_internal/capabilities/v1",
            manifest: {
              protocolVersion: 2,
              appId: "chat",
              manifestHash: "a".repeat(64),
              types: [],
              actions: [],
              commands: [],
              queries: [
                {
                  localId: "discussion.list",
                  title: "List",
                  description: "List discussion",
                  schemaHash: "a".repeat(64),
                  openWorld: false,
                  inputSchema: z.toJSONSchema(z.object({}).strict()),
                  dataSchema: z.toJSONSchema(z.object({}).strict()),
                },
              ],
            },
          }),
          withActiveSigner: async (_purpose, use) => {
            try {
              return await use({ ...signer, issuer: "https://cloud.test", groupsAdmin: [] }, sql);
            } finally {
              signingFinished();
            }
          },
          signInvocation: async (params) => {
            const issued = await issueInvocationToken(
              { ...params, jti: id },
              {
                getApp: async () => ({ id: "chat", access: { kind: "signedIn" } }),
                groupsAdmin: [],
              },
            );
            if (phase === "signer") {
              entered();
              await signingGate;
            }
            return issued;
          },
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const lease = await nestedInvocationLeases.read(id);
            if (phase === "lease-error" || phase === "lease-timeout") expect(lease).toBeNull();
            else expect(lease).toMatchObject({ appId: "chat", origin: "http", proof: proof() });
            entered();
            if (phase === "provider")
              await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
            return Response.json({ data: {} });
          },
        },
      });
      await upstreamEntered;
      if (cancel) controller.abort();
      expect((await pending).status).toBe(cancel ? 499 : 200);
      if (phase === "slow-revoke") {
        revoking?.mockRestore();
        revoking = undefined;
        await nestedInvocationLeases.revoke(id);
      }
      creating?.mockRestore();
      creating = undefined;
      releaseSigning();
      await signerFinished;
      await Promise.all(writes);
      expect(await nestedInvocationLeases.read(id)).toBeNull();
      const history = await listCapabilityExecutions({ requestId });
      expect(history.items[0]).toMatchObject({
        invocationId: phase === "signer" ? null : id,
        actorId: userId,
        parentInvocationId: null,
        viaAppId: null,
      });
      await sql`DELETE FROM capabilities.executions WHERE request_id = ${requestId}`;
    }
  });

  test("shared atomic budget admits one attempt and revocation invalidates an already signed child", async () => {
    const root = await parent();
    leases.push(root.claims.jti);
    await nestedInvocationLeases.create(root.claims, { appId: "chat", origin: "http", deadline: now.getTime() + 25_000, proof: proof() });
    const admitted = await Promise.all(Array.from({ length: 8 }, () => nestedInvocationLeases.take(root.claims.jti)));
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(Number(await (await requestCacheRedis()).send("PTTL", [`identity:nested:v1:${root.claims.jti}`]))).toBeGreaterThan(0);
    const child = await signInvocationToken({
      targetAppId: "spaces",
      callingAppId: "chat",
      operation: "capability.query:item.read",
      schemaHash: null,
      authority: authorityFromParentInvocation(root.claims),
      parent: root.claims,
      issuedAt: now,
      signer,
      issuer: "https://cloud.test",
    });
    expect((await resolveInvocationAuthority(child.claims, sql, []))?.actor.delegation).toMatchObject({
      callingAppId: "chat",
      parentInvocationId: root.claims.jti,
    });
    await nestedInvocationLeases.revoke(root.claims.jti);
    expect(await resolveInvocationAuthority(child.claims, sql, [])).toBeNull();
    expect(await nestedInvocationLeases.take(root.claims.jti)).toBeNull();
  });

  test("a real SET completing after setup cancellation removes its lease before returning", async () => {
    const root = await parent();
    leases.push(root.claims.jti);
    const controller = new AbortController();
    const client = await requestCacheRedis();
    const send = client.send.bind(client);
    const sending = spyOn(client, "send").mockImplementation(async (command, args) => {
      const value = await send(command, args);
      if (command === "SET" && args[0] === `identity:nested:v1:${root.claims.jti}`)
        controller.abort(new Error("Setup cancelled while SET completed"));
      return value;
    });
    try {
      await expect(
        nestedInvocationLeases.create(
          root.claims,
          {
            appId: "chat",
            origin: "http",
            deadline: now.getTime() + 10_000,
            proof: proof(),
          },
          controller.signal,
        ),
      ).rejects.toThrow("Setup cancelled");
      expect(await nestedInvocationLeases.read(root.claims.jti)).toBeNull();
    } finally {
      sending.mockRestore();
    }
  });

  test("source-session revocation invalidates a live parent and an already signed child", async () => {
    const root = await parent();
    leases.push(root.claims.jti);
    await nestedInvocationLeases.create(root.claims, { appId: "chat", origin: "http", deadline: now.getTime() + 25_000, proof: proof() });
    const child = await signInvocationToken({
      targetAppId: "spaces",
      callingAppId: "chat",
      operation: "capability.query:item.read",
      schemaHash: null,
      authority: authorityFromParentInvocation(root.claims),
      parent: root.claims,
      issuedAt: now,
      signer,
      issuer: "https://cloud.test",
    });
    expect(await isNestedSourceCurrent(proof(), root.claims)).toBe(true);
    await sql`UPDATE auth.session_families SET revoked_at = now() WHERE sid = ${session.sid}`;
    expect(await isNestedSourceCurrent(proof(), root.claims)).toBe(false);
    expect(await resolveInvocationAuthority(child.claims, sql, [])).toBeNull();
    await sql`UPDATE auth.session_families SET revoked_at = NULL WHERE sid = ${session.sid}`;
  });

  test("a changed live access subject cannot replace the parent's signed subject", async () => {
    const root = await parent();
    const claims = {
      ...root.claims,
      sub: accountId,
      principal_type: "service_account" as const,
      access_subject_type: "service_account" as const,
      access_subject_id: accountId,
    };
    expect((await resolveInvocationAuthority(claims, sql, []))?.accessSubject.type).toBe("service_account");
    try {
      await sql`UPDATE auth.service_accounts SET kind = 'user_delegated', delegated_user_id = ${userId} WHERE id = ${accountId}`;
      expect(await resolveInvocationAuthority(claims, sql, [])).toBeNull();
    } finally {
      await sql`UPDATE auth.service_accounts SET kind = 'standalone', delegated_user_id = NULL WHERE id = ${accountId}`;
    }
  });

  test("source API-key scope changes and revocation cannot reuse the parent's previous scope", async () => {
    const result = await createApiToken({ serviceAccountId: accountId, name: "Nested test", scopes: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const credentialId = result.data.credential.id;
    const claims = {
      sub: accountId,
      principal_type: "service_account" as const,
      credential_kind: "api_key" as const,
      credential_id: credentialId,
      scopes: [],
    };
    expect(await isNestedSourceCurrent({ kind: "api_key", credentialId }, claims)).toBe(true);
    await sql`UPDATE auth.service_account_credentials SET scopes = ARRAY['chat:read'] WHERE id = ${credentialId}`;
    expect(await isNestedSourceCurrent({ kind: "api_key", credentialId }, claims)).toBe(false);
    await sql`UPDATE auth.service_account_credentials SET scopes = '{}', status = 'revoked', revoked_at = now() WHERE id = ${credentialId}`;
    expect(await isNestedSourceCurrent({ kind: "api_key", credentialId }, claims)).toBe(false);
  });
});
