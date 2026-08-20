import { err, fail, ok } from "@k2b/stdlib";
import {
  AI_SHORT_ID_PATTERN,
  type AiChatTask,
  AiChatTaskIdempotencyConflictError,
  type AiConversation,
  type AiConversationResourceRef,
  type AiStoredMessage,
  aiCapabilityToolName,
  aiChatTasks,
  aiConversations,
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

const CORE_APP_ID = "core";
const MAX_MESSAGE_TEXT_CHARS = 8_000;
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
const CHAT_MESSAGE_TOOL_NAME = aiCapabilityToolName(CORE_APP_ID, "action", "chat.message");
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
  .object({ id: ChatTaskIdSchema.describe("Scheduled-task ID returned by List scheduled AI tasks or a core.task ref.") })
  .strict();
const ChatTasksListInputSchema = z
  .object({
    chatId: ChatIdSchema.optional().describe("Optional AI conversation ID returned by chat search/read or a core.chat ref."),
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
  ref: z.object({ type: z.literal("core.task"), id: ChatTaskIdSchema }).strict(),
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
  ref: { type: "core.chat", id: chat.shortId },
  title: chat.title,
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
  types: {
    chat: {
      title: "AI conversation",
      description: "A private AI conversation owned by the current user.",
      icon: "ti ti-message-chatbot",
      reader: "chat.read",
    },
    task: {
      title: "Scheduled AI task",
      description: "A one-time or recurring prompt attached to an owned AI conversation.",
      icon: "ti ti-calendar-clock",
      reader: "task.read",
    },
  },
  queries: {
    "tasks.list": {
      title: "List scheduled AI tasks",
      description:
        "List the current user's chat-bound scheduled tasks, optionally for one chat or state. Each item includes a core.task ref for Read a scheduled AI task.",
      input: ChatTasksListInputSchema,
      data: z.array(ChatTaskListItemDataSchema),
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("Scheduled tasks require a user-backed actor"));
        const offset = Number(input.cursor ?? "0");
        const tasks = await aiChatTasks.list({ userId: context.user.id, ...input, offset, limit: input.limit + 1 });
        const items = tasks.slice(0, input.limit);
        return ok({
          data: items.map((task) => ({ ...taskData(task), ref: { type: "core.task" as const, id: task.shortId } })),
          refs: items.map((task) => ({ type: "core.task", id: task.shortId })),
          page: capabilityPage(tasks.length > input.limit ? String(offset + input.limit) : undefined),
        });
      },
    },
    "task.read": {
      title: "Read a scheduled AI task",
      description: "Read one owned scheduled task from a core.task ref or task ID, including its recent occurrence history.",
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
          refs: [
            { type: "core.task", id: task.shortId },
            { type: "core.chat", id: task.chatId },
          ],
          links: [{ rel: "open", href: chatHref(task.chatId) }],
        });
      },
    },
    "chats.search": {
      title: "Search AI conversations",
      description: "Find the current user's AI conversations by text and exact Cloud resource refs.",
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
    "chat.read": {
      title: "Read an AI conversation",
      description: "Read one page of visible user and assistant text from one explicitly identified owned chat.",
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
          refs: [{ type: "core.chat", id: chat.shortId }],
          links: [{ rel: "open", href: chatHref(chat.shortId) }],
          page: capabilityPage(page.hasMore && oldestSeq !== undefined ? String(oldestSeq) : undefined),
        });
      },
    },
    "chat.search": {
      title: "Search messages in an AI conversation",
      description: "Search visible text inside one explicitly identified owned AI conversation, including compacted history.",
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
          refs: [{ type: "core.chat", id: chat.shortId }],
          links: [{ rel: "open", href: chatHref(chat.shortId) }],
          page: capabilityPage(page.nextCursor),
        });
      },
    },
    "chat.resources": {
      title: "List resources used in an AI conversation",
      description: "List or search structured Cloud resource refs observed in one explicitly identified owned chat.",
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
    "chats.resources": {
      title: "Search resources used across AI conversations",
      description: "List or search structured Cloud resource refs across the current user's active AI conversations.",
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
    "task.create": {
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
                { type: "core.task", id: replay.shortId },
                { type: "core.chat", id: replay.chatId },
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
            { type: "core.task", id: task.shortId },
            { type: "core.chat", id: task.chatId },
          ],
        });
      },
    },
    "task.update": {
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
          refs: [{ type: "core.task", id: task.shortId }],
        });
      },
    },
    "task.pause": {
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
          refs: [{ type: "core.task", id: task.shortId }],
        });
      },
    },
    "task.resume": {
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
          refs: [{ type: "core.task", id: task.shortId }],
        });
      },
    },
    "task.run": {
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
          refs: [{ type: "core.task", id: task.shortId }],
        });
      },
    },
    "task.delete": {
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
    "chat.message": {
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
          refs: [{ type: "core.chat", id: created.message.targetChatId }],
          links: [{ rel: "open", href: chatHref(created.message.targetChatId) }],
        });
      },
    },
  },
});
