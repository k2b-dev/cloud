import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  type AiChatTask,
  type AiChatTaskOccurrence,
  type AiConversation,
  type AiInterChatMessage,
  type AiSkill,
  type AiStoredMessage,
  aiCapabilityId,
  aiChatTasks,
  aiConversations,
  aiSkills,
} from "@valentinkolb/cloud/ai";
import { compileCapabilityManifest } from "@valentinkolb/cloud/capabilities/testing";
import {
  type CapabilityActionDefinition,
  CapabilityActionReviewSchema,
  type CapabilityExecutionContext,
  capabilityResultSchema,
  type User,
} from "@valentinkolb/cloud/contracts";
import * as taskRuntime from "./ai-chat-tasks-runtime";
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

const context: CapabilityExecutionContext = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  user,
  locale: "en",
  signal: new AbortController().signal,
};

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
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: user.id,
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T13:00:00.000Z",
};

const scheduledTask: AiChatTask = {
  id: "88888888-8888-4888-8888-888888888888",
  shortId: "tSk234",
  chatId: chat.shortId,
  chatTitle: chat.title,
  conversationId: chat.id,
  sponsorUserId: user.id,
  mandateId: null,
  mandateRevision: null,
  prompt: "Prepare the release report.",
  schedule: { kind: "cron", cron: "0 9 * * 1" },
  timezone: "Europe/Berlin",
  state: "active",
  revision: 1,
  lastError: null,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt,
};

const taskOccurrence: AiChatTaskOccurrence = {
  id: "99999999-9999-4999-8999-999999999999",
  shortId: "rUn234",
  taskId: scheduledTask.id,
  scheduledFor: chat.updatedAt,
  trigger: "manual",
  state: "queued",
  turnId: null,
  error: null,
  createdAt: chat.updatedAt,
  startedAt: null,
  completedAt: null,
};

