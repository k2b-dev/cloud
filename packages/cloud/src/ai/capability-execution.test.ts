import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import { buildAiCapabilityCatalog } from "./capabilities";
import { AiCapabilityExecutionError, executeAiCapability, resolveAiCapabilityActor, reviewAiCapability } from "./capability-execution";
import type { AiConversation } from "./types";

const user = (id: string) => ({
  id,
  uid: `user-${id}`,
  provider: "local" as const,
  profile: "user" as const,
  displayName: "AI User",
  mail: "ai@example.test",
  givenname: "AI",
  sn: "User",
  roles: ["user" as const],
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  avatarHash: null,
  ipa: null,
});

const conversation = (ownerId: string): AiConversation => ({
  id: "conversation-1",
  shortId: "cNv234",
  title: "Chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: ownerId,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const app = () => {
  const compiled = compileCapabilities(
    "demo",
    defineCapabilities({
      protocolVersion: 1,
      types: { item: { title: "Item", description: "One item." } },
      queries: {},
      actions: {
        create: {
          title: "Create item",
          description: "Create one item.",
          input: z.object({ title: z.string().describe("Item title.") }).strict(),
          data: z.object({ id: z.string() }).strict(),
          destructive: false,
          openWorld: false,
          idempotency: "required",
          review: async ({ title }) => ok({ message: `Create ${title}.` }),
          run: async () => ok({ data: { id: "created" } }),
        },
      },
    }),
  );
  return {
    appId: "demo",
    appName: "Demo",
    appIcon: "ti ti-box",
    appDescription: "",
    endpoint: "http://demo:3000/api/_internal/capabilities/v1",
    manifest: compiled.manifest,
  };
};

describe("AI capability authority", () => {
  test("refreshes the conversation owner and rejects mismatched or non-user actors", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    const store = { getConversation: async () => conversation(current.id) };
    const resolved = await resolveAiCapabilityActor({
      conversationId: "conversation-1",
      persistedActor: { kind: "user", user: { ...current, displayName: "Stale name" } },
      store,
      getUser: async () => current,
    });
    expect(resolved).toEqual({ actor: { kind: "user", user: current }, accessSubject: { type: "user", userId: current.id } });

    await expect(
      resolveAiCapabilityActor({
        conversationId: "conversation-1",
        persistedActor: { kind: "user", user: user("22222222-2222-4222-8222-222222222222") },
        store,
        getUser: async () => current,
      }),
    ).rejects.toThrow("no longer owns");
    await expect(
      resolveAiCapabilityActor({ conversationId: "conversation-1", persistedActor: undefined, store, getUser: async () => current }),
    ).rejects.toThrow("current user-backed actor");
    await expect(
      resolveAiCapabilityActor({
        conversationId: "conversation-1",
        persistedActor: { kind: "user", user: current },
        store,
        getUser: async () => ({ ...current, accountExpires: "2025-01-01T00:00:00.000Z" }),
      }),
    ).rejects.toThrow("no longer active");
  });

  test("keeps two users isolated and lets the target return permission-specific results", async () => {
    const first = user("11111111-1111-4111-8111-111111111111");
    const second = user("22222222-2222-4222-8222-222222222222");
    const entry = buildAiCapabilityCatalog([app()])[0]!;
    const executeFor = (current: ReturnType<typeof user>) =>
      executeAiCapability({
        conversationId: `conversation-${current.id}`,
        authority: { actor: { kind: "user", user: current }, accessSubject: { type: "user", userId: current.id } },
        entry,
        args: { title: "Test" },
        context: {
          signal: AbortSignal.timeout(1_000),
          requestApproval: async () => true,
          requestClientTool: async <T>() => undefined as T,
        },
        dependencies: {
          createDelegation: async (userId) => `delegation:${userId}`,
          revokeDelegation: async () => undefined,
          dispatch: async ({ request }) => {
            const actorId = request.headers.get("authorization")?.replace("Bearer delegation:", "");
            return Response.json({ data: { actorId, visible: actorId === first.id ? ["private-item"] : [] } });
          },
        },
      });

    expect(await executeFor(first)).toEqual({ data: { actorId: first.id, visible: ["private-item"] } });
    expect(await executeFor(second)).toEqual({ data: { actorId: second.id, visible: [] } });
  });

  test("uses one short-lived delegation, stable call idempotency, and always revokes it", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    const entry = buildAiCapabilityCatalog([app()])[0]!;
    const seen: string[] = [];
    const result = await executeAiCapability({
      conversationId: "conversation-1",
      authority: { actor: { kind: "user", user: current }, accessSubject: { type: "user", userId: current.id } },
      entry,
      args: { title: "Test" },
      context: {
        callId: "call-1",
        signal: AbortSignal.timeout(1_000),
        requestApproval: async () => true,
        requestClientTool: async <T>() => undefined as T,
      },
      dependencies: {
        createDelegation: async (userId) => {
          seen.push(`create:${userId}`);
          return "short-lived-token";
        },
        revokeDelegation: async (token) => {
          seen.push(`revoke:${token}`);
        },
        dispatch: async ({ request }) => {
          seen.push(request.headers.get("authorization") ?? "");
          seen.push(request.headers.get("idempotency-key") ?? "");
          return Response.json({ data: { id: "created" } });
        },
      },
    });
    expect(result).toEqual({ data: { id: "created" } });
    expect(seen[0]).toBe(`create:${current.id}`);
    expect(seen[1]).toBe("Bearer short-lived-token");
    expect(seen[2]).toMatch(/^ai-[a-f0-9]{64}$/);
    expect(seen[3]).toBe("revoke:short-lived-token");
  });

  test("resolves an advertised review without forwarding an idempotency key", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    let review = false;
    const result = await reviewAiCapability({
      conversationId: "conversation-1",
      authority: { actor: { kind: "user", user: current }, accessSubject: { type: "user", userId: current.id } },
      entry: buildAiCapabilityCatalog([app()])[0]!,
      args: { title: "Ada" },
      context: {
        callId: "call-1",
        signal: AbortSignal.timeout(1_000),
        requestApproval: async () => true,
        requestClientTool: async <T>() => undefined as T,
      },
      dependencies: {
        createDelegation: async () => "short-lived-token",
        revokeDelegation: async () => undefined,
        dispatch: async ({ request, review: requestedReview }) => {
          review = requestedReview === true;
          expect(request.headers.has("idempotency-key")).toBe(false);
          return Response.json({ message: "Create Ada.", details: [{ label: "Name", value: "Ada" }] });
        },
      },
    });
    expect(review).toBe(true);
    expect(result).toEqual({ message: "Create Ada.", details: [{ label: "Name", value: "Ada" }] });
  });

  test("preserves target authorization errors without leaking or retaining the delegation", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    let revoked = false;
    await expect(
      executeAiCapability({
        conversationId: "conversation-1",
        authority: { actor: { kind: "user", user: current }, accessSubject: { type: "user", userId: current.id } },
        entry: buildAiCapabilityCatalog([app()])[0]!,
        args: { title: "Denied" },
        context: {
          signal: AbortSignal.timeout(1_000),
          requestApproval: async () => true,
          requestClientTool: async <T>() => undefined as T,
        },
        dependencies: {
          createDelegation: async () => "secret-delegation",
          revokeDelegation: async () => {
            revoked = true;
          },
          dispatch: async () => Response.json({ code: "FORBIDDEN", message: "No access to this collection" }, { status: 403 }),
        },
      }),
    ).rejects.toEqual(new AiCapabilityExecutionError("FORBIDDEN", 403, "No access to this collection"));
    expect(revoked).toBe(true);
  });

  test("keeps unavailable and invalid app failures distinguishable", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    for (const failure of [
      { code: "APP_UNAVAILABLE", message: "App is unavailable", status: 503 },
      { code: "INVALID_APP_RESPONSE", message: "App returned invalid JSON", status: 502 },
    ]) {
      await expect(
        executeAiCapability({
          conversationId: "conversation-1",
          authority: { actor: { kind: "user", user: current }, accessSubject: { type: "user", userId: current.id } },
          entry: buildAiCapabilityCatalog([app()])[0]!,
          args: { title: "Test" },
          context: {
            signal: AbortSignal.timeout(1_000),
            requestApproval: async () => true,
            requestClientTool: async <T>() => undefined as T,
          },
          dependencies: {
            createDelegation: async () => "short-lived-token",
            revokeDelegation: async () => undefined,
            dispatch: async () => Response.json({ code: failure.code, message: failure.message }, { status: failure.status }),
          },
        }),
      ).rejects.toEqual(new AiCapabilityExecutionError(failure.code, failure.status, failure.message));
    }
  });

  test("surfaces bounded validation issue paths without rejected values", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    await expect(
      executeAiCapability({
        conversationId: "conversation-1",
        authority: { actor: { kind: "user", user: current }, accessSubject: { type: "user", userId: current.id } },
        entry: buildAiCapabilityCatalog([app()])[0]!,
        args: { title: "invalid-secret-value" },
        context: {
          signal: AbortSignal.timeout(1_000),
          requestApproval: async () => true,
          requestClientTool: async <T>() => undefined as T,
        },
        dependencies: {
          createDelegation: async () => "short-lived-token",
          revokeDelegation: async () => undefined,
          dispatch: async () =>
            Response.json(
              {
                code: "VALIDATION_FAILED",
                message: "Capability input did not match the registered schema",
                details: { issues: [{ path: "mailboxId", message: "Must be a stable 6-character resource ID" }] },
              },
              { status: 400 },
            ),
        },
      }),
    ).rejects.toThrow(
      "VALIDATION_FAILED: Capability input did not match the registered schema Input issues: mailboxId: Must be a stable 6-character resource ID",
    );
  });
});
