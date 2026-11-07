import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import {
  type AiConversation,
  type AiInterChatMessage,
  AiResourceCredentialError,
  type AiSkill,
  AiSkillAppForbiddenError,
  type AiStoredMessage,
  aiCapabilityId,
  aiConversations,
  aiSkills,
} from "@k2b/cloud/ai";
import { assertResourceOpenLink, compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import {
  type CapabilityActionDefinition,
  CapabilityActionReviewSchema,
  type CapabilityExecutionContext,
  type CapabilityInvocationResult,
  capabilityResultSchema,
  type User,
} from "@k2b/cloud/contracts";
import * as accessService from "@k2b/cloud/server";
import { accessRevision, type RequestAuthority } from "@k2b/cloud/server";
import { accountsAppService, audit } from "@k2b/cloud/services";
import { aiCapabilities } from "./capabilities";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "assistant-capabilities",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Assistant",
  sn: "User",
  displayName: "Assistant User",
  mail: "assistant@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};

const authority: RequestAuthority = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  credentialKind: "session",
  scopes: [],
};
const context: CapabilityExecutionContext = {
  authority,
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  user,
  locale: "en",
  requestId: "core-capability-test-request",
  target: { type: "core.ai.skill", id: "sKp234" },
  origin: "assistant",
  signal: new AbortController().signal,
};

const idempotentContext: CapabilityExecutionContext = { ...context, idempotencyKey: "core-capability-test-key" };

const chat: AiConversation = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "cHt234",
  title: "Release planning",
  titleSource: "user",
  description: "Plan the next Cloud release.",
  descriptionSource: "auto",
  keywords: ["release", "cloud"],
  pinnedAt: null,
  archivedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "2026-08-04T13:00:00.000Z",
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: user.id,
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T13:00:00.000Z",
};

const skill: AiSkill = {
  source: null,
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  shortId: "sKp234",
  name: "weekly-status",
  description: "Create a concise weekly status report when the user asks for a progress summary.",
  instructions: "Summarize wins, blockers, and next steps.",
  extraFrontmatter: {},
  references: [{ path: "references/style.md", content: "Keep the report concise." }],
  permission: "admin",
  enabled: true,
  revision: 1,
  manualOnly: false,
  referenceCount: 1,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt,
};

const storedMessage = (seq: number, message: AiStoredMessage["message"], overrides: Partial<AiStoredMessage> = {}): AiStoredMessage => ({
  id: `${seq.toString().padStart(8, "0")}-0000-4000-8000-000000000000`,
  shortId: `mSg23${seq + 1}`,
  conversationId: chat.id,
  seq,
  kind: "message",
  message,
  loopId: null,
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: `2026-08-04T12:00:0${seq}.000Z`,
  ...overrides,
});

beforeEach(() => setSystemTime(new Date("2026-04-07T09:00:00.000Z")));
afterEach(() => {
  mock.restore();
  setSystemTime();
});

