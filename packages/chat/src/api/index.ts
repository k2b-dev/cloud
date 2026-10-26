import {
  type AuthContext,
  auth,
  getLocale,
  jsonResponse,
  rateLimit,
  requiresAdmin,
  requiresAuth,
  respond,
  validator,
} from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ChatComposeInputSchema } from "../commands";
import { chatMessages } from "../messages";
import { ChatHealthSchema, chatService } from "../service";
import {
  AddMembersSchema,
  ChangeSchema,
  ChangesPageSchema,
  ChangesQuerySchema,
  ChatSnapshotSchema,
  ConversationPageSchema,
  ConversationParamSchema,
  ConversationQuerySchema,
  ConversationSchema,
  CreateConversationSchema,
  CreateOutcomeSchema,
  CreateThreadSchema,
  LeaveSchema,
  MarkUnreadSchema,
  MemberPageSchema,
  MemberParamSchema,
  MemberPreviewSchema,
  MemberQuerySchema,
  MemberRemovalSchema,
  MessagePageSchema,
  MessageParamSchema,
  MessageQuerySchema,
  MessageViewSchema,
  PeoplePageSchema,
  PeopleQuerySchema,
  ReadAllOutcomeSchema,
  ReadAllSchema,
  ReadSchema,
  ReadUpdateSchema,
  SendMessageSchema,
  SnapshotQuerySchema,
  SuccessSchema,
  ThreadListSchema,
  ThreadParamSchema,
  ThreadSchema,
  UpdateConversationSchema,
  UpdateMemberSchema,
  UpdateThreadSchema,
} from "../service/contracts";
import { chatLive } from "../service/live";
import { chatLiveChannels } from "../service/live-channels";

const context = (c: Context<AuthContext>) => ({ actor: c.get("actor"), accessSubject: c.get("accessSubject"), locale: getLocale(c) });
const invalidInput = (c: Context) => ({ code: "BAD_INPUT", message: chatMessages.resolve([getLocale(c)]).t.invalidInput });
const description = (summary: string, schema: z.ZodType) =>
  describeRoute({
    tags: ["Chat"],
    summary,
    ...requiresAuth,
    responses: { 200: jsonResponse(schema, summary) },
  });
