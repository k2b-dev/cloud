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
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { chatMessages } from "../messages";
import { chatRequestContext as context } from "../request-context";
import { ChatHealthSchema, chatService } from "../service";
import { attachmentHeaders } from "../service/attachment-content";
import {
  AddMembersSchema,
  AttachmentParamSchema,
  AttachmentViewSchema,
  ChangeSchema,
  ChangesPageSchema,
  ChangesQuerySchema,
  ChannelQuerySchema,
  ChatSnapshotSchema,
  ConversationPageSchema,
  ConversationParamSchema,
  ConversationQuerySchema,
  ConversationSchema,
  CreateConversationSchema,
  CreateOutcomeSchema,
  CreateThreadSchema,
  DiscoveryEntriesSchema,
  DiscoveryOptionsSchema,
  DiscoveryPreviewSchema,
  DiscoveryStateSchema,
  DiscoveryUpdateSchema,
  ForResourceSchema,
  LeaveResultSchema,
  LeaveSchema,
  MAX_ATTACHMENT_BYTES,
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
  PersonalConversationSchema,
  ReactionParamSchema,
  ReactionsSchema,
  ReadAllOutcomeSchema,
  ReadAllSchema,
  ReadSchema,
  ReadUpdateSchema,
  SendMessageSchema,
  SharedPageSchema,
  SharedQuerySchema,
  SidebarPreferencesSchema,
  SnapshotQuerySchema,
  SuccessSchema,
  SummaryQuerySchema,
  SystemChatPageSchema,
  SystemChatParamSchema,
  SystemChatQuerySchema,
  ThreadListSchema,
  ThreadParamSchema,
  ThreadQuerySchema,
  ThreadSchema,
  UpdateConversationSchema,
  UpdateMemberSchema,
  UpdateThreadSchema,
  UploadAttachmentSchema,
} from "../service/contracts";
import { chatLive } from "../service/live";
import { chatLiveChannels } from "../service/live-channels";

const invalidInput = (c: Context) => ({ code: "BAD_INPUT", message: chatMessages.resolve([getLocale(c)]).t.invalidInput });
const attachmentTooLarge = (c: Context) =>
  c.json(
    {
      code: "ATTACHMENT_TOO_LARGE",
      message: chatMessages.resolve([getLocale(c)]).t.attachmentTooLarge,
    },
    413,
  );
