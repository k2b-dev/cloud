import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { AiTurn } from "@k2b/cloud/ai";
import { aiConversations, aiTurnAllowsWebsiteApprovals } from "@k2b/cloud/ai";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { aiChatRunAction, aiChatRunReadQuery } from "./ai-chat-run";
import { aiCapabilities } from "./capabilities";

test("personal Code can discover the chat run Action with required idempotency", () => {
  const manifest = compileCapabilityManifest("core", aiCapabilities);
  expect(manifest.actions.find((action) => action.localId === "ai.chat.run")).toMatchObject({
    target: "ai.chat",
    idempotency: "required",
    review: true,
  });
  expect(aiCapabilities.actions["ai.chat.run"].policy).toEqual({ silent: "you" });
});

test("the chat turn input is closed and bounded", () => {
  const input = aiCapabilities.actions["ai.chat.run"].input;
  expect(input.safeParse({ prompt: " " }).success).toBeFalse();
  expect(input.safeParse({ prompt: "x".repeat(10_001) }).success).toBeFalse();
  expect(input.safeParse({ prompt: "Review", context: "x".repeat(10_001) }).success).toBeFalse();
  expect(input.safeParse({ prompt: "Review", ownerUserId: "another" }).success).toBeFalse();
  expect(input.safeParse({ prompt: "Review", context: "x".repeat(10_000) }).success).toBeTrue();
});

const user: User = {
  id: "4f000000-0000-4000-8000-000000000001",
  uid: "owner",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Code",
  sn: "Owner",
  displayName: "Code Owner",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const context: CapabilityExecutionContext = {
  actor: { kind: "user", user },
  user,
  accessSubject: { type: "user", userId: user.id },
  locale: "en",
  origin: "http",
  requestId: "request",
  target: { type: "core.ai.chat", id: "Chat23" },
  signal: new AbortController().signal,
};
const turn: AiTurn = {
  id: "4f000000-0000-4000-8000-000000000002",
  shortId: "Turn23",
  conversationId: "chat",
  status: "queued",
  attempt: 1,
  modelId: "fixture",
  createdAt: "2026-11-07T12:00:00Z",
  completedAt: null,
  error: null,
  codeOrigin: {
    codeId: "c_morning",
    title: "Morning",
    runId: "4f000000-0000-4000-8000-000000000003",
    requestId: "request",
    label: "Started by Code Morning",
  },
};
afterEach(() => mock.restore());

test("a trusted personal Code turn retains owner chat approvals without a browser-session marker", () => {
  const config = { kind: "chat" as const, input: "Review", actor: { kind: "user" as const, user }, codeOrigin: turn.codeOrigin };
  expect(aiTurnAllowsWebsiteApprovals(config)).toBeTrue();
  expect(aiTurnAllowsWebsiteApprovals({ ...config, codeOrigin: undefined })).toBeFalse();
  expect(aiTurnAllowsWebsiteApprovals({ ...config, mandate: { id: turn.id, revision: 1 } })).toBeFalse();
  expect(aiTurnAllowsWebsiteApprovals({ ...config, background: { taskId: "task01", occurrenceId: "run001", context: [] } })).toBeFalse();
  expect(
    aiTurnAllowsWebsiteApprovals({
      ...config,
      actor: {
        kind: "user",
        user,
        delegation: {
          kind: "invocation",
          credentialKind: "mandate",
          callingAppId: "core",
          invocationId: "delegated",
        },
      },
    }),
  ).toBeFalse();
});

test("ordinary users and a resource subject cannot start a Code turn", async () => {
  expect(await aiChatRunAction.run({ prompt: "Review" }, context)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  expect(await aiChatRunAction.review({ prompt: "Review" }, context)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  expect(
    await aiChatRunAction.run({ prompt: "Review" }, { ...context, accessSubject: { type: "service_account", serviceAccountId: user.id } }),
  ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
});

test.each(["queued", "running", "waiting_for_action", "completed", "failed", "aborted"] as const)(
  "state snapshot exposes %s and Code provenance without starting work",
  async (status) => {
    // The conversation reader remains the authority boundary, including for later runs of this person's Code.
    spyOn(aiConversations, "getConversationByShortId").mockResolvedValue(null);
    expect(await aiChatRunReadQuery.run({ id: turn.shortId }, context)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const { getConversationByShortId } = aiConversations;
    expect(getConversationByShortId).toHaveBeenCalledWith({ shortId: "Chat23", ownerUserId: user.id });
    const projected = { ...turn, status, error: status === "failed" ? "The owner allowance is exhausted." : null };
    spyOn(aiConversations, "getConversationByShortId").mockResolvedValue({
      id: "chat",
      shortId: "Chat23",
      title: "Morning",
      titleSource: "user",
      description: "",
      descriptionSource: "user",
      keywords: [],
      pinnedAt: null,
      archivedAt: null,
      done: null,
      isDone: false,
      lastUsedAt: turn.createdAt,
      runStatus: "idle",
      runError: null,
      unreadCompletion: false,
      projectId: null,
      draft: { content: [], revision: 0, updatedAt: null },
      createdByUserId: user.id,
      createdAt: turn.createdAt,
      updatedAt: turn.createdAt,
    });
    spyOn(aiConversations, "getTurnByShortId").mockResolvedValue(projected);
    spyOn(aiConversations, "getTurn").mockResolvedValue(projected);
    spyOn(aiConversations, "listPendingTurnActions").mockResolvedValue([
      {
        type: "approval_request",
        turnId: turn.id,
        conversationId: turn.conversationId,
        callId: "approval",
        name: "approval_probe",
        args: {},
        allowAlways: true,
        allowChat: true,
      },
    ]);
    const result = await aiChatRunReadQuery.run({ id: turn.shortId }, context);
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: {
          id: turn.shortId,
          status: status === "aborted" ? "failed" : status === "waiting_for_action" ? "waiting_for_approval" : status,
          reason: status === "aborted" ? "aborted" : projected.error,
          origin: turn.codeOrigin,
        },
      },
    });
    if (result.ok) expect(aiChatRunAction.data.safeParse(result.data.data).success).toBeTrue();
  },
);
