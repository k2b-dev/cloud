import { dates, i18n, err, fail, ok } from "@k2b/stdlib";
import {
  AI_SHORT_ID_PATTERN,
  AI_SKILL_DESCRIPTION_MAX_CHARS,
  AI_SKILL_NAME_MAX_CHARS,
  AI_SKILL_NAME_PATTERN,
  AI_SKILL_REFERENCE_MAX_CHARS,
  AI_SKILL_REFERENCE_PATH_PATTERN,
  type AiChatTask,
  AiChatTaskIdempotencyConflictError,
  type AiConversation,
  type AiConversationResourceRef,
  type AiSkill,
  AiSkillInputError,
  AiSkillRevisionConflictError,
  type AiStoredMessage,
  aiCapabilityId,
  aiChatTasks,
  aiConversations,
  aiSkills,
  ChatTaskIdSchema,
  ChatTaskOccurrenceIdSchema,
  ChatTaskScheduleInputSchema,
  chatTaskCreateFingerprint,
  isConversationResourceCursor,
  normalizeChatTaskSchedule,
} from "@valentinkolb/cloud/ai";
import {
  CloudResourceRefSchema,
  type CloudResourceView,
  capabilityIdempotencyConflict,
  capabilityPage,
  defineCapabilities,
  UniversalSearchDataSchema,
} from "@valentinkolb/cloud/contracts";
import { z } from "zod";
import { aiChatTaskRuntime, reconcileAiChatTasks } from "./ai-chat-tasks-runtime";
import { deliverPendingAiMessages } from "./ai-inter-chat-messages";
import { coreCapabilityPresentation } from "./capability-presentation";

const CORE_APP_ID = "core";
const MAX_MESSAGE_TEXT_CHARS = 8_000;
const MAX_CAPABILITY_SKILL_CONTENT_CHARS = 10_000;
const MAX_CAPABILITY_SKILL_REFERENCE_BATCH_ITEMS = 20;
const ChatIdSchema = z.string().regex(AI_SHORT_ID_PATTERN).describe("Readable six-character AI conversation ID.");
const CursorSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .optional()
  .describe("Numeric cursor returned by the previous message page.");
const resourceCursorSchema = (scope: "conversation" | "user") =>
  z
    .string()
    .min(1)
    .max(2_048)
    .refine((value) => isConversationResourceCursor(value, scope), "Invalid resource cursor")
    .optional()
    .describe("Opaque cursor returned by the previous resource page.");
const CHAT_MESSAGE_TOOL_NAME = aiCapabilityId(CORE_APP_ID, "ai.chat.message");
const ChatTaskCreateInputSchema = z
  .object({
    chatId: ChatIdSchema,
    prompt: z.string().trim().min(1).max(10_000).describe("Exact prompt to deliver to this chat when the task runs."),
    schedule: ChatTaskScheduleInputSchema.describe("When this task should run."),
    timezone: z.string().min(1).max(100).describe("Exact IANA timezone from the current runtime context."),
  })
  .strict();
const ChatTaskUpdateInputSchema = z
  .object({
    taskId: ChatTaskIdSchema,
    prompt: z.string().trim().min(1).max(10_000).optional().describe("Replacement prompt delivered when the task runs."),
    schedule: ChatTaskScheduleInputSchema.optional().describe("Replacement one-time or recurring schedule."),
    timezone: z.string().min(1).max(100).optional().describe("Required with schedule; copy the current runtime IANA timezone."),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.prompt === undefined && value.schedule === undefined)
      context.addIssue({ code: "custom", message: "Provide a prompt or schedule" });
    if (value.schedule !== undefined && value.timezone === undefined)
      context.addIssue({ code: "custom", path: ["timezone"], message: "Provide the runtime timezone with a schedule" });
    if (value.schedule === undefined && value.timezone !== undefined)
      context.addIssue({ code: "custom", path: ["timezone"], message: "Timezone is only used with a schedule" });
  });
const ChatTaskIdInputSchema = z.object({ taskId: ChatTaskIdSchema }).strict();
const ChatTaskReadInputSchema = z
  .object({ id: ChatTaskIdSchema.describe("Scheduled-task ID returned by List scheduled AI tasks or a core.ai.task ref.") })
  .strict();
const ChatTasksListInputSchema = z
  .object({
    chatId: ChatIdSchema.optional().describe("Optional AI conversation ID returned by chat search/read or a core.ai.chat ref."),
    state: z.enum(["active", "paused", "completed", "needs_attention"]).optional().describe("Optional task lifecycle state."),
    limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of tasks to return."),
    cursor: z.string().regex(/^\d+$/).optional().describe("Opaque cursor returned by the previous task page."),
  })
  .strict();
