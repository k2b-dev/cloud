import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { aiConversations, aiProjects } from "@k2b/cloud/ai";
import { AiConversationCreationError } from "@k2b/cloud/ai/runtime";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { CapabilityActionCallReviewSchema, type CapabilityExecutionContext, type User } from "@k2b/cloud/contracts";
import { accounts } from "@k2b/cloud/services";
import { aiChatCreateAction, aiChatCreateInput } from "./ai-chat-create";
import { aiCapabilities } from "./capabilities";

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
  idempotencyKey: "new-weekly-chat",
  signal: new AbortController().signal,
};
afterEach(() => mock.restore());
const chat: Awaited<ReturnType<typeof aiConversations.createConversation>> = {
  id: "4f000000-0000-4000-8000-000000000008",
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
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: user.id,
  createdAt: "2026-11-15T09:00:00Z",
  updatedAt: "2026-11-15T09:00:00Z",
};

test("creation is an untargeted reviewed silent-you Action with a required key", () => {
  const manifest = compileCapabilityManifest("core", aiCapabilities);
  const action = manifest.actions.find((entry) => entry.localId === "ai.chat.create");
  expect(action).toMatchObject({ idempotency: "required", review: true, approval: "rememberable" });
  expect(action?.target).toBeUndefined();
  expect(aiChatCreateAction.policy).toEqual({ silent: "you" });
  for (const input of [
    { title: " " },
    { title: "x".repeat(201) },
    { title: "Hi", chatId: "Chat23" },
    { title: "Hi", project: { type: "core.ai.chat", id: "Chat23" } },
  ])
    expect(aiChatCreateInput.safeParse(input).success).toBe(false);
});
test.each(["de", "en"])("review shows the complete proposed title in %s", async (locale) => {
  const input = { title: "Weekly briefing" };
  const review = await aiChatCreateAction.review(input, { ...context, locale });
  expect(review.ok).toBe(true);
  if (!review.ok) throw new Error(review.error.message);
  expect(CapabilityActionCallReviewSchema.safeParse(review.data).success).toBe(true);
  expect(review.data).toMatchObject({
    reach: "you",
    locale,
    view: { blocks: [{ kind: "Draft", fields: [{ name: "title", value: input.title }] }] },
  });
});
test("run uses the shared creation receipt with a stable account-and-operation key", async () => {
  spyOn(accounts.users, "get").mockResolvedValue(user);
  const create = spyOn(aiConversations, "createConversation").mockResolvedValue(chat);
  const first = await aiChatCreateAction.run({ title: "Weekly briefing" }, context);
  expect(first).toMatchObject({
    ok: true,
    data: { data: { chat: { type: "core.ai.chat", id: chat.shortId }, open: expect.stringContaining(chat.shortId) } },
  });
  const request = create.mock.calls[0]?.[0];
  expect(request?.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await aiChatCreateAction.run({ title: "Weekly briefing" }, { ...context, requestId: "another transport request" });
  expect(create.mock.calls[1]?.[0].requestId).toBe(request?.requestId);
  await aiChatCreateAction.run({ title: "Weekly briefing" }, { ...context, idempotencyKey: "another chat" });
  expect(create.mock.calls[2]?.[0].requestId).not.toBe(request?.requestId);
});
test("restricted authority and an inaccessible Project produce no chat", async () => {
  const create = spyOn(aiConversations, "createConversation").mockResolvedValue(chat);
  expect(await aiChatCreateAction.run({ title: "Hi" }, { ...context, actor: { kind: "user", user, sessionKind: "app" } })).toMatchObject({
    ok: false,
    error: { code: "source_restricted" },
  });
  spyOn(accounts.users, "get").mockResolvedValue(user);
  spyOn(aiProjects, "getByShortId").mockResolvedValue(null);
  expect(await aiChatCreateAction.run({ title: "Hi", project: { type: "core.ai.project", id: "Prj234" } }, context)).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(create).not.toHaveBeenCalled();
});
test("conflicting and unavailable durable receipts never create a replacement", async () => {
  spyOn(accounts.users, "get").mockResolvedValue(user);
  const create = spyOn(aiConversations, "createConversation").mockRejectedValue(new AiConversationCreationError("conflict"));
  expect(await aiChatCreateAction.run({ title: "Changed" }, context)).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
  create.mockRejectedValue(new AiConversationCreationError("unavailable"));
  expect(await aiChatCreateAction.run({ title: "Original" }, context)).toMatchObject({
    ok: false,
    error: { code: "chat_unavailable", status: 409 },
  });
});

test.each(["Familie 👨‍👩‍👧", "Plan\tQ4", "\u200d"])("review accepts a title containing format or control characters: %s", async (title) => {
  const review = await aiChatCreateAction.review({ title }, { ...context, locale: "de" });
  expect(review.ok).toBe(true);
  if (!review.ok) throw new Error(review.error.message);
  expect(CapabilityActionCallReviewSchema.safeParse(review.data).success).toBe(true);
  expect(review.data.view.blocks[0]?.fields[0]?.value).toBe(title);
});
test("a Project removed during creation returns not found", async () => {
  spyOn(accounts.users, "get").mockResolvedValue(user);
  spyOn(aiConversations, "createConversation").mockRejectedValue(new AiConversationCreationError("project_unavailable"));
  expect(await aiChatCreateAction.run({ title: "New chat" }, context)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

test("replay checks the current Project after the original chat was moved", async () => {
  spyOn(accounts.users, "get").mockResolvedValue(user);
  spyOn(aiConversations, "createConversation").mockResolvedValue({ ...chat, projectId: "4f000000-0000-4000-8000-000000000009" });
  const read = spyOn(aiProjects, "get").mockResolvedValue(null);
  expect(await aiChatCreateAction.run({ title: "New chat" }, context)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  expect(read).toHaveBeenCalledWith("4f000000-0000-4000-8000-000000000009", context, "read");
});
