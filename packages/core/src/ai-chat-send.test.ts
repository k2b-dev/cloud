import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { aiConversations } from "@k2b/cloud/ai";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { CODE_BOUND_CHAT_ID } from "@k2b/cloud/code";
import { CapabilityActionCallReviewSchema, type CapabilityExecutionContext, type User } from "@k2b/cloud/contracts";
import { nestedInvocationLeases } from "@k2b/cloud/services/identity";
import { aiChatSendAction, aiChatSendInput } from "./ai-chat-send";
import * as chatAuthority from "./ai-code-chat";
import { aiCapabilities } from "./capabilities";
import * as chatBinding from "./code/chat-binding";

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
  authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, credentialKind: "session", scopes: [] },
  locale: "en",
  origin: "http",
  requestId: "request",
  target: { type: "core.ai.chat", id: "Chat23" },
  signal: new AbortController().signal,
};
afterEach(() => mock.restore());
test("one reviewed, idempotent writer replaces all four old contracts", () => {
  const manifest = compileCapabilityManifest("core", aiCapabilities);
  expect(manifest.actions.find((action) => action.localId === "ai.chat.send")).toMatchObject({
    target: "ai.chat",
    idempotency: "required",
    review: true,
  });
  for (const id of ["ai.chat.run", "ai.chat.deliver", "ai.chat.message"])
    expect(manifest.actions.some((a) => a.localId === id)).toBeFalse();
  expect(manifest.queries.some((q) => q.localId === "ai.chat.run.read")).toBeFalse();
});
test("text and context are closed and bounded independently", () => {
  for (const value of [
    { text: " " },
    { text: "x".repeat(10001) },
    { text: "Hi", context: "x".repeat(10001) },
    { text: "Hi", origin: { kind: "person", id: user.id } },
    { prompt: "Hi" },
  ])
    expect(aiChatSendInput.safeParse(value).success).toBeFalse();
  expect(aiChatSendInput.safeParse({ text: "Hi", context: "x".repeat(10000) }).success).toBeTrue();
});
test("an unrestricted signed-in person has authority; missing authority and limited credentials fail closed", async () => {
  expect(await chatAuthority.chatWriteAuthority(context, sql)).toMatchObject({
    ok: true,
    data: { origin: { kind: "person", id: user.id } },
  });
  for (const authority of [
    undefined,
    { ...context.authority!, credentialKind: "oauth" as const },
    { ...context.authority!, scopes: ["read"] },
  ])
    expect(await chatAuthority.chatWriteAuthority({ ...context, authority }, sql)).toMatchObject({
      ok: false,
      error: { code: "source_restricted" },
    });
  expect(await chatAuthority.chatWriteAuthority({ ...context, origin: "mcp" }, sql)).toMatchObject({
    ok: false,
    error: { code: "source_restricted" },
  });
  expect(await chatAuthority.chatWriteAuthority({ ...context, origin: "assistant" }, sql)).toMatchObject({
    ok: false,
    error: { code: "source_restricted" },
  });
  expect(await chatAuthority.chatWriteAuthority({ ...context, actor: { kind: "user", user, sessionKind: "app" } }, sql)).toMatchObject({
    ok: false,
    error: { code: "source_restricted" },
  });
  expect(
    await chatAuthority.chatWriteAuthority({ ...context, accessSubject: { type: "service_account", serviceAccountId: user.id } }, sql),
  ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
});
const fromTurn = (): CapabilityExecutionContext => ({
  ...context,
  origin: "assistant",
  actor: {
    kind: "user",
    user,
    delegation: {
      kind: "invocation",
      credentialKind: "session",
      callingAppId: "core",
      invocationId: "source-invocation",
    },
  },
});
const source = { conversationId: "4f000000-0000-4000-8000-000000000008", turnId: "4f000000-0000-4000-8000-000000000009" };
const sourceChat: Awaited<ReturnType<typeof aiConversations.createConversation>> = {
  id: source.conversationId,
  shortId: "Source",
  title: "Source",
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  archivedAt: null,
  done: false,
  isDone: false,
  lastUsedAt: "2026-11-15T09:00:00Z",
  runStatus: "running",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: user.id,
  createdAt: "2026-11-15T09:00:00Z",
  updatedAt: "2026-11-15T09:00:00Z",
};
const sourceTurn: NonNullable<Awaited<ReturnType<typeof aiConversations.getTurn>>> = {
  id: source.turnId,
  shortId: "Turn23",
  conversationId: source.conversationId,
  status: "running",
  attempt: 1,
  modelId: "fixture",
  createdAt: "2026-11-15T09:00:00Z",
  completedAt: null,
  error: null,
};
test("Gustav and code_run use verified turn coordinates, and absent or foreign initiators cannot chain", async () => {
  spyOn(aiConversations, "getTurn").mockResolvedValue(sourceTurn);
  spyOn(nestedInvocationLeases, "read").mockResolvedValue({
    appId: "core",
    origin: "assistant",
    deadline: 9999999999999,
    assistantTurn: source,
  });
  spyOn(aiConversations, "getConversation").mockResolvedValue(sourceChat);
  const config = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({
    kind: "chat",
    input: "Hi",
    writerOrigin: { kind: "person", id: user.id },
    turnTrigger: { kind: "person", id: user.id },
  });
  expect(await chatAuthority.chatWriteAuthority(fromTurn(), sql)).toMatchObject({
    ok: true,
    data: { origin: { kind: "chat", id: "Source" } },
  });
  for (const turnTrigger of [
    undefined,
    { kind: "automation" as const, id: "c_brief" },
    { kind: "chat" as const, id: "Source" },
    { kind: "person" as const, id: "someone-else" },
  ]) {
    config.mockResolvedValue({ kind: "chat", input: "Hi", writerOrigin: { kind: "person", id: user.id }, turnTrigger });
    expect(await chatAuthority.chatWriteAuthority(fromTurn(), sql)).toMatchObject({ ok: false, error: { code: "chat_chain_forbidden" } });
  }
  config.mockResolvedValue({
    kind: "chat",
    input: "Hi",
    turnTrigger: { kind: "person", id: user.id },
    writerOrigin: { kind: "chat", id: "Other", turnId: "OtherTurn" },
  });
  expect(await chatAuthority.chatWriteAuthority(fromTurn(), sql)).toMatchObject({ ok: true });
});
test("app-source turns and every tool boundary, including an empty list, cannot widen their authority", async () => {
  spyOn(aiConversations, "getTurn").mockResolvedValue(sourceTurn);
  spyOn(nestedInvocationLeases, "read").mockResolvedValue({
    appId: "core",
    origin: "assistant",
    deadline: 9999999999999,
    assistantTurn: source,
  });
  const chat = spyOn(aiConversations, "getConversation");
  const config = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({
    kind: "chat",
    input: "Hi",
    writerOrigin: { kind: "person", id: user.id },
    turnTrigger: { kind: "person", id: user.id },
  });
  for (const allowedTools of [[], ["core.ai.chat.send"]]) {
    chat.mockResolvedValue({ ...sourceChat, allowedTools });
    expect(await chatAuthority.chatWriteAuthority(fromTurn(), sql)).toMatchObject({ ok: false, error: { code: "source_restricted" } });
  }
  chat.mockResolvedValue(sourceChat);
  config.mockResolvedValue({
    kind: "chat",
    input: "Hi",
    writerOrigin: { kind: "person", id: user.id },
    turnTrigger: { kind: "person", id: user.id },
    actor: { kind: "user", user, sessionKind: "app" },
  });
  expect(await chatAuthority.chatWriteAuthority(fromTurn(), sql)).toMatchObject({ ok: false, error: { code: "source_restricted" } });
});
test.each(["en", "de"])("review shows the exact target, complete text and data in %s", async (locale) => {
  spyOn(chatAuthority, "ownedActiveChat").mockResolvedValue({
    id: source.conversationId,
    short_id: "Target",
    title: "Morning",
    project_id: null,
  });
  const text = "A complete message. ".repeat(450);
  const review = await aiChatSendAction.review({ text, context: "123" }, { ...context, locale });
  expect(review).toMatchObject({
    ok: true,
    data: {
      locale,
      view: {
        blocks: [
          {
            context: [{ value: "Morning (Target)" }],
            fields: [
              { name: "text", value: text },
              { name: "context", value: "123" },
            ],
          },
        ],
      },
    },
  });
  if (!review.ok) throw new Error("Missing review");
  expect(CapabilityActionCallReviewSchema.safeParse(review.data).success).toBeTrue();
});

test.each(["en", "de"])("review and run report unavailable resolved targets consistently in %s", async (locale) => {
  const source = spyOn(chatAuthority, "chatWriteAuthority").mockResolvedValue({
    ok: true,
    data: { origin: { kind: "person", id: user.id }, turnTrigger: { kind: "person", id: user.id }, code: null },
  });
  const resolve = spyOn(chatBinding, "resolveCodeChatDestination");
  const lookup = spyOn(chatAuthority, "ownedActiveChat").mockResolvedValue(null);
  for (const targetId of ["Literal433", CODE_BOUND_CHAT_ID]) {
    resolve.mockResolvedValue({
      ok: true,
      data: { chatId: "Resolved433", binding: targetId === CODE_BOUND_CHAT_ID ? { codeId: "c_fixture", revision: 2 } : null },
    });
    const ctx = { ...context, locale, idempotencyKey: "unavailable", target: { type: "core.ai.chat", id: targetId } };
    for (const phase of ["review", "run"] as const) {
      lookup.mockClear();
      expect(await aiChatSendAction[phase]({ text: "Review the facts" }, ctx)).toEqual({
        ok: false,
        error: {
          code: "chat_unavailable",
          status: 409,
          message:
            locale === "de"
              ? "Dieser Chat ist nicht verfügbar. Wähle einen eigenen aktiven Chat oder stelle den archivierten Chat wieder her."
              : "This chat is unavailable. Choose one of your active chats or restore the archived chat.",
        },
      });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledWith(user.id, "Resolved433", sql);
    }
  }
  expect(source).toHaveBeenCalledTimes(4);
  expect(resolve).toHaveBeenCalledTimes(4);
  lookup.mockClear();
  resolve.mockResolvedValue({ ok: false, error: { code: "chat_unavailable", status: 409, message: "Internal resolver message" } });
  for (const phase of ["review", "run"] as const) {
    expect(
      await aiChatSendAction[phase](
        { text: "Review the facts" },
        { ...context, locale, idempotencyKey: "unavailable", target: { type: "core.ai.chat", id: CODE_BOUND_CHAT_ID } },
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "chat_unavailable",
        status: 409,
        message:
          locale === "de"
            ? "Dieser Chat ist nicht verfügbar. Wähle einen eigenen aktiven Chat oder stelle den archivierten Chat wieder her."
            : "This chat is unavailable. Choose one of your active chats or restore the archived chat.",
      },
    });
  }
  expect(lookup).not.toHaveBeenCalled();
});