const ChatTaskDataSchema = z
  .object({
    id: ChatTaskIdSchema,
    chatId: ChatIdSchema,
    chatTitle: z.string(),
    prompt: z.string(),
    schedule: z.union([z.object({ kind: z.literal("once"), runAt: z.string() }), z.object({ kind: z.literal("cron"), cron: z.string() })]),
    timezone: z.string(),
    state: z.enum(["active", "paused", "completed", "needs_attention"]),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const ChatTaskDetailDataSchema = z
  .object({
    task: ChatTaskDataSchema,
    occurrences: z.array(
      z.object({
        id: ChatTaskOccurrenceIdSchema,
        scheduledFor: z.string(),
        trigger: z.enum(["scheduled", "manual"]),
        state: z.enum(["queued", "running", "completed", "failed"]),
        error: z.string().nullable(),
        createdAt: z.string(),
        completedAt: z.string().nullable(),
      }),
    ),
  })
  .strict();
const ChatTaskListItemDataSchema = ChatTaskDataSchema.extend({
  ref: z.object({ type: z.literal("core.ai.task"), id: ChatTaskIdSchema }).strict(),
}).strict();

const taskData = (task: AiChatTask): z.infer<typeof ChatTaskDataSchema> => ({
  id: task.shortId,
  chatId: task.chatId,
  chatTitle: task.chatTitle,
  prompt: task.prompt,
  schedule: task.schedule,
  timezone: task.timezone,
  state: task.state,
  lastError: task.lastError,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});
const taskScheduleLabel = (task: AiChatTask): string =>
  task.schedule.kind === "once" ? `${task.schedule.runAt} (${task.timezone})` : `${task.schedule.cron} (${task.timezone})`;
const referenceMessages = i18n.define({ baseLocale: "en", messages: {
  en: { active: "Active", paused: "Paused", completed: "Completed", needs_attention: "Needs attention", recurring: "Recurring", chat: "AI conversation" },
  de: { active: "Aktiv", paused: "Pausiert", completed: "Abgeschlossen", needs_attention: "Eingriff erforderlich", recurring: "Wiederkehrend", chat: "KI-Chat" },
} });
const taskReference = (task: AiChatTask, locale: string) => {
  const resolved = referenceMessages.resolve([locale]);
  const t = resolved.t;
  const schedule = task.schedule.kind === "once"
    ? dates.formatDateTime(task.schedule.runAt, { locale: resolved.locale, timeZone: task.timezone })
    : `${t.recurring}: ${task.schedule.cron}`;
  return { type: "core.ai.task", id: task.shortId, title: task.prompt.trim().slice(0, 500),
    preview: `${t[task.state]} · ${schedule} · ${task.timezone}`, icon: "ti ti-calendar-clock" };
};
const taskChatReference = (task: AiChatTask, locale: string) => ({
  type: "core.ai.chat", id: task.chatId, title: task.chatTitle,
  preview: referenceMessages.resolve([locale]).t.chat, icon: "ti ti-message-chatbot",
});
const chatReference = (chat: AiConversation) => ({
  type: "core.ai.chat", id: chat.shortId, title: chat.title,
  preview: chat.description, icon: "ti ti-message-chatbot",
});
const taskChatTitle = (task: AiChatTask): string => `“${task.chatTitle}”`;
const taskUpdateSummary = (input: z.infer<typeof ChatTaskUpdateInputSchema>, task: AiChatTask): string => {
  if (input.prompt !== undefined && input.schedule !== undefined)
    return `Changed the instructions and schedule of a task in ${taskChatTitle(task)}.`;
  if (input.prompt !== undefined) return `Changed the instructions of a task in ${taskChatTitle(task)}.`;
  return `Changed the schedule of a task in ${taskChatTitle(task)}.`;
};
const invalidTaskState = (task: AiChatTask, action: "pause" | "resume" | "run"): string | null => {
  if (action === "pause")
    return task.state === "active" || task.state === "paused" ? null : `Task ${task.shortId} cannot be paused while ${task.state}`;
  if (action === "resume")
    return task.state === "needs_attention" && task.schedule.kind === "once"
      ? `Task ${task.shortId} needs a new future schedule before it can resume`
      : task.state === "paused" || task.state === "needs_attention" || task.state === "active"
        ? null
        : `Task ${task.shortId} cannot be resumed while ${task.state}`;
  return task.state === "active" ? null : `Task ${task.shortId} cannot run while ${task.state}`;
};

const ChatsSearchInputSchema = z
  .object({
    query: z.string().trim().max(500).default("").describe("Words to match in chat titles, summaries, or visible messages."),
    refs: z
      .array(CloudResourceRefSchema)
      .max(10)
      .optional()
      .describe("Require chats to contain every exact structured Cloud resource ref."),
    archived: z.boolean().default(false).describe("Search archived chats instead of active chats."),
    limit: z.number().int().min(1).max(20).default(10).describe("Maximum number of matching chats to return."),
  })
  .strict();

const ChatPageInputSchema = z
  .object({
    chatId: ChatIdSchema,
    cursor: CursorSchema,
    limit: z.number().int().min(1).max(20).default(20).describe("Maximum number of visible messages to return."),
  })
  .strict();

const ChatReadInputSchema = z
  .object({
    id: ChatIdSchema.describe("Readable ID of the owned chat to read."),
    cursor: CursorSchema,
    limit: z.number().int().min(1).max(20).default(20).describe("Maximum number of visible messages to return."),
  })
  .strict();

const ChatSearchInputSchema = ChatPageInputSchema.extend({
  query: z.string().trim().min(1).max(500).describe("Words to match in visible messages from this chat."),
}).strict();

const ChatResourcesInputSchema = z
  .object({
    chatId: ChatIdSchema,
    query: z.string().trim().max(500).optional().describe("Optional title, type, or readable resource ID filter."),
    cursor: resourceCursorSchema("conversation"),
    limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of resource refs to return."),
  })
  .strict();

const ChatsResourcesInputSchema = ChatResourcesInputSchema.omit({ chatId: true, cursor: true })
  .extend({ cursor: resourceCursorSchema("user") })
  .strict();

const ChatSummarySchema = z
  .object({
    id: ChatIdSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(2_000),
    status: z.enum(["idle", "queued", "running", "needs_attention", "failed"]),
    archived: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const VisibleMessageSchema = z
  .object({
    id: ChatIdSchema,
    seq: z.number().int().min(1),
    role: z.enum(["user", "assistant", "summary"]),
    text: z.string().min(1).max(MAX_MESSAGE_TEXT_CHARS),
    truncated: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

const ChatMessagesDataSchema = z
  .object({
    chat: ChatSummarySchema,
    messages: z.array(VisibleMessageSchema).max(40),
  })
  .strict();

const ResourceDataSchema = z
  .object({
    ref: CloudResourceRefSchema,
    title: z.string().max(500).nullable(),
    preview: z.string().max(2_000).nullable(),
    icon: z.string().max(120).nullable(),
    href: z.string().max(2_048).nullable(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    sourceTurnId: ChatIdSchema.nullable(),
    sourceCallId: z.string().max(500).nullable(),
  })
  .strict();

const ChatResourcesDataSchema = z.object({ chat: ChatSummarySchema, resources: z.array(ResourceDataSchema).max(50) }).strict();
const ChatsResourcesDataSchema = z
  .array(
    ResourceDataSchema.extend({
      chat: z.object({ id: ChatIdSchema, title: z.string().min(1).max(120), updatedAt: z.string() }).strict(),
    }).strict(),
  )
  .max(50);

const ChatMessageInputSchema = z
  .object({
    chatId: ChatIdSchema.describe("Readable ID of the owned target chat."),
    text: z.string().trim().min(1).max(10_000).describe("Exact message to send to the target chat."),
  })
  .strict();
const ChatMessageDataSchema = z
  .object({
    id: ChatIdSchema,
    status: z.enum(["queued", "delivered"]),
    targetChatId: ChatIdSchema,
  })
  .strict();

const SkillIdSchema = z.string().regex(AI_SHORT_ID_PATTERN).describe("Readable six-character Skill ID.");
const SkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(AI_SKILL_NAME_MAX_CHARS)
  .regex(AI_SKILL_NAME_PATTERN)
  .describe("Lowercase Skill name with words separated by single hyphens.");
const SkillDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(AI_SKILL_DESCRIPTION_MAX_CHARS)
  .describe("Short, clear description of what the Skill does and when Assistant should load it.");
const SkillInstructionsSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CAPABILITY_SKILL_CONTENT_CHARS)
  .describe("Complete Markdown instructions for the Skill.");
const SkillReferencePathSchema = z
  .string()
  .trim()
  .regex(AI_SKILL_REFERENCE_PATH_PATTERN)
  .describe("Exact Markdown reference path returned by Read Skill, matching references/<name>.md.");
const SkillPermissionSchema = z.enum(["read", "write", "admin"]);
const SkillReferenceMetadataSchema = z.object({ path: SkillReferencePathSchema, size: z.number().int().min(0) }).strict();
const SkillSummaryDataSchema = z
  .object({
    id: SkillIdSchema,
    name: SkillNameSchema,
    description: SkillDescriptionSchema,
    permission: SkillPermissionSchema,
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    referenceCount: z.number().int().min(0),
    updatedAt: z.string(),
    ref: z.object({ type: z.literal("core.ai.skill"), id: SkillIdSchema }).strict(),
  })
  .strict();
const SkillDetailDataSchema = SkillSummaryDataSchema.omit({ ref: true })
  .extend({
    instructions: z.string().max(100_000),
    extraFrontmatter: z.record(z.string(), z.unknown()),
    references: z.array(SkillReferenceMetadataSchema),
  })
  .strict();
const SkillsListInputSchema = z
  .object({
    query: z.string().trim().max(500).default("").describe("Optional words to match in Skill names and descriptions."),
    enabled: z.boolean().optional().describe("Optional personal enabled-state filter."),
    limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of readable Skills to return."),
    cursor: z
      .string()
      .regex(/^\d{1,3}$/)
      .optional()
      .describe("Opaque cursor returned by the previous Skill page."),
  })
  .strict();
const SkillReadInputSchema = z.object({ id: SkillIdSchema.describe("Skill ID returned by List Skills or a core.ai.skill ref.") }).strict();
const SkillReferenceReadInputSchema = z.object({ skillId: SkillIdSchema, path: SkillReferencePathSchema }).strict();
const SkillCreateInputSchema = z
  .object({ name: SkillNameSchema, description: SkillDescriptionSchema, instructions: SkillInstructionsSchema })
  .strict();
const SkillUpdateInputSchema = z
  .object({
    skillId: SkillIdSchema,
    expectedRevision: z.number().int().positive().describe("Exact revision returned by Read Skill."),
    name: SkillNameSchema.optional(),
    description: SkillDescriptionSchema.optional(),
    instructions: SkillInstructionsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.name === undefined && value.description === undefined && value.instructions === undefined) {
      context.addIssue({ code: "custom", message: "Provide a name, description, or instructions" });
    }
  });
const SkillReferenceSetInputSchema = z
  .object({
    skillId: SkillIdSchema,
    expectedRevision: z.number().int().positive().describe("Exact revision returned by Read Skill."),
    path: SkillReferencePathSchema,
    content: z.string().max(MAX_CAPABILITY_SKILL_CONTENT_CHARS).describe("Complete Markdown content for this reference."),
  })
  .strict();
const SkillReferencesSetInputSchema = z
  .object({
    skillId: SkillIdSchema,
    expectedRevision: z.number().int().positive().describe("Exact revision returned by Read Skill."),
    references: z
      .array(
        z
          .object({
            path: SkillReferencePathSchema,
            content: z.string().max(MAX_CAPABILITY_SKILL_CONTENT_CHARS).describe("Complete Markdown content for this reference."),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CAPABILITY_SKILL_REFERENCE_BATCH_ITEMS)
      .describe("References to validate and write atomically in one Skill revision."),
  })
  .strict();
const SkillReferenceRemoveInputSchema = SkillReferenceSetInputSchema.omit({ content: true }).strict();
const SkillEnabledSetInputSchema = z
  .object({ skillId: SkillIdSchema, enabled: z.boolean().describe("Whether this Skill should be active for the current user.") })
  .strict();
const SkillDeleteInputSchema = z.object({ skillId: SkillIdSchema }).strict();
const SkillReferenceDataSchema = z
  .object({
    skillId: SkillIdSchema,
    revision: z.number().int().positive(),
    path: SkillReferencePathSchema,
    content: z.string().max(AI_SKILL_REFERENCE_MAX_CHARS),
  })
  .strict();

const skillData = (skill: AiSkill): z.infer<typeof SkillDetailDataSchema> => ({
  id: skill.shortId,
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
  extraFrontmatter: skill.extraFrontmatter,
  permission: skill.permission,
  enabled: skill.enabled,
  revision: skill.revision,
  referenceCount: skill.referenceCount,
  references: skill.references.map((reference) => ({ path: reference.path, size: reference.content.length })),
  updatedAt: skill.updatedAt,
});

const skillRevisionError = (error: unknown) =>
  error instanceof AiSkillRevisionConflictError
    ? fail(err.conflict(error.message))
    : error instanceof AiSkillInputError
      ? fail(err.badInput(error.message))
      : typeof error === "object" && error !== null && "code" in error && error.code === "23505"
        ? fail(err.conflict("A Skill with this name already exists."))
        : null;

const readableSkill = (
  skillId: string,
  context: { accessSubject: Parameters<typeof aiSkills.getByShortId>[1] },
  permission: "read" | "write" | "admin" = "read",
) => aiSkills.getByShortId(skillId, context.accessSubject, permission);

const chatHref = (chatId: string): string => `/app/assistant?conversation=${encodeURIComponent(chatId)}`;

const chatSummary = (chat: AiConversation) => ({
  id: chat.shortId,
  title: chat.title,
  description: chat.description,
  status: chat.runStatus,
  archived: chat.archivedAt !== null,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt,
});

const toResourceView = (chat: AiConversation): CloudResourceView => ({
  ref: { type: "core.ai.chat", id: chat.shortId },
  title: chat.title,
  icon: "ti ti-message-chatbot",
  ...(chat.description.trim() ? { preview: chat.description } : {}),
  priority: chat.pinnedAt ? 8 : 6,
  metadata: [
    { label: "Status", value: chat.runStatus },
    { label: "Updated", value: chat.updatedAt },
  ],
  links: [{ rel: "open", href: chatHref(chat.shortId) }],
});

const visibleMessage = (stored: AiStoredMessage) => {
  const message = stored.message;
  if (message.role === "tool_result") return null;
  const text = message.content
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      return part.type === "text" ? [part.text] : [];
    })
    .join("")
    .trim();
  if (!text) return null;
  return {
    id: stored.shortId,
    seq: stored.seq,
    role: stored.kind === "summary" ? ("summary" as const) : message.role,
    text: text.slice(0, MAX_MESSAGE_TEXT_CHARS),
    truncated: text.length > MAX_MESSAGE_TEXT_CHARS,
    createdAt: stored.createdAt,
  };
};

const resourceData = (resource: AiConversationResourceRef) => ({
  ref: resource.ref,
  title: resource.title,
  preview: resource.preview,
  icon: resource.icon,
  href: resource.href,
  firstSeenAt: resource.firstSeenAt,
  lastSeenAt: resource.lastSeenAt,
  sourceTurnId: resource.sourceTurnId,
  sourceCallId: resource.sourceCallId,
});

const ownedChat = async (chatId: string, userId: string, archived = false): Promise<AiConversation | null> =>
  aiConversations.getConversationByShortId({ shortId: chatId, ownerUserId: userId, archived });
const readableOwnedChat = async (chatId: string, userId: string): Promise<AiConversation | null> =>
  (await ownedChat(chatId, userId)) ?? ownedChat(chatId, userId, true);

export const aiCapabilities = defineCapabilities({
  protocolVersion: 1,
  presentation: coreCapabilityPresentation,
  types: {
    "ai.chat": {
      title: "AI conversation",
      description: "A private AI conversation owned by the current user.",
      icon: "ti ti-message-chatbot",
      reader: "ai.chat.read",
    },
    "ai.task": {
      title: "Scheduled AI task",
      description: "A one-time or recurring prompt attached to an owned AI conversation.",
      icon: "ti ti-calendar-clock",
      reader: "ai.task.read",
    },
    "ai.skill": {
      title: "Assistant Skill",
      description: "A permission-managed reusable Assistant workflow.",
      icon: "ti ti-sparkles",
      reader: "ai.skill.read",
    },
  },
  queries: {
    "ai.skills.list": {
      title: "List Assistant Skills",
      description:
        "Normal entry for Skill work. List Skills the current actor can read and return core.ai.skill refs for reading or reviewed management Actions.",
      input: SkillsListInputSchema,
      data: z.array(SkillSummaryDataSchema),
      openWorld: false,
      async run(input, context) {
        const query = input.query.toLocaleLowerCase();
        const offset = Number(input.cursor ?? "0");
        const matches = (await aiSkills.list(context.accessSubject)).filter(
          (skill) =>
            (input.enabled === undefined || skill.enabled === input.enabled) &&
            (!query || skill.name.toLocaleLowerCase().includes(query) || skill.description.toLocaleLowerCase().includes(query)),
        );
        const page = matches.slice(offset, offset + input.limit);
        return ok({
          data: page.map((skill) => ({
            id: skill.shortId,
            name: skill.name,
            description: skill.description,
            permission: skill.permission,
            enabled: skill.enabled,
            revision: skill.revision,
            referenceCount: skill.referenceCount,
            updatedAt: skill.updatedAt,
            ref: { type: "core.ai.skill" as const, id: skill.shortId },
          })),
          refs: page.map((skill) => ({ type: "core.ai.skill", id: skill.shortId })),
          page: capabilityPage(offset + input.limit < matches.length ? String(offset + input.limit) : undefined),
        });
      },
    },
    "ai.skill.read": {
      title: "Read an Assistant Skill",
      description:
        "Read one core.ai.skill ref returned by List Assistant Skills or a Skill Action, including its current revision and reference metadata.",
      input: SkillReadInputSchema,
      data: SkillDetailDataSchema,
      openWorld: false,
      async run(input, context) {
        const skill = await readableSkill(input.id, context);
        if (!skill) return fail(err.notFound("Skill"));
        return ok({
          data: skillData(skill),
          summary: `Read Assistant Skill “${skill.name}”.`,
          refs: [{ type: "core.ai.skill", id: skill.shortId }],
        });
      },
    },
    "ai.skill.reference.read": {
      title: "Read an Assistant Skill reference",
      description: "Read one exact Markdown reference returned by Read Assistant Skill while rechecking current Skill access.",
      input: SkillReferenceReadInputSchema,
      data: SkillReferenceDataSchema,
      openWorld: false,
      async run(input, context) {
        const skill = await readableSkill(input.skillId, context);
        const reference = skill?.references.find((item) => item.path === input.path);
        if (!skill || !reference) return fail(err.notFound("Skill reference"));
        return ok({
          data: { skillId: skill.shortId, revision: skill.revision, path: reference.path, content: reference.content },
          summary: `Read “${reference.path}” from Assistant Skill “${skill.name}”.`,
          refs: [{ type: "core.ai.skill", id: skill.shortId }],
        });
      },
    },
    "ai.tasks.list": {
      title: "List scheduled AI tasks",
      description:
        "Normal entry for scheduled-task work. List the current user's tasks, optionally for a core.ai.chat ref or state; use returned core.ai.task refs with ai.task.read or task Actions.",
      input: ChatTasksListInputSchema,
      data: z.array(ChatTaskListItemDataSchema),
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const offset = Number(input.cursor ?? "0");
        const tasks = await aiChatTasks.list({ userId: context.user.id, ...input, offset, limit: input.limit + 1 });
        const items = tasks.slice(0, input.limit);
        return ok({
          data: items.map((task) => ({ ...taskData(task), ref: { type: "core.ai.task" as const, id: task.shortId } })),
          refs: items.map((task) => taskReference(task, context.locale)),
          page: capabilityPage(tasks.length > input.limit ? String(offset + input.limit) : undefined),
        });
      },
    },
    "ai.task.read": {
      title: "Read a scheduled AI task",
      description:
        "Read one core.ai.task ref returned by ai.tasks.list or a task Action, including its parent core.ai.chat ref and recent runs.",
      input: ChatTaskReadInputSchema,
      data: ChatTaskDetailDataSchema,
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const task = await aiChatTasks.get({ userId: context.user.id, taskId: input.id });
        if (!task) return fail(err.notFound("Task"));
        const occurrences = (await aiChatTasks.listOccurrences({ userId: context.user.id, taskId: input.id })) ?? [];
        return ok({
          data: {
            task: taskData(task),
            occurrences: occurrences.map((occurrence) => ({
              id: occurrence.shortId,
              scheduledFor: occurrence.scheduledFor,
              trigger: occurrence.trigger,
              state: occurrence.state,
              error: occurrence.error,
              createdAt: occurrence.createdAt,
              completedAt: occurrence.completedAt,
            })),
          },
          summary: `Read ${task.state} scheduled task in “${task.chatTitle}”.`,
          refs: [
            taskReference(task, context.locale),
            taskChatReference(task, context.locale),
          ],
          links: [{ rel: "open", href: chatHref(task.chatId) }],
        });
      },
    },
    "ai.chats.search": {
      title: "Search AI conversations",
      description:
        "Normal entry for finding the current user's AI conversations by text or exact Cloud resource refs. Use returned core.ai.chat refs with ai.chat.read, ai.chat.search, ai.chat.resources, task creation, or ai.chat.message.",
      input: ChatsSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const chats = await aiConversations.listConversations({
          ownerUserId: context.user.id,
          search: input.query || undefined,
          refs: input.refs,
          archived: input.archived,
          limit: input.limit,
        });
        return ok({ data: chats.map(toResourceView) });
      },
    },
    "ai.chat.read": {
      title: "Read an AI conversation",
      description:
        "Read visible text from one core.ai.chat ref returned by ai.chats.search, ai.tasks.list, or a Core Action. Use ai.chat.search for text lookup inside the known chat and ai.chat.resources for referenced Cloud resources.",
      input: ChatReadInputSchema,
      data: ChatMessagesDataSchema,
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const chat = await readableOwnedChat(input.id, context.user.id);
        if (!chat) return fail(err.notFound("Chat"));
        const beforeSeq = input.cursor === undefined ? undefined : Number(input.cursor);
        if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq <= 0)) return fail(err.badInput("Invalid cursor"));
        const page = await aiConversations.listMessagesPage({ conversationId: chat.id, beforeSeq, limit: input.limit });
        const oldestSeq = page.messages[0]?.seq;
        return ok({
          data: { chat: chatSummary(chat), messages: page.messages.flatMap((message) => visibleMessage(message) ?? []) },
          summary: `Read AI conversation “${chat.title}”.`,
          refs: [chatReference(chat)],
          links: [{ rel: "open", href: chatHref(chat.shortId) }],
          page: capabilityPage(page.hasMore && oldestSeq !== undefined ? String(oldestSeq) : undefined),
        });
      },
    },
    "ai.chat.search": {
      title: "Search messages in an AI conversation",
      description:
        "Search visible text inside one known core.ai.chat ref, including compacted history. Get chatId from ai.chats.search, ai.chat.read, or a core.ai.task ref; use ai.chat.read to browse without a search term.",
      input: ChatSearchInputSchema,
      data: ChatMessagesDataSchema,
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const chat = await readableOwnedChat(input.chatId, context.user.id);
        if (!chat) return fail(err.notFound("Chat"));
        const beforeSeq = input.cursor === undefined ? undefined : Number(input.cursor);
        if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq <= 0)) return fail(err.badInput("Invalid cursor"));
        const page = await aiConversations.searchConversationMessages({
          conversationId: chat.id,
          query: input.query,
          beforeSeq,
          limit: input.limit,
        });
        return ok({
          data: { chat: chatSummary(chat), messages: page.messages.flatMap((message) => visibleMessage(message) ?? []) },
          refs: [chatReference(chat)],
          links: [{ rel: "open", href: chatHref(chat.shortId) }],
          page: capabilityPage(page.nextCursor),
        });
      },
    },
    "ai.chat.resources": {
      title: "List resources used in an AI conversation",
      description:
        "List or search Cloud resource refs observed in one known core.ai.chat. Get chatId from ai.chats.search, ai.chat.read, or a core.ai.task ref; returned refs can be passed directly to their owning app readers.",
      input: ChatResourcesInputSchema,
      data: ChatResourcesDataSchema,
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const chat = await readableOwnedChat(input.chatId, context.user.id);
        if (!chat) return fail(err.notFound("Chat"));
        const page = await aiConversations.listConversationResources({
          conversationId: chat.id,
          search: input.query,
          before: input.cursor,
          limit: input.limit,
        });
        return ok({
          data: { chat: chatSummary(chat), resources: page.resources.map(resourceData) },
          refs: page.resources.map((resource) => resource.ref),
          links: [{ rel: "open", href: chatHref(chat.shortId) }],
          page: capabilityPage(page.nextCursor),
        });
      },
    },
    "ai.chats.resources": {
      title: "Search resources used across AI conversations",
      description:
        "Direct cross-chat entry for finding Cloud resources previously used in active AI conversations. Returned refs can be passed to their owning app readers; use ai.chat.resources when one chat is already known.",
      input: ChatsResourcesInputSchema,
      data: ChatsResourcesDataSchema,
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const page = await aiConversations.listUserConversationResources({
          ownerUserId: context.user.id,
          search: input.query,
          before: input.cursor,
          limit: input.limit,
        });
        return ok({
          data: page.resources.map((resource) => ({
            ...resourceData(resource),
            chat: { id: resource.chat.shortId, title: resource.chat.title, updatedAt: resource.chat.updatedAt },
          })),
          refs: page.resources.map((resource) => resource.ref),
          page: capabilityPage(page.nextCursor),
        });
      },
    },
  },
  actions: {
    "ai.skill.create": {
      title: "Create an Assistant Skill",
      description: "Create one reviewed reusable Skill owned by the current actor.",
      input: SkillCreateInputSchema,
      data: SkillDetailDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      async review(input, context) {
        if (!context.accessSubject) return fail(err.forbidden("Creating Skills requires an authenticated actor"));
        return ok({
          message: `Create Assistant Skill “${input.name}”.`,
          details: [
            { label: "Name", value: input.name },
            { label: "Description", value: input.description, display: "block" },
            { label: "Instructions", value: input.instructions, display: "block" },
          ],
        });
      },
      async run(input, context) {
        if (!context.accessSubject) return fail(err.forbidden("Creating Skills requires an authenticated actor"));
        try {
          const skill = await aiSkills.create({ subject: context.accessSubject, ...input });
          return ok({
            data: skillData(skill),
            summary: `Created Assistant Skill “${skill.name}”.`,
            refs: [{ type: "core.ai.skill", id: skill.shortId }],
          });
        } catch (error) {
          const result = skillRevisionError(error);
          if (result) return result;
          throw error;
        }
      },
    },
    "ai.skill.update": {
      title: "Update an Assistant Skill",
      description: "Update one or more main fields of a writable Skill after reviewing the exact changed content.",
      input: SkillUpdateInputSchema,
      data: SkillDetailDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      async review(input, context) {
        const skill = await readableSkill(input.skillId, context, "write");
        if (!skill) return fail(err.notFound("Skill"));
        if (skill.revision !== input.expectedRevision) return fail(err.conflict(new AiSkillRevisionConflictError().message));
        return ok({
          message: `Update Assistant Skill “${skill.name}”.`,
          details: [
            ...(input.name !== undefined ? [{ label: "Name", value: input.name }] : []),
            ...(input.description !== undefined ? [{ label: "Description", value: input.description, display: "block" as const }] : []),
            ...(input.instructions !== undefined ? [{ label: "Instructions", value: input.instructions, display: "block" as const }] : []),
          ],
        });
      },
      async run(input, context) {
        const skill = await readableSkill(input.skillId, context, "write");
        if (!skill) return fail(err.notFound("Skill"));
        try {
          const updated = await aiSkills.update(skill.id, context.accessSubject, {
            expectedRevision: input.expectedRevision,
            name: input.name ?? skill.name,
            description: input.description ?? skill.description,
            instructions: input.instructions ?? skill.instructions,
            extraFrontmatter: skill.extraFrontmatter,
            references: skill.references,
          });
          if (!updated) return fail(err.notFound("Skill"));
          return ok({
            data: skillData(updated),
            summary: `Updated Assistant Skill “${updated.name}”.`,
            refs: [{ type: "core.ai.skill", id: updated.shortId }],
          });
        } catch (error) {
          const result = skillRevisionError(error);
          if (result) return result;
          throw error;
        }
      },
    },
    "ai.skill.reference.set": {
      title: "Set an Assistant Skill reference",
      description:
        "Add or replace exactly one Markdown reference on a writable Skill. Use Set Assistant Skill references for two or more files.",
      input: SkillReferenceSetInputSchema,
      data: SkillDetailDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      async review(input, context) {
        const skill = await readableSkill(input.skillId, context, "write");
        if (!skill) return fail(err.notFound("Skill"));
        if (skill.revision !== input.expectedRevision) return fail(err.conflict(new AiSkillRevisionConflictError().message));
        return ok({
          message: `Set “${input.path}” on Assistant Skill “${skill.name}”.`,
          details: [
            { label: "Reference", value: input.path },
            { label: "Content", value: input.content, display: "block" },
          ],
          approvalScope: "skills",
        });
      },
      async run(input, context) {
        const skill = await readableSkill(input.skillId, context, "write");
        if (!skill) return fail(err.notFound("Skill"));
        try {
          const updated = await aiSkills.setReference(skill.id, context.accessSubject, input);
          if (!updated) return fail(err.notFound("Skill"));
          return ok({
            data: skillData(updated),
            summary: `Set “${input.path}” on Assistant Skill “${updated.name}”.`,
            refs: [{ type: "core.ai.skill", id: updated.shortId }],
          });
        } catch (error) {
          const result = skillRevisionError(error);
          if (result) return result;
          throw error;
        }
      },
    },
    "ai.skill.references.set": {
      title: "Set Assistant Skill references",
      description:
        "Atomically add or replace multiple Markdown references on one writable Skill after reviewing every complete bounded file.",
      input: SkillReferencesSetInputSchema,
      data: SkillDetailDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      async review(input, context) {
        const skill = await readableSkill(input.skillId, context, "write");
        if (!skill) return fail(err.notFound("Skill"));
        if (skill.revision !== input.expectedRevision) return fail(err.conflict(new AiSkillRevisionConflictError().message));
        return ok({
          message: `Set ${input.references.length} references on Assistant Skill “${skill.name}” in one revision.`,
          details: input.references.map((reference: z.infer<typeof SkillReferencesSetInputSchema>["references"][number]) => ({
            label: reference.path,
            value: reference.content,
            display: "block" as const,
          })),
          approvalScope: "skills",
        });
      },
      async run(input, context) {
        const skill = await readableSkill(input.skillId, context, "write");
        if (!skill) return fail(err.notFound("Skill"));
        try {
          const updated = await aiSkills.setReferences(skill.id, context.accessSubject, input);
          if (!updated) return fail(err.notFound("Skill"));
          return ok({
            data: skillData(updated),
            summary: `Set ${input.references.length} references on Assistant Skill “${updated.name}”.`,
            refs: [{ type: "core.ai.skill", id: updated.shortId }],
          });
        } catch (error) {
          const result = skillRevisionError(error);
          if (result) return result;
          throw error;
        }
      },
    },
    "ai.skill.reference.remove": {
      title: "Remove an Assistant Skill reference",
      description: "Remove one exact Markdown reference from a writable Skill after review.",
      input: SkillReferenceRemoveInputSchema,
      data: SkillDetailDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      async review(input, context) {
        const skill = await readableSkill(input.skillId, context, "write");
        if (!skill?.references.some((reference) => reference.path === input.path)) return fail(err.notFound("Skill reference"));
        if (skill.revision !== input.expectedRevision) return fail(err.conflict(new AiSkillRevisionConflictError().message));
        return ok({
          message: `Remove “${input.path}” from Assistant Skill “${skill.name}”.`,
          details: [{ label: "Reference", value: input.path }],
        });
      },
      async run(input, context) {
        const skill = await readableSkill(input.skillId, context, "write");
        if (!skill) return fail(err.notFound("Skill"));
        try {
          const updated = await aiSkills.removeReference(skill.id, context.accessSubject, input);
          if (!updated) return fail(err.notFound("Skill reference"));
          return ok({
            data: skillData(updated),
            summary: `Removed “${input.path}” from Assistant Skill “${updated.name}”.`,
            refs: [{ type: "core.ai.skill", id: updated.shortId }],
          });
        } catch (error) {
          const result = skillRevisionError(error);
          if (result) return result;
          throw error;
        }
      },
    },
    "ai.skill.enabled.set": {
      title: "Set personal Assistant Skill state",
      description: "Enable or disable one readable Skill only for the current user after review; Cloud access remains unchanged.",
      input: SkillEnabledSetInputSchema,
      data: z.object({ skillId: SkillIdSchema, name: SkillNameSchema, enabled: z.boolean() }).strict(),
      destructive: true,
      openWorld: false,
      idempotency: "none",
      async review(input, context) {
        if (!context.user) return fail(err.forbidden("Personal Skill state requires a user-backed actor"));
        const skill = await readableSkill(input.skillId, context);
        if (!skill) return fail(err.notFound("Skill"));
        return ok({
          message: `${input.enabled ? "Enable" : "Disable"} Assistant Skill “${skill.name}” for ${context.user.displayName}.`,
          details: [{ label: "Personal state", value: input.enabled ? "Enabled" : "Disabled" }],
        });
      },
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("Personal Skill state requires a user-backed actor"));
        const skill = await readableSkill(input.skillId, context);
        if (!skill) return fail(err.notFound("Skill"));
        const enabled = await aiSkills.setEnabled(skill.id, context.accessSubject, input.enabled);
        if (enabled === null) return fail(err.notFound("Skill"));
        return ok({
          data: { skillId: skill.shortId, name: skill.name, enabled },
          summary: `${enabled ? "Enabled" : "Disabled"} Assistant Skill “${skill.name}” for the current user.`,
          refs: [{ type: "core.ai.skill", id: skill.shortId }],
        });
      },
    },
    "ai.skill.delete": {
      title: "Delete an Assistant Skill",
      description: "Permanently delete one administered Skill, all references, and all access grants after review.",
      input: SkillDeleteInputSchema,
      data: z.object({ deleted: z.literal(true) }).strict(),
      destructive: true,
      openWorld: false,
      idempotency: "none",
      async review(input, context) {
        const skill = await readableSkill(input.skillId, context, "admin");
        if (!skill) return fail(err.notFound("Skill"));
        return ok({
          message: `Delete Assistant Skill “${skill.name}”.`,
          details: [
            { label: "Description", value: skill.description, display: "block" },
            { label: "References", value: String(skill.referenceCount) },
          ],
        });
      },
      async run(input, context) {
        const skill = await readableSkill(input.skillId, context, "admin");
        if (!skill || !(await aiSkills.delete(skill.id, context.accessSubject))) return fail(err.notFound("Skill"));
        return ok({ data: { deleted: true as const }, summary: `Deleted Assistant Skill “${skill.name}”.` });
      },
    },
    "ai.task.create": {
      title: "Create a scheduled AI task",
      description:
        "Create one reviewed future prompt in an owned AI conversation. Resolve relative user wording to localAt before calling.",
      input: ChatTaskCreateInputSchema,
      data: ChatTaskDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const chat = await ownedChat(input.chatId, context.user.id);
        if (!chat) return fail(err.notFound("Chat"));
        try {
          const normalized = await normalizeChatTaskSchedule(input.schedule, input.timezone);
          const schedule = normalized.schedule.kind === "once" ? normalized.schedule.runAt : normalized.schedule.cron;
          return ok({
            message: `Create a scheduled task in ${chat.title} (${chat.shortId}).`,
            details: [
              { label: "Chat", value: `${chat.title} (${chat.shortId})` },
              { label: "Schedule", value: `${schedule} (${normalized.timezone})` },
              { label: "Prompt", value: input.prompt, display: "block" },
            ],
          });
        } catch (error) {
          return fail(err.badInput(error instanceof Error ? error.message : "Invalid schedule"));
        }
      },
      async run(input, context) {
        if (!context.user || !context.idempotencyKey) return fail(err.forbidden("Scheduled tasks require an idempotent user action"));
        const idempotencyFingerprint = chatTaskCreateFingerprint(input);
        try {
          const replay = await aiChatTasks.getCreateByIdempotency({
            userId: context.user.id,
            idempotencyKey: context.idempotencyKey,
            idempotencyFingerprint,
          });
          if (replay)
            return ok({
              data: taskData(replay),
              summary: `Scheduled a task in ${taskChatTitle(replay)}.`,
              refs: [
                taskReference(replay, context.locale),
                taskChatReference(replay, context.locale),
              ],
            });
        } catch (error) {
          if (error instanceof AiChatTaskIdempotencyConflictError) return fail(capabilityIdempotencyConflict(error.message));
          throw error;
        }
        let normalized: Awaited<ReturnType<typeof normalizeChatTaskSchedule>>;
        try {
          normalized = await normalizeChatTaskSchedule(input.schedule, input.timezone);
        } catch (error) {
          return fail(err.badInput(error instanceof Error ? error.message : "Invalid schedule"));
        }
        let task: AiChatTask | null;
        try {
          task = await aiChatTasks.create({
            userId: context.user.id,
            chatId: input.chatId,
            prompt: input.prompt,
            ...normalized,
            idempotencyKey: context.idempotencyKey,
            idempotencyFingerprint,
          });
        } catch (error) {
          if (error instanceof AiChatTaskIdempotencyConflictError) return fail(capabilityIdempotencyConflict(error.message));
          throw error;
        }
        if (!task) return fail(err.notFound("Chat"));
        void reconcileAiChatTasks().catch(() => undefined);
        return ok({
          data: taskData(task),
          summary: `Scheduled a task in ${taskChatTitle(task)}.`,
          refs: [
            taskReference(task, context.locale),
            taskChatReference(task, context.locale),
          ],
        });
      },
    },
    "ai.task.update": {
      title: "Update a scheduled AI task",
      description: "Update the prompt or future schedule of one owned task after reviewing the exact replacement.",
      input: ChatTaskUpdateInputSchema,
      data: ChatTaskDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      async review(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const task = await aiChatTasks.get({ userId: context.user.id, taskId: input.taskId });
        if (!task) return fail(err.notFound("Task"));
        try {
          const normalized = input.schedule ? await normalizeChatTaskSchedule(input.schedule, input.timezone) : null;
          const nextSchedule = normalized?.schedule ?? task.schedule;
          return ok({
            message: `Update scheduled task ${task.shortId}.`,
            details: [
              { label: "Chat", value: `${task.chatTitle} (${task.chatId})` },
              {
                label: "Schedule",
                value: taskScheduleLabel({ ...task, schedule: nextSchedule, timezone: normalized?.timezone ?? task.timezone }),
              },
              { label: "Prompt", value: input.prompt ?? task.prompt, display: "block" },
            ],
          });
        } catch (error) {
          return fail(err.badInput(error instanceof Error ? error.message : "Invalid schedule"));
        }
      },
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        let normalized: Partial<Awaited<ReturnType<typeof normalizeChatTaskSchedule>>> = {};
        try {
          if (input.schedule) normalized = await normalizeChatTaskSchedule(input.schedule, input.timezone);
        } catch (error) {
          return fail(err.badInput(error instanceof Error ? error.message : "Invalid schedule"));
        }
        const task = await aiChatTasks.update({
          userId: context.user.id,
          taskId: input.taskId,
          prompt: input.prompt,
          ...normalized,
        });
        if (!task) return fail(err.notFound("Task"));
        void reconcileAiChatTasks().catch(() => undefined);
        return ok({
          data: taskData(task),
          summary: taskUpdateSummary(input, task),
          refs: [taskReference(task, context.locale)],
        });
      },
    },
    "ai.task.pause": {
      title: "Pause a scheduled AI task",
      description: "Pause one owned scheduled task after review.",
      input: ChatTaskIdInputSchema,
      data: ChatTaskDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      async review(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const task = await aiChatTasks.get({ userId: context.user.id, taskId: input.taskId });
        if (!task) return fail(err.notFound("Task"));
        const stateError = invalidTaskState(task, "pause");
        if (stateError) return fail(err.conflict(stateError));
        return ok({
          message: `Pause scheduled task ${task.shortId}.`,
          details: [
            { label: "Task", value: task.prompt, display: "block" },
            { label: "Schedule", value: taskScheduleLabel(task) },
          ],
          approvalScope: `task:${task.shortId}`,
        });
      },
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const current = await aiChatTasks.get({ userId: context.user.id, taskId: input.taskId });
        if (!current) return fail(err.notFound("Task"));
        const stateError = invalidTaskState(current, "pause");
        if (stateError) return fail(err.conflict(stateError));
        const task = await aiChatTasks.setState({
          userId: context.user.id,
          taskId: input.taskId,
          state: "paused",
        });
        if (!task) return fail(err.conflict("Task state changed; read it and retry"));
        void reconcileAiChatTasks().catch(() => undefined);
        return ok({
          data: taskData(task),
          summary: `Paused the scheduled task in ${taskChatTitle(task)}.`,
          refs: [taskReference(task, context.locale)],
        });
      },
    },
    "ai.task.resume": {
      title: "Resume a scheduled AI task",
      description: "Resume one owned scheduled task after review.",
      input: ChatTaskIdInputSchema,
      data: ChatTaskDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      async review(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const task = await aiChatTasks.get({ userId: context.user.id, taskId: input.taskId });
        if (!task) return fail(err.notFound("Task"));
        const stateError = invalidTaskState(task, "resume");
        if (stateError) return fail(err.conflict(stateError));
        return ok({
          message: `Resume scheduled task ${task.shortId}.`,
          details: [
            { label: "Task", value: task.prompt, display: "block" },
            { label: "Schedule", value: taskScheduleLabel(task) },
          ],
        });
      },
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const current = await aiChatTasks.get({ userId: context.user.id, taskId: input.taskId });
        if (!current) return fail(err.notFound("Task"));
        const stateError = invalidTaskState(current, "resume");
        if (stateError) return fail(err.conflict(stateError));
        const task = await aiChatTasks.setState({
          userId: context.user.id,
          taskId: input.taskId,
          state: "active",
        });
        if (!task) return fail(err.conflict("Task state changed; read it and retry"));
        void reconcileAiChatTasks().catch(() => undefined);
        return ok({
          data: taskData(task),
          summary: `Resumed the scheduled task in ${taskChatTitle(task)}.`,
          refs: [taskReference(task, context.locale)],
        });
      },
    },
    "ai.task.run": {
      title: "Run a scheduled AI task now",
      description: "Queue one manual occurrence without changing the future schedule.",
      input: ChatTaskIdInputSchema,
      data: z.object({ id: ChatTaskOccurrenceIdSchema, state: z.enum(["queued", "running", "completed", "failed"]) }),
      destructive: false,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const task = await aiChatTasks.get({ userId: context.user.id, taskId: input.taskId });
        if (!task) return fail(err.notFound("Task"));
        const stateError = invalidTaskState(task, "run");
        if (stateError) return fail(err.conflict(stateError));
        return ok({
          message: `Run scheduled task ${task.shortId} now.`,
          details: [
            { label: "Chat", value: `${task.chatTitle} (${task.chatId})` },
            { label: "Prompt", value: task.prompt, display: "block" },
          ],
        });
      },
      async run(input, context) {
        if (!context.user || !context.idempotencyKey) return fail(err.forbidden("Scheduled tasks require an idempotent user action"));
        const task = await aiChatTasks.get({ userId: context.user.id, taskId: input.taskId });
        if (!task) return fail(err.notFound("Task"));
        let occurrence: Awaited<ReturnType<typeof aiChatTasks.createOccurrence>>;
        try {
          occurrence = await aiChatTasks.createOccurrence({
            taskId: task.id,
            scheduledFor: new Date().toISOString(),
            trigger: "manual",
            requestKey: `manual:${CORE_APP_ID}:${context.user.id}:${context.idempotencyKey}`,
          });
        } catch (error) {
          if (error instanceof AiChatTaskIdempotencyConflictError) return fail(capabilityIdempotencyConflict(error.message));
          throw error;
        }
        if (!occurrence) return fail(err.conflict("This task already has a queued or running occurrence"));
        void aiChatTaskRuntime.recover().catch(() => undefined);
        return ok({
          data: { id: occurrence.shortId, state: occurrence.state },
          summary: `Queued a run of the scheduled task in ${taskChatTitle(task)}.`,
          refs: [taskReference(task, context.locale)],
        });
      },
    },
    "ai.task.delete": {
      title: "Delete a scheduled AI task",
      description: "Delete one task and all of its occurrence history after review.",
      input: ChatTaskIdInputSchema,
      data: z.object({ deleted: z.literal(true) }),
      destructive: true,
      openWorld: false,
      idempotency: "none",
      async review(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const task = await aiChatTasks.get({ userId: context.user.id, taskId: input.taskId });
        if (!task) return fail(err.notFound("Task"));
        return ok({
          message: `Delete scheduled task ${task.shortId} and its run history.`,
          details: [
            { label: "Chat", value: `${task.chatTitle} (${task.chatId})` },
            { label: "Prompt", value: task.prompt, display: "block" },
            { label: "Schedule", value: taskScheduleLabel(task) },
          ],
        });
      },
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const task = await aiChatTasks.get({ userId: context.user.id, taskId: input.taskId });
        if (!task) return fail(err.notFound("Task"));
        if (!(await aiChatTasks.delete({ userId: context.user.id, taskId: input.taskId }))) return fail(err.notFound("Task"));
        void reconcileAiChatTasks().catch(() => undefined);
        return ok({ data: { deleted: true as const }, summary: `Deleted the scheduled task in ${taskChatTitle(task)}.` });
      },
    },
    "ai.chat.message": {
      title: "Message another AI conversation",
      description: "Queue one attributable message for another owned AI conversation after reviewing the exact target and text.",
      input: ChatMessageInputSchema,
      data: ChatMessageDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const target = await ownedChat(input.chatId, context.user.id);
        if (!target) return fail(err.notFound("Chat"));
        return ok({
          message: `Send this message to ${target.title} (${target.shortId}).`,
          details: [
            { label: "Target chat", value: `${target.title} (${target.shortId})` },
            { label: "Message", value: input.text, display: "block" },
          ],
          links: [{ rel: "open", href: chatHref(target.shortId), title: "Open target chat" }],
        });
      },
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        if (!context.idempotencyKey) return fail(err.badInput("Idempotency-Key is required"));
        const origin = await aiConversations.getCapabilityInvocationOrigin({
          idempotencyKey: context.idempotencyKey,
          toolName: CHAT_MESSAGE_TOOL_NAME,
        });
        if (!origin) return fail(err.forbidden("Inter-chat messages require an AI conversation turn"));
        const created = await aiConversations.createInterChatMessage({
          sourceConversationId: origin.conversationId,
          sourceTurnId: origin.turnId,
          sourceCallId: origin.callId,
          targetChatId: input.chatId,
          actorUserId: context.user.id,
          text: input.text,
          idempotencyKey: context.idempotencyKey,
        });
        if (!created.ok) {
          if (created.reason === "same_chat") return fail(err.badInput("Choose another chat"));
          if (created.reason === "recursive")
            return fail(err.forbidden("A turn started by an inter-chat message cannot message another chat"));
          return fail(err.notFound("Chat"));
        }
        if (created.message.status === "failed") return fail(err.conflict("The target chat could not accept the message"));
        const delivery =
          created.message.status === "delivered" ? null : await deliverPendingAiMessages(created.message.targetConversationId);
        const status = created.message.status === "delivered" ? "delivered" : (delivery?.get(created.message.id) ?? "queued");
        if (status === "failed") return fail(err.conflict("The target chat could not accept the message"));
        return ok({
          data: { id: created.message.shortId, status, targetChatId: created.message.targetChatId },
          summary:
            status === "delivered"
              ? `Sent a message to “${created.message.targetTitle}”.`
              : `Queued a message for “${created.message.targetTitle}”.`,
          refs: [{ type: "core.ai.chat", id: created.message.targetChatId, title: created.message.targetTitle,
            preview: referenceMessages.resolve([context.locale]).t.chat, icon: "ti ti-message-chatbot" }],
          links: [{ rel: "open", href: chatHref(created.message.targetChatId) }],
        });
      },
    },
  },
});