const app = new Hono<AuthContext>()
  .use(rateLimit())
  .get(
    "/admin/health",
    auth.requireRole("admin"),
    describeRoute({
      tags: ["Chat"],
      summary: "Read the chat app's operational health",
      ...requiresAdmin,
      responses: { 200: jsonResponse(ChatHealthSchema, "Health snapshot") },
    }),
    async (c) => respond(c, ok(await chatService.health())),
  )
  .route("/live", chatLive.routes(chatLiveChannels))
  .get(
    "/people/:userId",
    auth.requireRole("user", "guest"),
    description("Resolve a person selectable in New chat without creating a chat", PeoplePageSchema.shape.items.element),
    validator("param", ChatComposeInputSchema, invalidInput),
    async (c) => respond(c, chatService.conversations.resolvePerson({ ...context(c), input: c.req.valid("param") })),
  )
  .get(
    "/people",
    auth.requireRole("authenticated"),
    description("Find people you share a chat with", PeoplePageSchema),
    validator("query", PeopleQuerySchema, invalidInput),
    async (c) => {
      const { search, cursor } = c.req.valid("query");
      return respond(
        c,
        chatService.conversations.people({ ...context(c), query: { search, ...(cursor ? { cursor: JSON.stringify(cursor) } : {}) } }),
      );
    },
  )
  .use("/conversations", auth.requireRole("authenticated"))
  .use("/conversations/*", auth.requireRole("authenticated"))
  .post(
    "/conversations",
    describeRoute({
      tags: ["Chat"],
      summary: "Create a chat or find chats with the same direct members",
      description:
        "Pass an optional createKey UUID for safe retries of one immutable create intent per access subject. A successful key is retained for the lifetime of the chat and subject; replay returns the current chat only with current read access. Changed normalized input returns 409. Existing-match responses do not reserve the key. Callers without a key keep the member-match behavior and have no retry guarantee for groups or allowDuplicate.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(CreateOutcomeSchema, "Existing chats"),
        201: jsonResponse(CreateOutcomeSchema, "Created chat or authorized replay"),
        409: jsonResponse(z.object({ code: z.literal("CONFLICT"), message: z.string() }), "Create key already used with different input"),
        // The request limiter answers without a code; only the new-chat limit sends RATE_LIMITED.
        429: jsonResponse(
          z.object({ code: z.literal("RATE_LIMITED").optional(), message: z.string() }),
          "Request or new-chat rate limit reached",
        ),
      },
    }),
    validator("json", CreateConversationSchema, invalidInput),
    async (c) => {
      const result = await chatService.conversations.create({ ...context(c), input: c.req.valid("json") });
      return respond(c, result, result.ok && result.data.outcome === "created" ? 201 : 200);
    },
  )
  .get(
    "/conversations",
    description("List your chats", ConversationPageSchema),
    validator("query", ConversationQuerySchema, invalidInput),
    async (c) => {
      // The transport validator decodes the cursor; the service validates its own public input.
      const cursor = c.req.valid("query").cursor;
      return respond(c, chatService.conversations.list({ ...context(c), query: cursor ? { cursor: JSON.stringify(cursor) } : {} }));
    },
  )
  .post(
    "/conversations/read-all",
    description("Mark your unread chats read", ReadAllOutcomeSchema),
    validator("json", ReadAllSchema, invalidInput),
    async (c) => respond(c, chatService.readState.readAll({ ...context(c), input: c.req.valid("json") })),
  )
  .post(
    "/conversations/:conversation/read",
    description("Advance your read position", ReadUpdateSchema),
    validator("param", ConversationParamSchema, invalidInput),
    validator("json", ReadSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.readState.read({ ...context(c), conversationId: c.req.valid("param").conversation, input: c.req.valid("json") }),
      ),
  )
  .post(
    "/conversations/:conversation/unread",
    description("Mark a chat unread for yourself", ReadUpdateSchema),
    validator("param", ConversationParamSchema, invalidInput),
    validator("json", MarkUnreadSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.readState.markUnread({ ...context(c), conversationId: c.req.valid("param").conversation, input: c.req.valid("json") }),
      ),
  )
  .get(
    "/conversations/:conversation",
    description("Read a chat", ConversationSchema),
    validator("param", ConversationParamSchema, invalidInput),
    async (c) => respond(c, chatService.conversations.get({ ...context(c), conversationId: c.req.valid("param").conversation })),
  )
  .get(
    "/conversations/:conversation/snapshot",
    describeRoute({
      tags: ["Chat"],
      summary: "Open a chat: details, a page of history, and the live cursor",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ChatSnapshotSchema, "Chat snapshot"),
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Chat not found"),
      },
    }),
    validator("param", ConversationParamSchema, invalidInput),
    validator("query", SnapshotQuerySchema, invalidInput),
    async (c) => {
      const cursor = await chatLive.cursor();
      const result = await chatService.messages.snapshot({
        ...context(c),
        conversationId: c.req.valid("param").conversation,
        messageId: c.req.valid("query").message,
        thread: c.req.valid("query").thread,
      });
      return respond(c, result.ok ? ok({ cursor, ...result.data }) : result);
    },
  )
  .patch(
    "/conversations/:conversation",
    description("Change chat details", ConversationSchema),
    validator("param", ConversationParamSchema, invalidInput),
    validator("json", UpdateConversationSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.conversations.update({
          ...context(c),
          conversationId: c.req.valid("param").conversation,
          input: c.req.valid("json"),
        }),
      ),
  )
  .get(
    "/conversations/:conversation/threads",
    description("List all chat threads, including archived threads", ThreadListSchema),
    validator("param", ConversationParamSchema, invalidInput),
    async (c) => respond(c, chatService.threads.list({ ...context(c), conversationId: c.req.valid("param").conversation })),
  )
  .post(
    "/conversations/:conversation/threads",
    describeRoute({
      tags: ["Chat"],
      summary: "Create a chat thread",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ThreadSchema, "Idempotent retry"),
        201: jsonResponse(ThreadSchema, "Created thread"),
        403: jsonResponse(z.object({ code: z.literal("FORBIDDEN"), message: z.string() }), "Chat admin permission required"),
        409: jsonResponse(
          z.object({ code: z.enum(["THREAD_NAME_TAKEN", "THREAD_LIMIT", "THREADS_UNAVAILABLE", "CONFLICT"]), message: z.string() }),
          "Name, limit, channel or create intent conflict",
        ),
      },
    }),
    validator("param", ConversationParamSchema, invalidInput),
    validator("json", CreateThreadSchema, invalidInput),
    async (c) => {
      const result = await chatService.threads.create({
        ...context(c),
        conversationId: c.req.valid("param").conversation,
        input: c.req.valid("json"),
      });
      return result.ok ? respond(c, ok(result.data.thread), result.data.created ? 201 : 200) : respond(c, result);
    },
  )
  .patch(
    "/conversations/:conversation/threads/:thread",
    describeRoute({
      tags: ["Chat"],
      summary: "Rename, describe, archive or restore a chat thread",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ThreadSchema, "Updated thread"),
        403: jsonResponse(z.object({ code: z.literal("FORBIDDEN"), message: z.string() }), "Chat admin permission required"),
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Thread not in this chat"),
        409: jsonResponse(
          z.object({ code: z.literal("THREAD_NAME_TAKEN"), message: z.string() }),
          "Name already used, including archived threads",
        ),
      },
    }),
    validator("param", ThreadParamSchema, invalidInput),
    validator("json", UpdateThreadSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.threads.update({
          ...context(c),
          conversationId: c.req.valid("param").conversation,
          threadId: c.req.valid("param").thread,
          input: c.req.valid("json"),
        }),
      ),
  )
  .post(
    "/conversations/:conversation/messages",
    describeRoute({
      tags: ["Chat"],
      summary: "Post a Markdown message",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageViewSchema, "Idempotent retry"),
        201: jsonResponse(MessageViewSchema, "Posted message"),
        400: jsonResponse(z.object({ code: z.string(), message: z.string() }), "Invalid input or reply thread mismatch"),
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Chat, thread or reply target not found"),
        409: jsonResponse(z.object({ code: z.literal("THREAD_ARCHIVED"), message: z.string() }), "Thread is archived"),
        429: {
          ...jsonResponse(
            z.object({ code: z.literal("RATE_LIMITED").optional(), message: z.string() }),
            "Send or request rate limit reached",
          ),
          headers: { "Retry-After": { description: "Seconds until retry", schema: { type: "integer", minimum: 1 } } },
        },
      },
    }),
    validator("param", ConversationParamSchema, invalidInput),
    validator("json", SendMessageSchema, invalidInput),
    async (c) => {
      const result = await chatService.messages.send({
        ...context(c),
        conversationId: c.req.valid("param").conversation,
        input: c.req.valid("json"),
      });
      if (!result.ok) {
        if ("retryAfter" in result) c.header("Retry-After", String(result.retryAfter));
        return respond(c, result);
      }
      return respond(c, ok(result.data.message), result.data.created ? 201 : 200);
    },
  )
  .get(
    "/conversations/:conversation/messages",
    description("Page through chat history", MessagePageSchema),
    validator("param", ConversationParamSchema, invalidInput),
    validator("query", MessageQuerySchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.messages.list({ ...context(c), conversationId: c.req.valid("param").conversation, query: c.req.valid("query") }),
      ),
  )
  .get(
    "/conversations/:conversation/messages/:message",
    description("Read a message and its sequence position", MessageViewSchema),
    validator("param", MessageParamSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.messages.get({
          ...context(c),
          conversationId: c.req.valid("param").conversation,
          messageId: c.req.valid("param").message,
        }),
      ),
  )
  .get(
    "/conversations/:conversation/changes",
    describeRoute({
      tags: ["Chat"],
      summary: "Catch up with chat changes",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ChangesPageSchema, "Changes and snapshot watermark"),
        409: jsonResponse(
          z.object({ code: z.literal("RESYNC_REQUIRED"), message: z.string() }),
          "Watermark exceeds the restored chat head",
        ),
      },
    }),
    validator("param", ConversationParamSchema, invalidInput),
    validator("query", ChangesQuerySchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.messages.changes({ ...context(c), conversationId: c.req.valid("param").conversation, query: c.req.valid("query") }),
      ),
  )
  .get(
    "/conversations/:conversation/members",
    description("Read people and group chat members", MemberPageSchema),
    validator("param", ConversationParamSchema, invalidInput),
    validator("query", MemberQuerySchema, invalidInput),
    async (c) => {
      const { q, cursor } = c.req.valid("query");
      return respond(
        c,
        chatService.conversations.members.list({
          ...context(c),
          conversationId: c.req.valid("param").conversation,
          query: { q, ...(cursor ? { cursor: JSON.stringify(cursor) } : {}) },
        }),
      );
    },
  )
  .post(
    "/conversations/:conversation/members/preview",
    auth.readOnly,
    description("Preview people joining a chat through people and groups", MemberPreviewSchema),
    validator("param", ConversationParamSchema, invalidInput),
    validator("json", AddMembersSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.conversations.members.preview({
          ...context(c),
          conversationId: c.req.valid("param").conversation,
          input: c.req.valid("json"),
        }),
      ),
  )
  .post(
    "/conversations/:conversation/members",
    description("Add people and groups to a chat", ChangeSchema),
    validator("param", ConversationParamSchema, invalidInput),
    validator("json", AddMembersSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.conversations.members.add({
          ...context(c),
          conversationId: c.req.valid("param").conversation,
          input: c.req.valid("json"),
        }),
      ),
  )
  .patch(
    "/conversations/:conversation/members/:accessId",
    description("Change a direct member's permission", SuccessSchema),
    validator("param", MemberParamSchema, invalidInput),
    validator("json", UpdateMemberSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.conversations.members.update({
          ...context(c),
          conversationId: c.req.valid("param").conversation,
          accessId: c.req.valid("param").accessId,
          input: c.req.valid("json"),
        }),
      ),
  )
  .delete(
    "/conversations/:conversation/members/:accessId",
    description("Remove a person or group member", MemberRemovalSchema),
    validator("param", MemberParamSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.conversations.members.remove({
          ...context(c),
          conversationId: c.req.valid("param").conversation,
          accessId: c.req.valid("param").accessId,
        }),
      ),
  )
  .post(
    "/conversations/:conversation/leave",
    description("Leave a chat, handing over management when needed", MemberRemovalSchema),
    validator("param", ConversationParamSchema, invalidInput),
    validator("json", LeaveSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.conversations.leave({ ...context(c), conversationId: c.req.valid("param").conversation, input: c.req.valid("json") }),
      ),
  );

export default app;
export type ApiType = typeof app;