const skill: AiSkill = {
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
  modelProfileId: null,
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

afterEach(() => mock.restore());

describe("Core AI capabilities", () => {
  test("publishes closed-world AI capabilities under the core.ai namespace", () => {
    const manifest = compileCapabilityManifest("core", aiCapabilities);
    const queries = [
      "ai.chat.read",
      "ai.chat.resources",
      "ai.chat.search",
      "ai.chats.resources",
      "ai.chats.search",
      "ai.skill.read",
      "ai.skill.reference.read",
      "ai.skills.list",
      "ai.task.read",
      "ai.tasks.list",
    ];
    const actions = [
      "ai.chat.message",
      "ai.skill.create",
      "ai.skill.delete",
      "ai.skill.enabled.set",
      "ai.skill.reference.remove",
      "ai.skill.reference.set",
      "ai.skill.references.set",
      "ai.skill.update",
      "ai.task.create",
      "ai.task.delete",
      "ai.task.pause",
      "ai.task.resume",
      "ai.task.run",
      "ai.task.update",
    ];
    expect(manifest.types.map((type) => `core.${type.localId}`).sort()).toEqual(["core.ai.chat", "core.ai.skill", "core.ai.task"]);
    expect(Object.keys(aiCapabilities.queries).sort()).toEqual(queries);
    expect(manifest.queries.map((query) => query.localId).sort()).toEqual(queries);
    expect(manifest.queries.every((query) => query.openWorld === false)).toBe(true);
    expect(manifest.actions.map((action) => action.localId).sort()).toEqual(actions);
    expect(manifest.actions.every((action) => action.openWorld === false)).toBe(true);
    expect(
      (Object.entries(aiCapabilities.actions) as Array<[string, CapabilityActionDefinition]>)
        .filter(([, action]) => action.approval === "rememberable")
        .map(([localId]) => localId),
    ).toEqual(["ai.skill.reference.set", "ai.skill.references.set", "ai.task.pause"]);
    expect(
      Object.fromEntries(
        manifest.actions.map((action) => [action.localId, { destructive: action.destructive, idempotency: action.idempotency }]),
      ),
    ).toEqual({
      "ai.chat.message": { destructive: false, idempotency: "required" },
      "ai.skill.create": { destructive: false, idempotency: "none" },
      "ai.skill.delete": { destructive: true, idempotency: "none" },
      "ai.skill.enabled.set": { destructive: true, idempotency: "none" },
      "ai.skill.reference.remove": { destructive: true, idempotency: "none" },
      "ai.skill.reference.set": { destructive: true, idempotency: "none" },
      "ai.skill.references.set": { destructive: true, idempotency: "none" },
      "ai.skill.update": { destructive: true, idempotency: "none" },
      "ai.task.create": { destructive: false, idempotency: "required" },
      "ai.task.delete": { destructive: true, idempotency: "none" },
      "ai.task.pause": { destructive: true, idempotency: "none" },
      "ai.task.resume": { destructive: true, idempotency: "none" },
      "ai.task.run": { destructive: false, idempotency: "required" },
      "ai.task.update": { destructive: true, idempotency: "none" },
    });
    expect(aiCapabilities.actions["ai.chat.message"].input.safeParse({ chatId: chat.shortId, text: "x".repeat(10_001) }).success).toBe(
      false,
    );
    expect(
      aiCapabilities.actions["ai.skill.create"].input.safeParse({
        name: "Weekly Status",
        description: "Create reports.",
        instructions: "Write the report.",
      }).success,
    ).toBe(false);
    expect(
      aiCapabilities.actions["ai.skill.reference.set"].input.safeParse({
        skillId: skill.shortId,
        expectedRevision: 1,
        path: "scripts/run.ts",
        content: "x",
      }).success,
    ).toBe(false);
    expect(
      aiCapabilities.actions["ai.skill.references.set"].input.safeParse({
        skillId: skill.shortId,
        expectedRevision: 1,
        references: Array.from({ length: 16 }, (_, index) => ({
          path: `references/topic-${index + 1}.md`,
          content: `Topic ${index + 1}`,
        })),
      }).success,
    ).toBe(true);
    expect(
      aiCapabilities.actions["ai.skill.references.set"].input.safeParse({
        skillId: skill.shortId,
        expectedRevision: 1,
        references: Array.from({ length: 21 }, (_, index) => ({
          path: `references/topic-${index + 1}.md`,
          content: `Topic ${index + 1}`,
        })),
      }).success,
    ).toBe(false);
    expect(aiCapabilities.queries["ai.skills.list"].input.safeParse({ cursor: "1234" }).success).toBe(false);
    const localCursor = encodeURIComponent(JSON.stringify({ at: "2026-08-11T12:00:00.000Z", type: "notebooks.note", id: "nT1234" }));
    const userCursor = encodeURIComponent(
      JSON.stringify({ at: "2026-08-11T12:00:00.000Z", type: "notebooks.note", id: "nT1234", chat: chat.shortId }),
    );
    expect(aiCapabilities.queries["ai.chat.read"].input.safeParse({ id: chat.shortId, cursor: "42" }).success).toBe(true);
    expect(aiCapabilities.queries["ai.chat.resources"].input.safeParse({ chatId: chat.shortId, cursor: localCursor }).success).toBe(true);
    expect(aiCapabilities.queries["ai.chat.resources"].input.safeParse({ chatId: chat.shortId, cursor: userCursor }).success).toBe(false);
    expect(aiCapabilities.queries["ai.chats.resources"].input.safeParse({ cursor: userCursor }).success).toBe(true);
    expect(aiCapabilities.queries["ai.chats.resources"].input.safeParse({ cursor: localCursor }).success).toBe(false);
    expect(aiCapabilities.queries["ai.chats.search"].description).toContain("Normal entry for finding");
    expect(aiCapabilities.queries["ai.chat.read"].description).toContain("Use ai.chat.search");
    expect(aiCapabilities.queries["ai.chats.resources"].description).toContain("Direct cross-chat entry");
  });

  test("scopes remembered Skill approvals globally and task approvals to one task", async () => {
    spyOn(aiSkills, "getByShortId").mockResolvedValue(skill);
    spyOn(aiChatTasks, "get").mockResolvedValue(scheduledTask);

    const skillReview = await aiCapabilities.actions["ai.skill.reference.set"].review!(
      {
        skillId: skill.shortId,
        expectedRevision: skill.revision,
        path: "references/style.md",
        content: "Keep the report concise.",
      },
      context,
    );
    const skillBatchReview = await aiCapabilities.actions["ai.skill.references.set"].review!(
      {
        skillId: skill.shortId,
        expectedRevision: skill.revision,
        references: [
          { path: "references/style.md", content: "Keep the report concise." },
          { path: "references/tone.md", content: "Use a direct tone." },
        ],
      },
      context,
    );
    const taskReview = await aiCapabilities.actions["ai.task.pause"].review!({ taskId: scheduledTask.shortId }, context);
    const results = [skillReview, skillBatchReview, taskReview];

    expect(results).toHaveLength(
      (Object.values(aiCapabilities.actions) as CapabilityActionDefinition[]).filter((action) => action.approval === "rememberable").length,
    );
    expect(skillReview).toMatchObject({ ok: true, data: { approvalScope: "skills" } });
    expect(skillBatchReview).toMatchObject({
      ok: true,
      data: {
        approvalScope: "skills",
        details: [
          { label: "references/style.md", value: "Keep the report concise.", display: "block" },
          { label: "references/tone.md", value: "Use a direct tone.", display: "block" },
        ],
      },
    });
    expect(taskReview).toMatchObject({ ok: true, data: { approvalScope: `task:${scheduledTask.shortId}` } });
    for (const result of results) {
      expect(result.ok).toBeTrue();
      if (result.ok) expect(CapabilityActionReviewSchema.safeParse(result.data).success).toBeTrue();
    }
  });

  test("returns item-local task refs and an unambiguous next page", async () => {
    spyOn(aiChatTasks, "list").mockResolvedValue([scheduledTask, { ...scheduledTask, shortId: "tSk999" }]);

    const result = await aiCapabilities.queries["ai.tasks.list"].run({ limit: 1 }, context);

    expect(result).toMatchObject({
      ok: true,
      data: {
        data: [{ id: scheduledTask.shortId, ref: { type: "core.ai.task", id: scheduledTask.shortId } }],
        page: { nextCursor: "1", hasMore: true },
      },
    });
    expect(aiChatTasks.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 2, offset: 0 }));
  });

  test("reads a scheduled task with its chat name and no extra task lookup", async () => {
    const get = spyOn(aiChatTasks, "get").mockResolvedValue(scheduledTask);
    const listOccurrences = spyOn(aiChatTasks, "listOccurrences").mockResolvedValue([taskOccurrence]);

    const result = await aiCapabilities.queries["ai.task.read"].run({ id: scheduledTask.shortId }, context);

    expect(get).toHaveBeenCalledTimes(1);
    expect(listOccurrences).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      data: { summary: "Read active scheduled task in “Release planning”." },
    });
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

    expect(list).toHaveBeenCalledWith(context.accessSubject);
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

  test("reviews and executes Skill mutations through the permission-aware service", async () => {
    const get = spyOn(aiSkills, "getByShortId").mockResolvedValue(skill);
    spyOn(aiSkills, "create").mockResolvedValue(skill);
    spyOn(aiSkills, "update").mockResolvedValue({ ...skill, description: "Updated description.", revision: 2 });
    spyOn(aiSkills, "setReference").mockResolvedValue({ ...skill, revision: 2 });
    const setReferences = spyOn(aiSkills, "setReferences").mockResolvedValue({ ...skill, revision: 2 });
    spyOn(aiSkills, "removeReference").mockResolvedValue({ ...skill, references: [], referenceCount: 0, revision: 2 });
    spyOn(aiSkills, "setEnabled").mockResolvedValue(false);
    spyOn(aiSkills, "delete").mockResolvedValue(true);

    const updateReview = await aiCapabilities.actions["ai.skill.update"].review!(
      { skillId: skill.shortId, expectedRevision: 1, description: "Updated description." },
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
        { skillId: skill.shortId, expectedRevision: 1, description: "Updated description." },
        context,
      ),
      "ai.skill.reference.set": await aiCapabilities.actions["ai.skill.reference.set"].run(
        { skillId: skill.shortId, expectedRevision: 1, path: "references/style.md", content: "Keep it concise." },
        context,
      ),
      "ai.skill.references.set": await aiCapabilities.actions["ai.skill.references.set"].run(
        {
          skillId: skill.shortId,
          expectedRevision: 1,
          references: [
            { path: "references/style.md", content: "Keep it concise." },
            { path: "references/tone.md", content: "Use a direct tone." },
          ],
        },
        context,
      ),
      "ai.skill.reference.remove": await aiCapabilities.actions["ai.skill.reference.remove"].run(
        { skillId: skill.shortId, expectedRevision: 1, path: "references/style.md" },
        context,
      ),
      "ai.skill.enabled.set": await aiCapabilities.actions["ai.skill.enabled.set"].run({ skillId: skill.shortId, enabled: false }, context),
      "ai.skill.delete": await aiCapabilities.actions["ai.skill.delete"].run({ skillId: skill.shortId }, context),
    };

    for (const [localId, result] of Object.entries(results)) {
      expect(result.ok).toBeTrue();
      if (!result.ok) continue;
      const action = (aiCapabilities.actions as unknown as Record<string, CapabilityActionDefinition>)[localId];
      if (!action) throw new Error(`Missing Core action ${localId}`);
      expect(capabilityResultSchema(action.data).safeParse(result.data).success).toBeTrue();
    }
    expect(setReferences).toHaveBeenCalledWith(skill.id, context.accessSubject, {
      skillId: skill.shortId,
      expectedRevision: 1,
      references: [
        { path: "references/style.md", content: "Keep it concise." },
        { path: "references/tone.md", content: "Use a direct tone." },
      ],
    });
    expect(get).toHaveBeenCalledWith(skill.shortId, context.accessSubject, "admin");
  });

  test("returns a schema-valid user outcome from every Core action", async () => {
    spyOn(taskRuntime, "reconcileAiChatTasks").mockResolvedValue();
    spyOn(taskRuntime.aiChatTaskRuntime, "recover").mockResolvedValue({ queued: 0 });
    spyOn(aiChatTasks, "getCreateByIdempotency").mockResolvedValue(scheduledTask);
    spyOn(aiChatTasks, "update").mockResolvedValue({ ...scheduledTask, prompt: "Updated release instructions." });
    spyOn(aiChatTasks, "get").mockResolvedValue(scheduledTask);
    spyOn(aiChatTasks, "setState").mockImplementation(async ({ state }) => ({ ...scheduledTask, state }));
    spyOn(aiChatTasks, "createOccurrence").mockResolvedValue(taskOccurrence);
    spyOn(aiChatTasks, "delete").mockResolvedValue(true);
    spyOn(aiConversations, "getCapabilityInvocationOrigin").mockResolvedValue({
      conversationId: chat.id,
      conversationShortId: chat.shortId,
      turnId: "33333333-3333-4333-8333-333333333333",
      turnShortId: "tRn234",
      callId: "call-1",
    });
    spyOn(aiConversations, "createInterChatMessage").mockResolvedValue({
      ok: true,
      message: {
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
      },
    });

    const idempotentContext = { ...context, idempotencyKey: "core-summary-test" };
    const results = {
      "ai.task.create": await aiCapabilities.actions["ai.task.create"].run(
        {
          chatId: chat.shortId,
          prompt: scheduledTask.prompt,
          schedule: { kind: "cron", cron: "0 9 * * 1" },
          timezone: scheduledTask.timezone,
        },
        idempotentContext,
      ),
      "ai.task.update": await aiCapabilities.actions["ai.task.update"].run(
        { taskId: scheduledTask.shortId, prompt: "Updated release instructions." },
        context,
      ),
      "ai.task.pause": await aiCapabilities.actions["ai.task.pause"].run({ taskId: scheduledTask.shortId }, context),
      "ai.task.resume": await aiCapabilities.actions["ai.task.resume"].run({ taskId: scheduledTask.shortId }, context),
      "ai.task.run": await aiCapabilities.actions["ai.task.run"].run({ taskId: scheduledTask.shortId }, idempotentContext),
      "ai.task.delete": await aiCapabilities.actions["ai.task.delete"].run({ taskId: scheduledTask.shortId }, context),
      "ai.chat.message": await aiCapabilities.actions["ai.chat.message"].run(
        { chatId: "cHt567", text: "Please verify it." },
        idempotentContext,
      ),
    };

    expect(Object.keys(results)).toHaveLength(7);
    for (const [localId, result] of Object.entries(results)) {
      expect(result.ok).toBeTrue();
      if (!result.ok) continue;
      expect(result.data.summary?.length).toBeGreaterThan(0);
      const action = (aiCapabilities.actions as unknown as Record<string, CapabilityActionDefinition>)[localId];
      if (!action) throw new Error(`Missing Core action ${localId}`);
      const parsed = capabilityResultSchema(action.data).safeParse(result.data);
      if (!parsed.success) throw new Error(`Invalid Core result for ${localId}: ${JSON.stringify(parsed.error.issues)}`);
    }
    expect(results["ai.task.update"]).toMatchObject({
      ok: true,
      data: { summary: `Changed the instructions of a task in “${chat.title}”.` },
    });
    expect(results["ai.chat.message"]).toMatchObject({ ok: true, data: { summary: "Sent a message to “Target chat”." } });
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
    const review = await aiCapabilities.actions["ai.chat.message"].review!({ chatId: chat.shortId, text: "Please verify it." }, context);
    expect(review).toMatchObject({
      ok: true,
      data: { message: `Send this message to ${chat.title} (${chat.shortId}).`, details: [{ label: "Target chat" }, { label: "Message" }] },
    });

    const origin = spyOn(aiConversations, "getCapabilityInvocationOrigin").mockResolvedValue(null);
    const result = await aiCapabilities.actions["ai.chat.message"].run(
      { chatId: chat.shortId, text: "Please verify it." },
      { ...context, idempotencyKey: "ai-test" },
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
      { chatId: message.targetChatId, text: message.text },
      { ...context, idempotencyKey: "ai-test" },
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
