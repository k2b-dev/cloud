import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { generateKeyPair } from "jose";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { compileReviewFixture, outcomeCheckCases } from "../_internal/capability-review.test-fixture";
import type { dispatchCapability } from "../api/capabilities";
import * as executionStore from "../capabilities/executions";
import { defineCapabilities } from "../contracts/capabilities";
import * as categoryPolicy from "../services/account-category-policy";
import { signInvocationToken } from "../services/identity/invocation-token";
import { buildAiCapabilityCatalog } from "./capabilities";
import {
  AiCapabilityExecutionError,
  aiCapabilityCheckResult,
  checkAiCapability,
  executeAiCapability,
  resolveAiCapabilityActor,
  reviewAiCapability,
} from "./capability-execution";
import type { AiConversation } from "./types";

afterEach(() => mock.restore());

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
  done: null,
  isDone: false,
  lastUsedAt: "2026-09-14T00:00:00.000Z",
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
      protocolVersion: 2,
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
    const allowed = spyOn(categoryPolicy, "isAccountCategoryAllowed").mockResolvedValue(true);
    const current = user("11111111-1111-4111-8111-111111111111");
    const store = { getConversation: async () => conversation(current.id) };
    const resolved = await resolveAiCapabilityActor({
      conversationId: "conversation-1",
      persistedActor: { kind: "user", user: { ...current, displayName: "Stale name" } },
      store,
      getUser: async () => current,
    });
    expect(resolved).toEqual({
      actor: { kind: "user", user: current },
      accessSubject: { type: "user", userId: current.id },
      credentialKind: "session",
      scopes: [],
    });
    expect(allowed).toHaveBeenCalledWith(current);
    allowed.mockResolvedValueOnce(false);
    await expect(
      resolveAiCapabilityActor({
        conversationId: "conversation-1",
        persistedActor: { kind: "user", user: current },
        store,
        getUser: async () => current,
      }),
    ).rejects.toThrow("category is disabled");

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

  test("a turn started in the mobile app keeps the app's limits after the owner is reloaded", async () => {
    spyOn(categoryPolicy, "isAccountCategoryAllowed").mockResolvedValue(true);
    const current = { ...user("11111111-1111-4111-8111-111111111111"), roles: ["user" as const, "admin" as const] };
    const resolved = await resolveAiCapabilityActor({
      conversationId: "conversation-1",
      persistedActor: { kind: "user", user: { ...current, roles: ["user"] }, sessionKind: "app" },
      store: { getConversation: async () => conversation(current.id) },
      getUser: async () => current,
    });
    expect(resolved).toEqual({
      actor: { kind: "user", user: { ...current, roles: ["user"] }, sessionKind: "app" },
      accessSubject: { type: "user", userId: current.id },
      credentialKind: "session",
      scopes: [],
    });
  });

  test("keeps two users isolated and lets the target return permission-specific results", async () => {
    const first = user("11111111-1111-4111-8111-111111111111");
    const second = user("22222222-2222-4222-8222-222222222222");
    const entry = buildAiCapabilityCatalog([app()])[0]!;
    const executeFor = (current: ReturnType<typeof user>) =>
      executeAiCapability({
        conversationId: `conversation-${current.id}`,
        authority: {
          actor: { kind: "user", user: current },
          accessSubject: { type: "user", userId: current.id },
          credentialKind: "session",
          scopes: [],
        },
        entry,
        args: { title: "Test" },
        context: {
          signal: AbortSignal.timeout(1_000),
          requestApproval: async () => true,
          requestClientTool: async <T>() => undefined as T,
        },
        dependencies: {
          dispatch: async ({ request, authority }) => {
            expect(request.headers.has("authorization")).toBeFalse();
            const actorId = authority?.accessSubject.type === "user" ? authority.accessSubject.userId : null;
            return Response.json({ data: { actorId, visible: actorId === first.id ? ["private-item"] : [] } });
          },
        },
      });

    expect(await executeFor(first)).toEqual({ data: { actorId: first.id, visible: ["private-item"] } });
    expect(await executeFor(second)).toEqual({ data: { actorId: second.id, visible: [] } });
  });

  test("passes authority without a reusable credential and preserves stable call idempotency", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    const entry = buildAiCapabilityCatalog([app()])[0]!;
    const seen: string[] = [];
    const result = await executeAiCapability({
      conversationId: "conversation-1",
      authority: {
        actor: { kind: "user", user: current },
        accessSubject: { type: "user", userId: current.id },
        credentialKind: "session",
        scopes: [],
      },
      locale: "de-CH",
      entry,
      args: { title: "Test" },
      context: {
        callId: "call-1",
        signal: AbortSignal.timeout(1_000),
        requestApproval: async () => true,
        requestClientTool: async <T>() => undefined as T,
      },
      dependencies: {
        dispatch: async ({ request }) => {
          seen.push(request.headers.get("authorization") ?? "");
          seen.push(request.headers.get("idempotency-key") ?? "");
          seen.push(request.headers.get("x-cloud-locale") ?? "");
          return Response.json({ data: { id: "created" } });
        },
      },
    });
    expect(result).toEqual({ data: { id: "created" } });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe("");
    expect(seen[1]).toMatch(/^ai-[a-f0-9]{64}$/);
    expect(seen[2]).toBe("de-CH");
  });

  test("dispatch preserves the supplied credential scopes and mobile session limits", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    const authority = {
      actor: { kind: "user" as const, user: current, sessionKind: "app" as const },
      accessSubject: { type: "user" as const, userId: current.id },
      credentialKind: "oauth" as const,
      scopes: ["demo:read"],
    };
    const dispatch = mock<typeof dispatchCapability>(async (input) => {
      expect(input.authority).toBe(authority);
      expect(input.request.headers.has("authorization")).toBe(false);
      return Response.json({ code: "app_access_denied", message: "Application access denied" }, { status: 403 });
    });
    await expect(
      executeAiCapability({
        conversationId: "conversation-1",
        authority,
        entry: buildAiCapabilityCatalog([app()])[0]!,
        args: { title: "Test" },
        context: {
          signal: AbortSignal.timeout(1_000),
          requestApproval: async () => true,
          requestClientTool: async <T>() => undefined as T,
        },
        dependencies: { dispatch },
      }),
    ).rejects.toMatchObject({ code: "app_access_denied", status: 403, dispatched: false });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test("resolves an advertised review without forwarding an idempotency key", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    let review = false;
    const result = await reviewAiCapability({
      conversationId: "conversation-1",
      authority: {
        actor: { kind: "user", user: current },
        accessSubject: { type: "user", userId: current.id },
        credentialKind: "session",
        scopes: [],
      },
      entry: buildAiCapabilityCatalog([app()])[0]!,
      args: { title: "Ada" },
      context: {
        callId: "call-1",
        signal: AbortSignal.timeout(1_000),
        requestApproval: async () => true,
        requestClientTool: async <T>() => undefined as T,
      },
      dependencies: {
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

  test("uses mandate authority for scheduled review and approved Action execution", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    const entry = buildAiCapabilityCatalog([app()])[0]!;
    const mandate = { id: "33333333-3333-4333-8333-333333333333", revision: 4 };
    const seen: Array<{ review: boolean; actionApproval?: "approved" }> = [];
    const dependencies = {
      dispatch: async (input: Parameters<typeof dispatchCapability>[0]) => {
        seen.push({ review: input.review === true, actionApproval: input.mandate?.actionApproval });
        if (!input.review && input.mandate?.actionApproval !== "approved") {
          return Response.json({ code: "MANDATE_FORBIDDEN", message: "Action approval is required" }, { status: 403 });
        }
        return input.review ? Response.json({ message: "Create Ada." }) : Response.json({ data: { id: "created" } });
      },
    };
    const base = {
      conversationId: "conversation-1",
      authority: {
        actor: { kind: "user" as const, user: current },
        accessSubject: { type: "user" as const, userId: current.id },
        credentialKind: "session" as const,
        scopes: [],
      },
      mandate,
      entry,
      args: { title: "Ada" },
      context: {
        callId: "call-1",
        signal: AbortSignal.timeout(1_000),
        requestApproval: async () => true,
        requestClientTool: async <T>() => undefined as T,
      },
      dependencies,
    };

    await reviewAiCapability(base);
    await expect(executeAiCapability(base)).rejects.toEqual(
      new AiCapabilityExecutionError("MANDATE_FORBIDDEN", 403, "Action approval is required"),
    );
    await executeAiCapability({ ...base, actionApproval: "approved" });

    expect(seen).toEqual([
      { review: true, actionApproval: undefined },
      { review: false, actionApproval: undefined },
      { review: false, actionApproval: "approved" },
    ]);
  });

  test("preserves target authorization errors", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    await expect(
      executeAiCapability({
        conversationId: "conversation-1",
        authority: {
          actor: { kind: "user", user: current },
          accessSubject: { type: "user", userId: current.id },
          credentialKind: "session",
          scopes: [],
        },
        entry: buildAiCapabilityCatalog([app()])[0]!,
        args: { title: "Denied" },
        context: {
          signal: AbortSignal.timeout(1_000),
          requestApproval: async () => true,
          requestClientTool: async <T>() => undefined as T,
        },
        dependencies: {
          dispatch: async () => Response.json({ code: "FORBIDDEN", message: "No access to this collection" }, { status: 403 }),
        },
      }),
    ).rejects.toEqual(new AiCapabilityExecutionError("FORBIDDEN", 403, "No access to this collection"));
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
          authority: {
            actor: { kind: "user", user: current },
            accessSubject: { type: "user", userId: current.id },
            credentialKind: "session",
            scopes: [],
          },
          entry: buildAiCapabilityCatalog([app()])[0]!,
          args: { title: "Test" },
          context: {
            signal: AbortSignal.timeout(1_000),
            requestApproval: async () => true,
            requestClientTool: async <T>() => undefined as T,
          },
          dependencies: {
            dispatch: async () => Response.json({ code: failure.code, message: failure.message }, { status: failure.status }),
          },
        }),
      ).rejects.toEqual(new AiCapabilityExecutionError(failure.code, failure.status, failure.message));
    }
  });

  test.each(["registry unavailable", "not registered", "upstream 503", "upstream 504", "upstream 500"])(
    "tracks whether the app was attempted: %s",
    async (failure) => {
      spyOn(executionStore, "recordCapabilityExecution").mockResolvedValue(crypto.randomUUID());
      const current = user("11111111-1111-4111-8111-111111111111");
      const registered = app();
      // Avoid idempotency storage: this test exercises the dispatch boundary itself.
      registered.manifest.actions[0]!.idempotency = "none";
      const upstream = failure.startsWith("upstream");
      const status = upstream ? Number(failure.slice(-3)) : 503;
      const fetch = mock(async () => Response.json({ code: "APP_UNAVAILABLE", message: "Unavailable" }, { status }));
      const { privateKey } = await generateKeyPair("RS256");
      await expect(
        executeAiCapability({
          conversationId: "conversation-1",
          authority: {
            actor: { kind: "user", user: current },
            accessSubject: { type: "user", userId: current.id },
            credentialKind: "session",
            scopes: [],
          },
          entry: buildAiCapabilityCatalog([registered])[0]!,
          args: { title: "Test" },
          context: {
            signal: new AbortController().signal,
            requestApproval: async () => true,
            requestClientTool: async <T>() => undefined as T,
          },
          dependencies: {
            getCapability: async () => {
              if (failure === "registry unavailable") throw new Error("Registry offline");
              return upstream ? registered : null;
            },
            // App-access enforcement is tested at the broker seam; this dispatch
            // test supplies its signer without performing live identity/registry reads.
            signInvocation: signInvocationToken,
            withActiveSigner: async (_purpose, callback) =>
              callback(
                { kid: "test", key: privateKey, issuer: "https://cloud.example.test", signUntil: new Date("2099-01-01T00:00:00Z") },
                sql,
              ),
            fetch,
          },
        }),
      ).rejects.toMatchObject({ code: "APP_UNAVAILABLE", status, dispatched: upstream });
      expect(fetch).toHaveBeenCalledTimes(upstream ? 1 : 0);
    },
  );

  test("surfaces bounded validation issue paths without rejected values", async () => {
    const current = user("11111111-1111-4111-8111-111111111111");
    await expect(
      executeAiCapability({
        conversationId: "conversation-1",
        authority: {
          actor: { kind: "user", user: current },
          accessSubject: { type: "user", userId: current.id },
          credentialKind: "session",
          scopes: [],
        },
        entry: buildAiCapabilityCatalog([app()])[0]!,
        args: { title: "invalid-secret-value" },
        context: {
          signal: AbortSignal.timeout(1_000),
          requestApproval: async () => true,
          requestClientTool: async <T>() => undefined as T,
        },
        dependencies: {
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

describe("Action outcome checks", () => {
  test.each(outcomeCheckCases())("validates the check Query response: $name", async ({ result, valid }) => {
    const compiled = compileReviewFixture();
    const catalog = buildAiCapabilityCatalog([{ ...app(), manifest: compiled.manifest }]);
    const entry = catalog.find((entry) => entry.kind === "action")!;
    const current = user("11111111-1111-4111-8111-111111111111");
    const dispatch = mock<typeof dispatchCapability>(async (input) => {
      expect(input).toMatchObject({
        kind: "queries",
        capabilityId: "check",
        appId: "demo",
        origin: "assistant",
        review: false,
        input: { id: "original" },
      });
      expect(input.authority?.actor).toEqual({ kind: "user", user: current });
      expect(input.request.headers.get("x-cloud-locale")).toBe("de");
      expect(input.request.headers.has("idempotency-key")).toBe(false);
      return Response.json(result);
    });
    const checked = await checkAiCapability({
      conversationId: "conversation-1",
      entry,
      catalog,
      check: { query: "check", input: { id: "original" } },
      authority: {
        actor: { kind: "user", user: current },
        accessSubject: { type: "user", userId: current.id },
        credentialKind: "session",
        scopes: [],
      },
      locale: "de",
      context: { callId: "send", signal: new AbortController().signal },
      dependencies: { dispatch },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(checked.state === (valid ? result.data.outcome : "failed")).toBe(true);
    expect(checked.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("a failed check runs once and cannot dispatch an Action", async () => {
    const catalog = buildAiCapabilityCatalog([{ ...app(), manifest: compileReviewFixture().manifest }]);
    const entry = catalog.find((entry) => entry.kind === "action")!;
    const current = user("11111111-1111-4111-8111-111111111111");
    const dispatch = mock<typeof dispatchCapability>(async () => {
      throw new Error("Lost check response");
    });
    const checked = await checkAiCapability({
      conversationId: "conversation-1",
      entry,
      catalog,
      check: { query: "check", input: { id: "original" } },
      authority: {
        actor: { kind: "user", user: current },
        accessSubject: { type: "user", userId: current.id },
        credentialKind: "session",
        scopes: [],
      },
      context: { signal: new AbortController().signal },
      dependencies: { dispatch },
    });
    expect(checked.state).toBe("failed");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(() => aiCapabilityCheckResult(checked)).toThrow("ACTION_OUTCOME_UNKNOWN");
    dispatch.mockClear();
    expect(
      (
        await checkAiCapability({
          conversationId: "c",
          entry,
          catalog,
          check: { query: "send", input: {} },
          authority: {
            actor: { kind: "user", user: current },
            accessSubject: { type: "user", userId: current.id },
            credentialKind: "session",
            scopes: [],
          },
          context: { signal: new AbortController().signal },
          dependencies: { dispatch },
        })
      ).state,
    ).toBe("failed");
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("only done returns success; all other outcomes prohibit blind Action retries", () => {
    expect(aiCapabilityCheckResult({ state: "done", receipt: { text: "Queued" } })).toEqual({
      data: null,
      receipt: { text: "Queued" },
      outcomeCheck: "done",
      message: "The app's check confirmed the Action happened. Do not run it again.",
    });
    expect(() => aiCapabilityCheckResult({ state: "not_done" })).toThrow(
      "ACTION_NOT_DONE: The app's check confirmed nothing happened. Ask the person before trying again.",
    );
    expect(() => aiCapabilityCheckResult({ state: "pending" })).toThrow(
      "ACTION_OUTCOME_UNKNOWN: The app does not know the outcome yet. Do not retry the Action.",
    );
  });
});