describe("Core AI capabilities", () => {
  test("recipient discovery preserves actor visibility and returns directly usable principals", async () => {
    const list = spyOn(accountsAppService.entity, "list").mockResolvedValue({
      items: [{ kind: "user", user }],
      page: 2,
      perPage: 1,
      hasNext: true,
      total: 3,
    });
    const result = await aiCapabilities.queries["entities.search"].run(
      { query: "Assistant", types: ["user"], cursor: "2", limit: 1 },
      context,
    );
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { userId: user.id, uid: user.uid, roles: user.roles, provider: user.provider },
        pagination: { page: 2, perPage: 1 },
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: { data: [{ principal: { type: "user", userId: user.id }, label: user.displayName }], page: { nextCursor: "3" } },
    });
  });

  test("Skill access changes require a fresh review and pass the exact grant revision to the owning service", async () => {
    spyOn(aiSkills, "getByShortId").mockResolvedValue(skill);
    const grants = [
      {
        id: "AbC234",
        shortId: "AbC234",
        principal: { type: "user" as const, userId: user.id },
        permission: "admin" as const,
        createdAt: "",
      },
    ];
    spyOn(aiSkills, "listAccess").mockResolvedValue(grants);
    const update = spyOn(aiSkills, "updateAccess").mockResolvedValue(true);
    spyOn(accessService, "resolveDisplayNames").mockImplementation(async (entries) =>
      entries.map((entry) => ({ ...entry, displayName: "Alice Example" })),
    );
    const operation = aiCapabilities.actions["ai.skill.access.change"];
    const input = {
      accessId: "AbC234",
      permission: "read" as const,
      expectedAccessRevision: accessRevision(grants),
    };
    const manifest = compileCapabilityManifest("core", aiCapabilities);
    expect(manifest.actions.find((action) => action.localId === "ai.skill.access.change")?.approval).toBeUndefined();
    expect(await operation.review(input, context)).toMatchObject({
      ok: true,
      data: {
        details: expect.arrayContaining([
          { label: "Before", value: "Manage" },
          { label: "After", value: "View" },
        ]),
      },
    });
    expect(JSON.stringify(await operation.review(input, context))).toContain("Alice Example");
    expect(JSON.stringify(await operation.review(input, context))).toContain(user.id);
    expect(await operation.review({ ...input, expectedAccessRevision: "0".repeat(64) }, context)).toMatchObject({ ok: false });
    expect(update).not.toHaveBeenCalled();
    expect(await operation.run(input, context)).toMatchObject({ ok: true, data: { data: { changed: true } } });
    expect(update).toHaveBeenCalledWith(skill.id, "AbC234", context, "read", input.expectedAccessRevision, authority);
    expect(operation.input.safeParse({ ...input, confirmed: true }).success).toBe(false);
    const { accessId: _accessId, ...newGrant } = input;
    expect(operation.input.safeParse({ ...newGrant, principal: { type: "public" } }).success).toBe(false);
    expect(operation.input.safeParse({ ...newGrant, principal: { type: "authenticated" } }).success).toBe(true);
  });

  test("lists and reads only permission-filtered Skills with stable refs", async () => {
    const list = spyOn(aiSkills, "list").mockResolvedValue([
      skill,
      { ...skill, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", shortId: "sKp567", name: "disabled-skill", enabled: false },
    ]);
    const get = spyOn(aiSkills, "getByShortId").mockResolvedValue(skill);

    const listed = await aiCapabilities.queries["ai.skills.list"].run({ query: "weekly", enabled: true, limit: 20 }, context);
    const read = await aiCapabilities.queries["ai.skill.read"].run({ id: skill.shortId }, context);
    const reference = await aiCapabilities.queries["ai.skill.reference.read"].run(
      { skillId: skill.shortId, path: "references/style.md" },
      context,
    );

    expect(list).toHaveBeenCalledWith(context, { authority });
    expect(listed).toMatchObject({
      ok: true,
      data: {
        data: [{ id: skill.shortId, ref: { type: "core.ai.skill", id: skill.shortId } }],
        refs: [{ type: "core.ai.skill", id: skill.shortId }],
      },
    });
    expect(read).toMatchObject({ ok: true, data: { data: { id: skill.shortId, references: [{ path: "references/style.md" }] } } });
    expect(reference).toMatchObject({
      ok: true,
      data: { data: { skillId: skill.shortId, path: "references/style.md", content: "Keep the report concise." } },
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("Skill readers retain scoped authority and hide denied app content", async () => {
    const restricted: RequestAuthority = { ...authority, credentialKind: "oauth", scopes: ["other:read"] };
    const scopedContext = { ...context, authority: restricted };
    const list = spyOn(aiSkills, "list").mockImplementation(async (_subject, options) =>
      options?.authority === restricted ? [] : [skill],
    );
    const get = spyOn(aiSkills, "getByShortId").mockImplementation(async (_id, _subject, _permission, received) =>
      received === restricted ? null : skill,
    );
    const write = spyOn(aiSkills, "update");
    const results = [
      await aiCapabilities.queries["ai.skills.list"].run({ query: "", limit: 20 }, scopedContext),
      await aiCapabilities.queries["ai.skill.read"].run({ id: skill.shortId }, scopedContext),
      await aiCapabilities.queries["ai.skill.reference.read"].run({ skillId: skill.shortId, path: "references/style.md" }, scopedContext),
      await aiCapabilities.queries["ai.skill.access.read"].run({ skillId: skill.shortId }, scopedContext),
      await aiCapabilities.actions["ai.skill.update"].review!({ expectedRevision: 1, instructions: "Changed." }, scopedContext),
      await aiCapabilities.actions["ai.skill.update"].run({ expectedRevision: 1, instructions: "Changed." }, scopedContext),
    ];
    expect(list).toHaveBeenCalledWith(scopedContext, { authority: restricted });
    for (const call of get.mock.calls) expect(call[3]).toBe(restricted);
    expect(JSON.stringify(results)).not.toContain(skill.name);
    expect(JSON.stringify(results)).not.toContain(skill.instructions);
    expect(write).not.toHaveBeenCalled();
  });

  test("includes source app metadata in discovery and reads", async () => {
    const supplied = { ...skill, source: { appId: "inventory", appName: "Inventory" } };
    spyOn(aiSkills, "list").mockResolvedValue([supplied]);
    spyOn(aiSkills, "getByShortId").mockResolvedValue(supplied);
    expect(await aiCapabilities.queries["ai.skills.list"].run({ query: "", limit: 20 }, context)).toMatchObject({
      ok: true,
      data: { data: [{ source: supplied.source }] },
    });
    expect(await aiCapabilities.queries["ai.skill.read"].run({ id: supplied.shortId }, context)).toMatchObject({
      ok: true,
      data: { data: { source: supplied.source } },
    });
  });
  test("returns the app override error as forbidden for capability reviews and mutations", async () => {
    spyOn(aiSkills, "getByShortId").mockRejectedValue(new AiSkillAppForbiddenError("Inventory"));
    const input = { expectedRevision: skill.revision, instructions: "Reviewed update" };
    for (const result of [
      await aiCapabilities.actions["ai.skill.update"].review!(input, context),
      await aiCapabilities.actions["ai.skill.update"].run(input, context),
      await aiCapabilities.actions["ai.skill.delete"].review!({}, context),
      await aiCapabilities.actions["ai.skill.delete"].run({}, idempotentContext),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN", status: 403 } });
      if (!result.ok) expect(result.error.message).toContain("Inventory");
    }
  });

  test("reviews and executes Skill mutations through the permission-aware service", async () => {
    const get = spyOn(aiSkills, "getByShortId").mockResolvedValue(skill);
    const create = spyOn(aiSkills, "create").mockResolvedValue(skill);
    const update = spyOn(aiSkills, "update").mockResolvedValue({ ...skill, description: "Updated description.", revision: 2 });
    const setReference = spyOn(aiSkills, "setReference").mockResolvedValue({ ...skill, revision: 2 });
    const setReferences = spyOn(aiSkills, "setReferences").mockResolvedValue({ ...skill, revision: 2 });
    const removeReference = spyOn(aiSkills, "removeReference").mockResolvedValue({
      ...skill,
      references: [],
      referenceCount: 0,
      revision: 2,
    });
    const setEnabled = spyOn(aiSkills, "setEnabled").mockResolvedValue(false);
    const remove = spyOn(aiSkills, "delete").mockResolvedValue(true);
    spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async ({ result }) => result);

    const updateReview = await aiCapabilities.actions["ai.skill.update"].review!(
      { expectedRevision: 1, description: "Updated description." },
      context,
    );
    expect(updateReview).toMatchObject({
      ok: true,
      data: { details: [{ label: "Description", value: "Updated description." }] },
    });

    const results = {
      "ai.skill.create": await aiCapabilities.actions["ai.skill.create"].run(
        { name: skill.name, description: skill.description, instructions: skill.instructions },
        context,
      ),
      "ai.skill.update": await aiCapabilities.actions["ai.skill.update"].run(
        { expectedRevision: 1, description: "Updated description." },
        context,
      ),
      "ai.skill.reference.set": await aiCapabilities.actions["ai.skill.reference.set"].run(
        { expectedRevision: 1, path: "references/style.md", content: "Keep it concise." },
        context,
      ),
      "ai.skill.references.set": await aiCapabilities.actions["ai.skill.references.set"].run(
        {
          expectedRevision: 1,
          references: [
            { path: "references/style.md", content: "Keep it concise." },
            { path: "references/tone.md", content: "Use a direct tone." },
          ],
        },
        context,
      ),
      "ai.skill.reference.remove": await aiCapabilities.actions["ai.skill.reference.remove"].run(
        { expectedRevision: 1, path: "references/style.md" },
        context,
      ),
      "ai.skill.enabled.set": await aiCapabilities.actions["ai.skill.enabled.set"].run({ enabled: false }, context),
      "ai.skill.delete": await aiCapabilities.actions["ai.skill.delete"].run({}, idempotentContext),
    };

    for (const mutation of [create, update, setReference, setReferences, removeReference, setEnabled, remove]) {
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(mutation.mock.calls[0]?.at(-1)).toBe(authority);
    }
    for (const [localId, result] of Object.entries(results)) {
      expect(result.ok).toBeTrue();
      if (!result.ok) continue;
      const action = (aiCapabilities.actions as unknown as Record<string, CapabilityActionDefinition>)[localId];
      if (!action) throw new Error(`Missing Core action ${localId}`);
      const parsed = capabilityResultSchema(action.data).safeParse(result.data);
      expect(parsed.success).toBeTrue();
      // A deleted Skill has nothing left to open, so its result names no ref.
      expect(parsed.data?.refs).toEqual(
        localId === "ai.skill.delete" ? undefined : [{ type: "core.ai.skill", id: skill.shortId, title: skill.name }],
      );
    }
    expect(setReferences).toHaveBeenCalledWith(
      skill.id,
      context,
      {
        expectedRevision: 1,
        references: [
          { path: "references/style.md", content: "Keep it concise." },
          { path: "references/tone.md", content: "Use a direct tone." },
        ],
      },
      authority,
    );
    expect(get).toHaveBeenCalledWith(skill.shortId, idempotentContext, "admin", authority);
  });

  test("writes the request id of an irreversible Skill delete into the audit row", async () => {
    spyOn(aiSkills, "getByShortId").mockResolvedValue(skill);
    spyOn(aiSkills, "delete").mockResolvedValue(true);
    const recorded = spyOn(audit, "recordResultAfterSideEffect").mockImplementation(async ({ result }) => result);

    const missingKey = await aiCapabilities.actions["ai.skill.delete"].run({}, context);
    expect(missingKey).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });

    const deleted = await aiCapabilities.actions["ai.skill.delete"].run({}, idempotentContext);

    expect(deleted.ok).toBeTrue();
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded.mock.calls[0]?.[0]).toMatchObject({
      action: "core.capability.ai.skill.delete",
      requestId: idempotentContext.requestId,
      target: { type: "ai_skill", id: skill.id },
    });
  });

  test("searches only the current user's chats and returns an open link", async () => {
    const list = spyOn(aiConversations, "listConversations").mockResolvedValue([chat]);

    const result = await aiCapabilities.queries["ai.chats.search"].run({ query: "release", archived: false, limit: 10 }, context);

    expect(list).toHaveBeenCalledWith({
      ownerUserId: user.id,
      search: "release",
      refs: undefined,
      archived: false,
      limit: 10,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: [
          {
            ref: { type: "core.ai.chat", id: chat.shortId },
            title: chat.title,
            links: [{ rel: "open", href: `/app/assistant?conversation=${chat.shortId}` }],
          },
        ],
      },
    });
  });

  test("reads bounded visible text without thinking or tool results", async () => {
    const longText = "x".repeat(8_001);
    const get = spyOn(aiConversations, "getConversationByShortId").mockResolvedValue(chat);
    const listMessages = spyOn(aiConversations, "listMessagesPage").mockResolvedValue({
      messages: [
        storedMessage(1, { role: "user", content: [{ type: "text", text: "Please plan it." }] }),
        storedMessage(2, {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "text", text: longText },
            { type: "tool_call", id: "call-1", name: "mail.search", args: {} },
          ],
        }),
        storedMessage(3, { role: "tool_result", callId: "call-1", name: "mail.search", result: { secret: true } }),
      ],
      hasMore: true,
    });

    const result = await aiCapabilities.queries["ai.chat.read"].run({ id: chat.shortId, limit: 20 }, context);

    expect(get).toHaveBeenCalledWith({ shortId: chat.shortId, ownerUserId: user.id, archived: false });
    expect(get).toHaveBeenCalledTimes(1);
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      data: {
        summary: "Read AI conversation “Release planning”.",
        data: {
          chat: { id: chat.shortId, title: chat.title },
          messages: [
            { seq: 1, role: "user", text: "Please plan it.", truncated: false },
            { seq: 2, role: "assistant", truncated: true },
          ],
        },
        refs: [{ type: "core.ai.chat", id: chat.shortId }],
        links: [{ rel: "open", href: `/app/assistant?conversation=${chat.shortId}` }],
        page: { hasMore: true, nextCursor: "1" },
      },
    });
    if (result.ok) {
      expect(result.data.data.messages[1]?.text).toHaveLength(8_000);
      expect(JSON.stringify(result)).not.toContain("private reasoning");
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  test("searches visible messages in one explicitly owned chat", async () => {
    spyOn(aiConversations, "getConversationByShortId").mockResolvedValue(chat);
    const search = spyOn(aiConversations, "searchConversationMessages").mockResolvedValue({
      messages: [storedMessage(4, { role: "assistant", content: [{ type: "text", text: "The release is Friday." }] })],
      nextCursor: "4",
    });

    const result = await aiCapabilities.queries["ai.chat.search"].run({ chatId: chat.shortId, query: "release", limit: 10 }, context);

    expect(search).toHaveBeenCalledWith({ conversationId: chat.id, query: "release", beforeSeq: undefined, limit: 10 });
    expect(result).toMatchObject({
      ok: true,
      data: { data: { messages: [{ id: "mSg235", role: "assistant", text: "The release is Friday." }] }, page: { nextCursor: "4" } },
    });
  });

  test("lists structured resources in one chat and across owned chats", async () => {
    spyOn(aiConversations, "getConversationByShortId").mockResolvedValue(chat);
    const resource = {
      ref: { type: "notebooks.note", id: "nT1234" },
      title: "Release notes",
      preview: null,
      icon: "ti ti-note",
      href: "/app/notebooks/nB1234/nT1234",
      sourceTurnId: "tRn234",
      sourceCallId: "call-1",
      firstSeenAt: chat.createdAt,
      lastSeenAt: chat.updatedAt,
    };
    const local = spyOn(aiConversations, "listConversationResources").mockResolvedValue({ resources: [resource] });
    const global = spyOn(aiConversations, "listUserConversationResources").mockResolvedValue({
      resources: [{ ...resource, chat: { shortId: chat.shortId, title: chat.title, updatedAt: chat.updatedAt } }],
    });

    const localResult = await aiCapabilities.queries["ai.chat.resources"].run({ chatId: chat.shortId, limit: 20 }, context);
    const globalResult = await aiCapabilities.queries["ai.chats.resources"].run({ query: "release", limit: 20 }, context);

    expect(local).toHaveBeenCalledWith({ conversationId: chat.id, search: undefined, before: undefined, limit: 20 });
    expect(global).toHaveBeenCalledWith({ ownerUserId: user.id, search: "release", before: undefined, limit: 20 });
    expect(localResult).toMatchObject({ ok: true, data: { refs: [resource.ref] } });
    expect(globalResult).toMatchObject({ ok: true, data: { data: [{ ref: resource.ref, chat: { id: chat.shortId } }] } });
  });

  test("reviews the exact inter-chat target and refuses untrusted action origins", async () => {
    spyOn(aiConversations, "getConversationByShortId").mockResolvedValue(chat);
    const review = await aiCapabilities.actions["ai.chat.message"].review!(
      { text: "Please verify it." },
      { ...context, target: { type: "core.ai.chat", id: chat.shortId } },
    );
    expect(review).toMatchObject({
      ok: true,
      data: { message: `Send this message to ${chat.title} (${chat.shortId}).`, details: [{ label: "Target chat" }, { label: "Message" }] },
    });

    const origin = spyOn(aiConversations, "getCapabilityInvocationOrigin").mockResolvedValue(null);
    const result = await aiCapabilities.actions["ai.chat.message"].run(
      { text: "Please verify it." },
      { ...context, idempotencyKey: "ai-test", target: { type: "core.ai.chat", id: chat.shortId } },
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "Inter-chat messages require an AI conversation turn", status: 403 },
    });
    expect(origin).toHaveBeenCalledWith({
      idempotencyKey: "ai-test",
      toolName: aiCapabilityId("core", "ai.chat.message"),
    });
  });

  test("returns the persisted status for an idempotent message retry", async () => {
    spyOn(aiConversations, "getCapabilityInvocationOrigin").mockResolvedValue({
      conversationId: chat.id,
      conversationShortId: chat.shortId,
      turnId: "33333333-3333-4333-8333-333333333333",
      turnShortId: "tRn234",
      callId: "call-1",
    });
    const message: AiInterChatMessage = {
      id: "44444444-4444-4444-8444-444444444444",
      shortId: "aMs234",
      sourceConversationId: chat.id,
      sourceChatId: chat.shortId,
      sourceTitle: chat.title,
      sourceTurnId: "33333333-3333-4333-8333-333333333333",
      sourceTurnShortId: "tRn234",
      sourceCallId: "call-1",
      targetConversationId: "55555555-5555-4555-8555-555555555555",
      targetChatId: "cHt567",
      targetTitle: "Target chat",
      actorUserId: user.id,
      text: "Please verify it.",
      status: "delivered",
      targetTurnId: "66666666-6666-4666-8666-666666666666",
      targetTurnShortId: "tRn567",
      targetMessageId: "77777777-7777-4777-8777-777777777777",
      error: null,
      createdAt: chat.createdAt,
      deliveredAt: chat.updatedAt,
    };
    spyOn(aiConversations, "createInterChatMessage").mockResolvedValue({ ok: true, message });

    const result = await aiCapabilities.actions["ai.chat.message"].run(
      { text: message.text },
      { ...context, idempotencyKey: "ai-test", target: { type: "core.ai.chat", id: chat.shortId } },
    );

    expect(result).toMatchObject({
      ok: true,
      data: { data: { id: message.shortId, status: "delivered" }, summary: "Sent a message to “Target chat”." },
    });
  });

  test("does not reveal missing or other users' chats", async () => {
    spyOn(aiConversations, "getConversationByShortId").mockResolvedValue(null);

    const result = await aiCapabilities.queries["ai.chat.read"].run({ id: chat.shortId, limit: 20 }, context);

    expect(result).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "Chat not found", status: 404 } });
  });

  test("reads an explicitly discovered archived chat without making it a message target", async () => {
    const archived = { ...chat, archivedAt: "2026-08-05T12:00:00.000Z" };
    const get = spyOn(aiConversations, "getConversationByShortId").mockResolvedValueOnce(null).mockResolvedValueOnce(archived);
    spyOn(aiConversations, "listMessagesPage").mockResolvedValue({ messages: [], hasMore: false });

    const result = await aiCapabilities.queries["ai.chat.read"].run({ id: chat.shortId, limit: 20 }, context);

    expect(get).toHaveBeenLastCalledWith({ shortId: chat.shortId, ownerUserId: user.id, archived: true });
    expect(result).toMatchObject({ ok: true, data: { data: { chat: { id: chat.shortId, archived: true } } } });
  });

  test("rejects actors without a delegated user", async () => {
    const list = spyOn(aiConversations, "listConversations");
    const result = await aiCapabilities.queries["ai.chats.search"].run(
      { query: "", archived: false, limit: 10 },
      { ...context, user: null },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "AI conversations require a user-backed actor", status: 403 },
    });
    expect(list).not.toHaveBeenCalled();
  });
});