const audienceUnavailableResponse = jsonResponse(
  z.object({ code: z.literal("AUDIENCE_UNAVAILABLE"), message: z.string() }),
  "Audience counting timed out; retry the request",
);
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
  .get(
    "/preferences",
    auth.requireRole("authenticated"),
    description("Read your sidebar preferences", SidebarPreferencesSchema),
    async (c) => respond(c, chatService.personal.preferences(context(c))),
  )
  .put(
    "/preferences",
    auth.requireRole("authenticated"),
    description("Save your sidebar preferences", SidebarPreferencesSchema),
    validator("json", SidebarPreferencesSchema, invalidInput),
    async (c) => respond(c, chatService.personal.savePreferences({ ...context(c), input: c.req.valid("json") })),
  )
  .put(
    "/conversations/:conversation/personal",
    auth.requireRole("authenticated"),
    description("Archive or order your pinned chat", ConversationSchema),
    validator("param", ConversationParamSchema, invalidInput),
    validator("json", PersonalConversationSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.personal.update({ ...context(c), conversationId: c.req.valid("param").conversation, input: c.req.valid("json") }),
      ),
  )
  .get(
    "/system-chats",
    auth.requireRole("authenticated"),
    describeRoute({
      tags: ["Chat"],
      summary: "List visible Spaces and Notebooks with their system chats",
      ...requiresAuth,
      description:
        "Reads at most 100 containers from each owning application with the caller's credential. Pass spacesCursor and notebooksCursor independently. Includes containers without a conversation as conversation: null. Unavailable or unauthorized resources are omitted. Summaries share a 100-thread candidate budget across the entire response. Follow each non-null summaryCursor at GET /conversations/:conversation?summaryCursor=...; counts describe that page, with General included only on the initial page.",
      responses: { 200: jsonResponse(SystemChatPageSchema, "Visible containers and independent source cursors") },
    }),
    validator("query", SystemChatQuerySchema, invalidInput),
    async (c) => respond(c, chatService.systemChats.list({ ...context(c), query: c.req.valid("query") })),
  )
  .post(
    "/system-chats/:resourceType/:resourceId/open",
    auth.requireRole("authenticated"),
    describeRoute({
      tags: ["Chat"],
      summary: "Open or create a system chat idempotently",
      ...requiresAuth,
      description:
        "Container reader permission read/write/manage (or admin) maps to Chat read/write/admin, capped by the caller's existing credential scopes. The first open creates a participant at the current message head. Chat does not create or edit container access grants. Access decisions expire in Valkey after 60 seconds.",
      responses: {
        200: jsonResponse(ConversationSchema, "Opened system conversation"),
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Container unavailable or not readable"),
      },
    }),
    validator("param", SystemChatParamSchema, invalidInput),
    async (c) => respond(c, chatService.systemChats.open({ ...context(c), ...c.req.valid("param") })),
  )
  .get(
    "/channels/options",
    auth.requireRole("authenticated"),
    description("Read channel audience options", DiscoveryOptionsSchema),
    async (c) => respond(c, chatService.channels.options()),
  )
  .get(
    "/channels",
    auth.requireRole("authenticated"),
    description("Browse discoverable channels", ConversationPageSchema),
    validator("query", ChannelQuerySchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.channels.browse({
          ...context(c),
          query: { ...c.req.valid("query"), cursor: c.req.valid("query").cursor ? JSON.stringify(c.req.valid("query").cursor) : undefined },
        }),
      ),
  )
  .post(
    "/channels/preview",
    auth.requireRole("authenticated"),
    describeRoute({
      tags: ["Chat"],
      summary: "Count the discovery audience",
      ...requiresAuth,
      responses: { 200: jsonResponse(DiscoveryPreviewSchema, "Audience count"), 503: audienceUnavailableResponse },
    }),
    validator("query", ConversationParamSchema.partial(), invalidInput),
    validator("json", DiscoveryEntriesSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.channels.preview({ ...context(c), conversationId: c.req.valid("query").conversation, input: c.req.valid("json") }),
      ),
  )
  .get(
    "/conversations/:conversation/discovery",
    auth.requireRole("authenticated"),
    describeRoute({
      tags: ["Chat"],
      summary: "Read channel discovery settings",
      ...requiresAuth,
      responses: { 200: jsonResponse(DiscoveryStateSchema, "Discovery settings"), 503: audienceUnavailableResponse },
    }),
    validator("param", ConversationParamSchema, invalidInput),
    async (c) => respond(c, chatService.channels.get({ ...context(c), conversationId: c.req.valid("param").conversation })),
  )
  .put(
    "/conversations/:conversation/discovery",
    auth.requireRole("authenticated"),
    description("Change channel discovery settings", ConversationSchema),
    validator("param", ConversationParamSchema, invalidInput),
    validator("json", DiscoveryUpdateSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.channels.update({ ...context(c), conversationId: c.req.valid("param").conversation, input: c.req.valid("json") }),
      ),
  )
  .post(
    "/conversations/:conversation/join",
    auth.requireRole("authenticated"),
    description("Join a discoverable channel", ConversationSchema),
    validator("param", ConversationParamSchema, invalidInput),
    async (c) => respond(c, chatService.channels.join({ ...context(c), conversationId: c.req.valid("param").conversation })),
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
      const { cursor, archived, unread, ids } = c.req.valid("query");
      return respond(
        c,
        chatService.conversations.list({
          ...context(c),
          query: { archived, unread, ...(ids ? { ids: ids.join(",") } : {}), ...(cursor ? { cursor: JSON.stringify(cursor) } : {}) },
        }),
      );
    },
  )
  .post(
    "/conversations/read-all",
    description("Mark your unread chats read", ReadAllOutcomeSchema),
    validator("json", ReadAllSchema, invalidInput),
    async (c) => {
      const { confirmed, cursor } = c.req.valid("json");
      return respond(
        c,
        chatService.readState.readAll({ ...context(c), input: { confirmed, ...(cursor ? { cursor: JSON.stringify(cursor) } : {}) } }),
      );
    },
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
    description("Read a chat and one bounded summary page", ConversationSchema),
    validator("param", ConversationParamSchema, invalidInput),
    validator("query", SummaryQuerySchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.conversations.get({ ...context(c), ...c.req.valid("query"), conversationId: c.req.valid("param").conversation }),
      ),
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
    describeRoute({
      tags: ["Chat"],
      summary: "List chat threads, including archived threads",
      ...requiresAuth,
      description:
        "System chats inspect at most 100 candidate threads per page, ordered by latest activity with thread-ID ties. Reader visibility, open/done/unread and q filters apply within that page. Follow nextCursor even when items is empty. Names and descriptions come from the item reader. resource.status is the Space column ID, or null for a note; done follows completedAt. Regular chats retain their activity/archive ordering.",
      responses: {
        200: jsonResponse(ThreadListSchema, "Authorized thread page"),
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Conversation not readable"),
      },
    }),
    validator("param", ConversationParamSchema, invalidInput),
    validator("query", ThreadQuerySchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.threads.list({ ...context(c), conversationId: c.req.valid("param").conversation, query: c.req.valid("query") }),
      ),
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
  .post(
    "/conversations/:conversation/threads/for-resource",
    describeRoute({
      tags: ["Chat"],
      summary: "Open an item thread idempotently using its reader",
      ...requiresAuth,
      description:
        "Requires container write access and a successful item reader. The item's reader-provided parent must match this system chat. Repeated calls return the same thread without a thread_created message. Manual create, rename, archive and member edits are refused for system chats.",
      responses: {
        200: jsonResponse(ThreadSchema, "Created or existing item thread"),
        403: jsonResponse(z.object({ code: z.literal("FORBIDDEN"), message: z.string() }), "Container write permission required"),
        404: jsonResponse(
          z.object({ code: z.literal("NOT_FOUND"), message: z.string() }),
          "Container or item not readable, or item belongs elsewhere",
        ),
      },
    }),
    validator("param", ConversationParamSchema, invalidInput),
    validator("json", ForResourceSchema, invalidInput),
    async (c) => {
      const result = await chatService.threads.forResource({
        ...context(c),
        conversationId: c.req.valid("param").conversation,
        input: c.req.valid("json"),
      });
      return result.ok ? respond(c, ok(result.data.thread)) : respond(c, result);
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
    "/conversations/:conversation/attachments",
    describeRoute({
      tags: ["Chat"],
      summary: "Upload one image or document for a message",
      ...requiresAuth,
      description:
        "Multipart file and optional thread. Requires the same write access as sending. Maximum 10 MiB per file, 20 unsent uploads per subject per conversation, and 20 uploads per subject per minute. Unsent uploads expire after 24 hours.",
      responses: {
        201: jsonResponse(AttachmentViewSchema, "Uploaded attachment"),
        400: jsonResponse(z.object({ code: z.string(), message: z.string() }), "Invalid file or thread"),
        403: jsonResponse(z.object({ code: z.string(), message: z.string() }), "Write permission required"),
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Conversation or thread unavailable"),
        409: jsonResponse(
          z.object({ code: z.enum(["ATTACHMENT_LIMIT", "THREAD_ARCHIVED"]), message: z.string() }),
          "Unsent budget reached or thread archived",
        ),
        413: jsonResponse(z.object({ code: z.literal("ATTACHMENT_TOO_LARGE"), message: z.string() }), "File too large"),
        422: jsonResponse(z.object({ code: z.literal("MALFORMED_IMAGE"), message: z.string() }), "Image container unreadable"),
        429: {
          ...jsonResponse(z.object({ code: z.string().optional(), message: z.string() }), "Upload rate limit reached"),
          headers: { "Retry-After": { description: "Seconds until retry", schema: { type: "integer", minimum: 1 } } },
        },
      },
    }),
    validator("param", ConversationParamSchema, invalidInput),
    bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES + 64 * 1024, onError: attachmentTooLarge }),
    async (c, next) => {
      const length = Number(c.req.header("content-length") ?? 0);
      if (Number.isFinite(length) && length > MAX_ATTACHMENT_BYTES + 64 * 1024) return attachmentTooLarge(c);
      await next();
    },
    validator("form", UploadAttachmentSchema, invalidInput),
    async (c) => {
      const { file, thread } = c.req.valid("form");
      if (file.size > MAX_ATTACHMENT_BYTES) return attachmentTooLarge(c);
      const result = await chatService.attachments.upload({
        ...context(c),
        conversationId: c.req.valid("param").conversation,
        thread,
        filename: file.name,
        mimeType: file.type,
        content: new Uint8Array(await file.arrayBuffer()),
      });
      if (!result.ok && "retryAfter" in result) c.header("Retry-After", String(result.retryAfter));
      return respond(c, result, result.ok ? 201 : undefined);
    },
  )
  .get(
    "/conversations/:conversation/attachments/:attachment",
    describeRoute({
      tags: ["Chat"],
      summary: "Download a message attachment",
      ...requiresAuth,
      description:
        "Requires current message visibility, including resource-thread access. An unsent upload is visible only to its uploader. Raster images render inline; other files download. Responses use private no-store caching, nosniff and a sandbox CSP.",
      responses: {
        200: {
          description: "Attachment bytes",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          headers: {
            "Content-Type": { description: "Raster image MIME type, otherwise application/octet-stream", schema: { type: "string" } },
            "Content-Disposition": { description: "Inline raster image or attachment with encoded filename", schema: { type: "string" } },
            "Cache-Control": { schema: { type: "string", enum: ["private, no-store"] } },
            "X-Content-Type-Options": { schema: { type: "string", enum: ["nosniff"] } },
            "Content-Security-Policy": { schema: { type: "string" } },
          },
        },
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Attachment unavailable"),
      },
    }),
    validator("param", AttachmentParamSchema, invalidInput),
    async (c) => {
      const param = c.req.valid("param");
      const result = await chatService.attachments.download({
        ...context(c),
        conversationId: param.conversation,
        attachmentId: param.attachment,
      });
      if (!result.ok) return respond(c, result);
      return new Response(result.data.stream, {
        headers: {
          ...attachmentHeaders(result.data.attachment),
          "Content-Length": String(result.data.attachment.size),
        },
      });
    },
  )
  .delete(
    "/conversations/:conversation/attachments/:attachment",
    describeRoute({
      tags: ["Chat"],
      summary: "Discard an unsent upload",
      ...requiresAuth,
      description:
        "Deletes the caller's own upload that no message uses yet, so it stops counting toward the 20 unsent files per chat. Repeating it, a sent file and another person's upload answer the same success without changing anything.",
      responses: {
        200: jsonResponse(SuccessSchema, "Discarded or already gone"),
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Chat not found"),
      },
    }),
    validator("param", AttachmentParamSchema, invalidInput),
    async (c) => {
      const param = c.req.valid("param");
      return respond(
        c,
        await chatService.attachments.discard({ ...context(c), conversationId: param.conversation, attachmentId: param.attachment }),
      );
    },
  )
  .post(
    "/conversations/:conversation/messages",
    describeRoute({
      tags: ["Chat"],
      summary: "Post a Markdown message",
      description:
        "Accepts up to 10 Cloud resource refs, deduplicated in input order. Accepts up to 10 unique unsent attachment IDs uploaded by the same access subject in this conversation. An empty body requires at least one ref or attachment. Attachments bind atomically with the message. Refs are stored without resolving their resources. A clientId retry returns the stored content with the caller's current reactions.",
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
    "/conversations/:conversation/shared",
    describeRoute({
      tags: ["Chat"],
      summary: "List shared images, documents, links and Cloud elements",
      description:
        "Newest messages first, up to 30 items per page. Within a message, refs precede links, then attachments in upload order. Omit thread for the whole chat or use general. Pass nextCursor unchanged with the same filters. Images and documents include only attachments from visible messages. Resource refs confer no access; resolve them with the reader's session.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SharedPageSchema, "Shared items and opaque continuation cursor"),
        400: jsonResponse(z.object({ code: z.string(), message: z.string() }), "Invalid filter or cursor"),
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Chat or thread not found"),
      },
    }),
    validator("param", ConversationParamSchema, invalidInput),
    validator("query", SharedQuerySchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.shared.list({
          ...context(c),
          conversationId: c.req.valid("param").conversation,
          query: c.req.valid("query"),
        }),
      ),
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
    "/conversations/:conversation/messages/:message/reactions",
    describeRoute({
      tags: ["Chat"],
      summary: "Read message reactions",
      ...requiresAuth,
      description: "First-reaction order, with up to 10 newest display names per emoji. Requires message read access.",
      responses: {
        200: jsonResponse(ReactionsSchema, "Reactions for this viewer"),
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Message unavailable"),
      },
    }),
    validator("param", MessageParamSchema, invalidInput),
    async (c) =>
      respond(
        c,
        chatService.reactions.list({
          ...context(c),
          conversationId: c.req.valid("param").conversation,
          messageId: c.req.valid("param").message,
        }),
      ),
  )
  .put(
    "/conversations/:conversation/messages/:message/reactions/:emoji",
    describeRoute({
      tags: ["Chat"],
      summary: "Add a message reaction",
      ...requiresAuth,
      description: "Idempotent. Requires message read access and write/admin credential scope. One emoji grapheme, at most 32 UTF-8 bytes.",
      responses: {
        204: { description: "Reaction state saved" },
        400: jsonResponse(z.object({ code: z.string(), message: z.string() }), "Invalid emoji"),
        403: jsonResponse(z.object({ code: z.string(), message: z.string() }), "Credential lacks write scope"),
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Message unavailable"),
        409: jsonResponse(
          z.object({ code: z.enum(["REACTION_PERSON_LIMIT", "REACTION_MESSAGE_LIMIT"]), message: z.string() }),
          "Reaction budget reached",
        ),
        429: {
          ...jsonResponse(z.object({ code: z.string().optional(), message: z.string() }), "Chat write rate limit reached"),
          headers: { "Retry-After": { description: "Seconds until retry", schema: { type: "integer", minimum: 1 } } },
        },
      },
    }),
    validator("param", ReactionParamSchema, invalidInput),
    async (c) => {
      const param = c.req.valid("param");
      const result = await chatService.reactions.set({
        ...context(c),
        conversationId: param.conversation,
        messageId: param.message,
        emoji: param.emoji,
        on: true,
      });
      if (!result.ok) {
        if ("retryAfter" in result) c.header("Retry-After", String(result.retryAfter));
        return respond(c, result);
      }
      return c.body(null, 204);
    },
  )
  .delete(
    "/conversations/:conversation/messages/:message/reactions/:emoji",
    describeRoute({
      tags: ["Chat"],
      summary: "Remove a message reaction",
      ...requiresAuth,
      description: "Idempotent. Requires message read access and write/admin credential scope. One emoji grapheme, at most 32 UTF-8 bytes.",
      responses: {
        204: { description: "Reaction state saved" },
        400: jsonResponse(z.object({ code: z.string(), message: z.string() }), "Invalid emoji"),
        403: jsonResponse(z.object({ code: z.string(), message: z.string() }), "Credential lacks write scope"),
        404: jsonResponse(z.object({ code: z.literal("NOT_FOUND"), message: z.string() }), "Message unavailable"),
        409: jsonResponse(
          z.object({ code: z.enum(["REACTION_PERSON_LIMIT", "REACTION_MESSAGE_LIMIT"]), message: z.string() }),
          "Reaction budget reached",
        ),
        429: {
          ...jsonResponse(z.object({ code: z.string().optional(), message: z.string() }), "Chat write rate limit reached"),
          headers: { "Retry-After": { description: "Seconds until retry", schema: { type: "integer", minimum: 1 } } },
        },
      },
    }),
    validator("param", ReactionParamSchema, invalidInput),
    async (c) => {
      const param = c.req.valid("param");
      const result = await chatService.reactions.set({
        ...context(c),
        conversationId: param.conversation,
        messageId: param.message,
        emoji: param.emoji,
        on: false,
      });
      if (!result.ok) {
        if ("retryAfter" in result) c.header("Retry-After", String(result.retryAfter));
        return respond(c, result);
      }
      return c.body(null, 204);
    },
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
    description("Leave a chat, handing over management when needed", LeaveResultSchema),
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