test("revoking the caller's last Skill access does not offer an unreadable ref or open link", async () => {
  let revoked = false;
  spyOn(aiSkills, "getByShortId").mockImplementation(async () => (revoked ? null : skill));
  spyOn(aiSkills, "revokeAccess").mockImplementation(async () => {
    revoked = true;
    return true;
  });
  const action = aiCapabilities.actions["ai.skill.access.change"];
  const result = await action.run(
    action.input.parse({ accessId: "AbC234", permission: null, expectedAccessRevision: "a".repeat(64) }),
    context,
  );
  expect(result).toEqual({ ok: true, data: { data: { changed: true } } });
});

for (const kind of ["standalone", "agent"] as const) {
  test(`${kind} Skill capability reads and writes retain credential context`, async () => {
    const machine: CapabilityExecutionContext = {
      ...context,
      user: null,
      actor: {
        kind: "service_account",
        scopes: ["read"],
        delegatedUser: null,
        serviceAccount: {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Capability machine",
          kind,
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: "1970-01-01T00:00:00.000Z",
        },
      },
      accessSubject: { type: "service_account", serviceAccountId: "22222222-2222-4222-8222-222222222222" },
    };
    const machineAuthority: RequestAuthority = {
      actor: machine.actor,
      accessSubject: machine.accessSubject,
      credentialKind: "api_key",
      scopes: ["read"],
    };
    machine.authority = machineAuthority;
    const list = spyOn(aiSkills, "list").mockResolvedValue([]);
    const get = spyOn(aiSkills, "getByShortId").mockResolvedValue(skill);
    await aiCapabilities.queries["ai.skills.list"].run({ query: "", enabled: true, limit: 20 }, machine);
    await aiCapabilities.queries["ai.skill.read"].run({ id: skill.shortId }, machine);
    expect(list).toHaveBeenCalledWith(machine, { authority: machineAuthority });
    expect(get).toHaveBeenCalledWith(skill.shortId, machine, "read", machineAuthority);
    const create = spyOn(aiSkills, "create").mockRejectedValue(new AiResourceCredentialError());
    const input = { name: "machine-skill", description: "Rules", instructions: "Read rules" };
    expect(await aiCapabilities.actions["ai.skill.create"].run(input, machine)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(create).toHaveBeenCalledWith({ subject: machine, ...input }, machineAuthority);
  });
}

test("every Code Action with policy declares review and the Core manifest compiles", () => {
  for (const [id, action] of Object.entries(aiCapabilities.actions)) {
    if (!id.startsWith("code.") || !("policy" in action)) continue;
    expect({ id, hasReview: "review" in action && typeof action.review === "function" }).toEqual({ id, hasReview: true });
  }
  expect(() => compileCapabilityManifest("core", aiCapabilities)).not.toThrow();
});

test("Core action targets replace their primary input selector in the manifest", () => {
  const manifest = compileCapabilityManifest("core", aiCapabilities);
  for (const action of manifest.actions) {
    if (action.localId.startsWith("code.")) continue;
    if (action.localId === "ai.skill.create") {
      expect(action.target).toBeUndefined();
      continue;
    }
    expect(action.target).toBe(action.localId.startsWith("ai.skill.") ? "ai.skill" : "ai.chat");
    expect(action.inputSchema.properties).not.toHaveProperty("skillId");
    expect(action.inputSchema.properties).not.toHaveProperty("chatId");
  }
  expect(aiCapabilities.actions["ai.skill.delete"].input.safeParse({ skillId: "Other1" }).success).toBe(false);
});
