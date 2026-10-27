import { CloudResourceRefSchema } from "@k2b/cloud/contracts";
import { z } from "zod";

export const MEMBER_PAGE_SIZE = 100;
export const CONVERSATION_PAGE_SIZE = 50;
export const UNREAD_CAP = 100;
export const MAX_THREADS = 100;
export const READ_ALL_CONFIRM_FROM = 10;
// One sidebar page bounds each transaction; the client repeats while more remain.
export const READ_ALL_BATCH = CONVERSATION_PAGE_SIZE;
export const MAX_GROUP_MEMBERS = 500;
export const PEOPLE_PAGE_SIZE = 20;
export const MAX_PARTICIPANTS = 5_000;
export const MAX_EXISTING_MATCHES = 10;
export const CREATE_LIMIT = 30;
export const CREATE_WINDOW_SECONDS = 3_600;
export const MESSAGE_PAGE_SIZE = 50;
export const MAX_MESSAGE_REFS = 10;
export const MAX_MESSAGE_LINKS = 20;
export const MAX_MESSAGE_LINK_LENGTH = 2048;
export const SHARED_PAGE_SIZE = 30;
export const MESSAGE_MAX_CODE_POINTS = 20_000;
export const CHANGES_PAGE_SIZE = 200;
export const SEND_CONVERSATION_LIMIT = 10;
export const SEND_CONVERSATION_WINDOW_SECONDS = 10;
export const SEND_LIMIT = 60;
export const SEND_WINDOW_SECONDS = 60;
export const ShortIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);
export const PermissionSchema = z.enum(["read", "write", "admin"]);
const clearedText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable()
    .optional();
const IconSchema = z
  .string()
  .trim()
  .max(80)
  .refine((value) => value === "" || /^ti ti-[a-z0-9-]+$/.test(value))
  .transform((value) => value || null)
  .nullable()
  .optional();
const metadata = { name: clearedText(80), icon: IconSchema, purpose: clearedText(300) };
export const ServiceAccountPrincipalSchema = z.strictObject({
  type: z.literal("service_account"),
  serviceAccountId: z.uuid().transform((id) => id.toLowerCase()),
});
export const DiscoveryPrincipalSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("group"), groupId: z.uuid().transform((id) => id.toLowerCase()) }),
  z.strictObject({ type: z.literal("authenticated") }),
]);
export const DiscoveryEntrySchema = z.strictObject({ principal: DiscoveryPrincipalSchema, permission: z.enum(["read", "write"]) });
export const DiscoveryEntriesSchema = z
  .array(DiscoveryEntrySchema)
  .max(MEMBER_PAGE_SIZE)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => (entry.principal.type === "group" ? entry.principal.groupId : "authenticated"))).size ===
      entries.length,
  );
export const DiscoveryUpdateSchema = z.strictObject({
  entries: DiscoveryEntriesSchema,
  name: clearedText(80),
  purpose: clearedText(300),
  /** The `revision` of the settings this change starts from; a newer stored audience answers 409 DISCOVERY_CHANGED. */
  revision: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export const DiscoveryStateSchema = z.object({
  entries: z.array(DiscoveryEntrySchema.extend({ accessId: z.uuid(), displayName: z.string() })),
  revision: z.string(),
  allowAuthenticated: z.boolean(),
  audienceCount: z.number().int().nonnegative(),
});
export const DiscoveryOptionsSchema = z.object({ allowAuthenticated: z.boolean() });
export const DiscoveryPreviewSchema = z.object({ audienceCount: z.number().int().nonnegative(), includesAuthenticated: z.boolean() });

export const MemberPrincipalSchema = z.discriminatedUnion("type", [
  ServiceAccountPrincipalSchema,
  z.strictObject({ type: z.literal("user"), userId: z.uuid().transform((id) => id.toLowerCase()) }),
  z.strictObject({ type: z.literal("group"), groupId: z.uuid().transform((id) => id.toLowerCase()) }),
]);
export type MemberPrincipal = z.infer<typeof MemberPrincipalSchema>;
const members = z
  .array(MemberPrincipalSchema)
  .max(MEMBER_PAGE_SIZE)
  .transform((principals) => {
    const seen = new Set<string>();
    return principals.filter((principal) => {
      const key =
        principal.type +
        ":" +
        (principal.type === "user" ? principal.userId : principal.type === "group" ? principal.groupId : principal.serviceAccountId);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
export const CreateConversationSchema = z.strictObject({
  // Optional for older callers; one UUID identifies one immutable create intent per access subject.
  createKey: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .optional(),
  ...metadata,
  discovery: DiscoveryEntriesSchema.optional(),
  members: members.default([]),
  allowDuplicate: z.boolean().default(false),
});
export const UpdateConversationSchema = z
  .strictObject(metadata)
  .refine((value) => Object.values(value).some((field) => field !== undefined));
export const AddMembersSchema = z.strictObject({ members: members.refine((ids) => ids.length > 0) });
export const UpdateMemberSchema = z.strictObject({ permission: PermissionSchema });
export const LeaveSchema = z.strictObject({
  successor: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .optional(),
});
export const ConversationParamSchema = z.object({ conversation: ShortIdSchema });
export const MemberParamSchema = ConversationParamSchema.extend({ accessId: z.uuid().transform((id) => id.toLowerCase()) });
export const ConversationCursorSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  id: ShortIdSchema,
  rank: z.number().int().min(0).default(2147483647),
});
export const SidebarSectionSchema = z.enum(["pinned", "chats", "channels"]);
export const SidebarPreferencesSchema = z.object({
  collapsed: z
    .array(SidebarSectionSchema)
    .max(SidebarSectionSchema.options.length)
    .transform((sections) => [...new Set(sections)]),
});
export const PersonalConversationSchema = z
  .strictObject({
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
    before: ShortIdSchema.nullable().optional(),
    after: ShortIdSchema.optional(),
  })
  .refine((value) => value.archived !== undefined || value.pinned !== undefined)
  .refine((value) => [value.before !== undefined, value.after !== undefined].filter(Boolean).length <= 1)
  .refine((value) => value.pinned === true || (value.before === undefined && value.after === undefined));

// JSON is URL-encoded by the caller. Strict parsing prevents unbounded or malformed cursor state.
export const ConversationQuerySchema = z.object({
  ids: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(ShortIdSchema).max(CONVERSATION_PAGE_SIZE))
    .optional(),
  unread: z.enum(["true", "false"]).optional(),
  archived: z.enum(["true", "false"]).optional(),
  cursor: z
    .string()
    .max(160)
    .transform((value, ctx) => {
      try {
        const result = ConversationCursorSchema.safeParse(JSON.parse(value));
        if (result.success) return result.data;
      } catch {}
      ctx.addIssue({ code: "custom", message: "Invalid cursor" });
      return z.NEVER;
    })
    .optional(),
});
export const PeopleCursorSchema = z.strictObject({ name: z.string(), id: z.uuid() });
export const PeopleQuerySchema = z.strictObject({
  search: z.string().trim().max(100).optional(),
  cursor: z
    .string()
    .max(2_000)
    .transform((value, ctx) => {
      try {
        const result = PeopleCursorSchema.safeParse(JSON.parse(value));
        if (result.success) return result.data;
      } catch {}
      ctx.addIssue({ code: "custom", message: "Invalid cursor" });
      return z.NEVER;
    })
    .optional(),
});
export const ChannelQuerySchema = z.object({ q: z.string().trim().max(100).optional(), cursor: PeopleQuerySchema.shape.cursor });
export const PeoplePageSchema = z.object({
  items: z.array(z.object({ id: z.uuid(), displayName: z.string() })),
  nextCursor: z.string().nullable(),
});
export const MemberQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  cursor: PeopleQuerySchema.shape.cursor,
});
export const MessageIdSchema = z.string().regex(/^[0-9A-Za-z]{10}$/);
export const AuthorSchema = z.strictObject({ type: z.enum(["user", "service_account"]), id: z.uuid(), name: z.string() });
export const ThreadIdSchema = ShortIdSchema;
export const ThreadSelectorSchema = z.union([ThreadIdSchema, z.literal("general")]);
export const ThreadParamSchema = ConversationParamSchema.extend({ thread: ThreadIdSchema });
const ThreadReadSchema = z.strictObject({
  lastReadSeq: z.number().int().min(0).nullable(),
  unreadFromSeq: z.number().int().min(1).nullable(),
});
const LastMessageSchema = z.strictObject({ id: MessageIdSchema, author: AuthorSchema, preview: z.string(), createdAt: z.iso.datetime() });
export const ThreadResourceSchema = z.strictObject({
  deadline: z.string().nullable().optional(),
  deadlineAllDay: z.boolean().optional(),
  assignees: z.array(z.string()).max(100).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  allDay: z.boolean().optional(),
  ref: CloudResourceRefSchema,
  kind: z.enum(["task", "event", "note"]),
  status: z.string().nullable(),
  done: z.boolean(),
  href: z.string(),
});
export const ThreadQuerySchema = z.strictObject({
  short: z.literal("true").optional(),
  selected: ThreadIdSchema.optional(),
  filter: z.enum(["open", "done", "unread"]).optional(),
  q: z.string().trim().max(100).optional(),
  cursor: ThreadIdSchema.optional(),
});
export const ForResourceSchema = z.strictObject({
  ref: CloudResourceRefSchema.extend({ type: z.enum(["spaces.item", "notebooks.note"]), id: ShortIdSchema }),
});
export const SystemChatParamSchema = z.object({
  resourceType: z.enum(["spaces.space", "notebooks.notebook"]),
  resourceId: ShortIdSchema,
});
export const SystemChatQuerySchema = z.strictObject({
  spacesCursor: z.string().max(256).optional(),
  notebooksCursor: z.string().max(256).optional(),
});
export const ThreadSchema = z.strictObject({
  resource: ThreadResourceSchema.nullable().optional(),
  id: ThreadIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  archived: z.boolean(),
  unread: z.number().int().min(0).max(UNREAD_CAP),
  read: ThreadReadSchema.nullable(),
  lastMessage: LastMessageSchema.nullable(),
  lastActivityAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export const ThreadListSchema = z.strictObject({
  nextCursor: ThreadIdSchema.nullable().optional(),
  general: z.strictObject({ unread: z.number().int().min(0).max(UNREAD_CAP), lastMessage: LastMessageSchema.nullable() }),
  items: z.array(ThreadSchema).max(MAX_THREADS),
});
const ThreadDescriptionSchema = clearedText(80).refine((value) => value == null || !/[\r\n\u2028\u2029]/u.test(value));
export const CreateThreadSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: ThreadDescriptionSchema,
  createKey: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .optional(),
});
export const UpdateThreadSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    description: ThreadDescriptionSchema,
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined));
export const ReadStateSchema = z.object({
  lastReadSeq: z.number().int().min(0).nullable(),
  unreadFromSeq: z.number().int().min(1).nullable(),
  joinedSeq: z.number().int().min(0),
});
export type ReadState = z.infer<typeof ReadStateSchema>;
/** Messages after this seq can be unread; null without a participant row, where nothing is unread yet. */
export const readStart = (read: ReadState | null): number | null =>
  read === null
    ? null
    : Math.min(Math.max(read.lastReadSeq ?? 0, read.joinedSeq), read.unreadFromSeq === null ? Infinity : read.unreadFromSeq - 1);
export const SummaryQuerySchema = z.strictObject({ summaryCursor: z.union([ThreadIdSchema, z.literal("")]).optional() });
export const ReadUpdateSchema = ReadStateSchema.extend({
  summaryCursor: z.string().nullable().optional(),
  conversationId: ShortIdSchema,
  unread: z.number().int().min(0).max(UNREAD_CAP),
  asOfRev: z.number().int().min(0),
  threads: z.array(ThreadReadSchema.extend({ id: ThreadIdSchema, unread: z.number().int().min(0).max(UNREAD_CAP) })),
});
export const ReadSchema = z.strictObject({
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  thread: z.union([ThreadSelectorSchema, z.literal("all")]).default("general"),
  summaryCursor: SummaryQuerySchema.shape.summaryCursor,
});
export const MarkUnreadSchema = z.strictObject({ message: MessageIdSchema.optional() });
const ReadAllCursorSchema = ConversationCursorSchema.omit({ rank: true }).extend({
  thread: z.union([ThreadIdSchema, z.literal("")]).optional(),
});
export const ReadAllSchema = z.strictObject({
  confirmed: z.boolean().default(false),
  cursor: z
    .string()
    .max(256)
    .transform((value, ctx) => {
      try {
        return ReadAllCursorSchema.parse(JSON.parse(value));
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid cursor" });
        return z.NEVER;
      }
    })
    .optional(),
});
export const ReadAllOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("confirm") }),
  z.object({ outcome: z.literal("done"), marked: z.number().int(), more: z.boolean(), nextCursor: z.string().nullable().optional() }),
]);
export const ConversationSchema = z.object({
  archived: z.boolean(),
  pinnedRank: z.number().int().nonnegative().nullable(),
  summaryCursor: z.string().nullable().optional(),
  kind: z.enum(["chat", "system"]).optional(),
  resource: CloudResourceRefSchema.nullable().optional(),
  threads: z.number().int().min(0),
  channel: z.boolean(),
  member: z.boolean(),

  unread: z.number().int().min(0).max(UNREAD_CAP),
  read: ReadStateSchema.nullable(),
  id: ShortIdSchema,
  name: z.string().nullable(),
  icon: z.string().nullable(),
  purpose: z.string().nullable(),
  title: z.string(),
  memberCount: z.number().int(),
  withGuests: z.boolean(),
  peerDeactivated: z.boolean(),
  rev: z.number().int().nonnegative(),
  permission: PermissionSchema,
  createdAt: z.string(),
  lastActivityAt: z.string(),
  lastMessage: LastMessageSchema.extend({ thread: z.strictObject({ id: ThreadIdSchema, name: z.string() }).nullable() }).nullable(),
});
export const ExistingMatchSchema = ConversationSchema.pick({ id: true, name: true, title: true, lastActivityAt: true }).extend({
  archived: z.boolean(),
});
export const CreateOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("created"), conversation: ConversationSchema }),
  z.object({ outcome: z.literal("existing"), matches: z.array(ExistingMatchSchema) }),
]);
export const SystemChatPageSchema = z.strictObject({
  items: z.array(z.strictObject({ ref: CloudResourceRefSchema, name: z.string(), conversation: ConversationSchema.nullable() })).max(200),
  spacesCursor: z.string().nullable(),
  notebooksCursor: z.string().nullable(),
});
export const ConversationPageSchema = z.object({ items: z.array(ConversationSchema), nextCursor: z.string().nullable() });
export const MemberSchema = z.object({
  accessId: z.uuid(),
  principal: MemberPrincipalSchema,
  serviceAccountKind: z.enum(["standalone", "agent", "resource_bound", "user_delegated"]).optional(),
  displayName: z.string(),
  avatarHash: z.string().nullable().optional(),
  guest: z.boolean(),
  deactivated: z.boolean(),
  groupSize: z.number().int().nonnegative().nullable(),
  permission: PermissionSchema,
  addedAt: z.string(),
});
export const MemberPageSchema = z.object({
  items: z.array(MemberSchema),
  nextCursor: z.string().nullable(),
  managers: z.number().int().nonnegative(),
  /** The access subject's direct membership, independent of search and pagination. */
  self: z.object({ accessId: z.uuid(), permission: PermissionSchema, active: z.boolean() }).nullable(),
});
export const MemberPreviewSchema = z.object({
  joining: z.number().int().nonnegative(),
  throughGroups: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
});
export const ChangeSchema = z.object({ added: z.number().int() });
export const MemberRemovalSchema = z.object({ success: z.literal(true), keptThroughGroup: z.boolean() });
/** `canRejoin`: a channel the person left still lets them find and subscribe to it again. */
export const LeaveResultSchema = MemberRemovalSchema.extend({ canRejoin: z.boolean() });
export const SuccessSchema = z.object({ success: z.literal(true) });

const personSnapshot = z.object({ id: z.uuid(), name: z.string(), type: z.literal("service_account").optional() });
export const SystemMessageSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("discovery_changed"), params: z.object({ count: z.number().int().nonnegative() }) }),
  z.strictObject({
    code: z.literal("thread_created"),
    params: z.strictObject({ thread: z.strictObject({ id: ThreadIdSchema, name: z.string() }) }),
  }),
  z.strictObject({ code: z.literal("thread_renamed"), params: z.strictObject({ from: z.string(), to: z.string() }) }),
  z.object({ code: z.literal("conversation_created"), params: z.strictObject({}) }),
  z.object({
    code: z.literal("details_changed"),
    params: z.strictObject({
      name: z.string().nullable().optional(),
      icon: z.string().nullable().optional(),
      purpose: z.string().nullable().optional(),
    }),
  }),
  z.object({ code: z.literal("members_added"), params: z.object({ members: z.array(personSnapshot).min(1).max(100) }) }),
  z.object({ code: z.literal("groups_added"), params: z.object({ groups: z.array(personSnapshot).min(1).max(MEMBER_PAGE_SIZE) }) }),
  z.object({ code: z.literal("group_removed"), params: z.object({ group: personSnapshot }) }),
  z.object({ code: z.literal("manager_assigned"), params: z.object({ member: personSnapshot }) }),
  z.object({ code: z.literal("member_removed"), params: z.object({ member: personSnapshot }) }),
  z.object({ code: z.literal("member_left"), params: z.object({ successor: personSnapshot.optional() }) }),
  z.object({ code: z.literal("permission_changed"), params: z.object({ member: personSnapshot, permission: PermissionSchema }) }),
]);
export type SystemMessage = z.infer<typeof SystemMessageSchema>;
// Product budgets: one picker row group per person; two wrapped reaction-bar lines per message.
export const REACTIONS_PER_PERSON = 20;
export const REACTIONS_PER_MESSAGE = 50;
export const REACTION_PEOPLE = 10;
const emojiSegments = new Intl.Segmenter("en", { granularity: "grapheme" });
const emojiPart = String.raw`(?:\p{Emoji_Modifier_Base}\uFE0F?\p{Emoji_Modifier}|\p{Extended_Pictographic}\uFE0F?)`;
const emojiPattern = new RegExp(
  String.raw`^(?:${emojiPart}(?:\u200D${emojiPart})*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F})$`,
  "u",
);
export const EmojiSchema = z
  .string()
  .refine(
    (emoji) =>
      emoji.length <= 32 &&
      new TextEncoder().encode(emoji).byteLength <= 32 &&
      [...emojiSegments.segment(emoji)].length === 1 &&
      emojiPattern.test(emoji),
  );
export const ReactionSchema = z.strictObject({ emoji: EmojiSchema, count: z.number().int().positive(), own: z.boolean() });
export const ReactionsSchema = z.strictObject({
  items: z.array(ReactionSchema.extend({ people: z.array(z.string()).max(REACTION_PEOPLE) })).max(REACTIONS_PER_MESSAGE),
});
export const MessageSchema = z.object({
  reactions: z.array(ReactionSchema).max(REACTIONS_PER_MESSAGE),
  refs: z.array(CloudResourceRefSchema).max(MAX_MESSAGE_REFS),
  thread: ThreadIdSchema.nullable(),
  replyTo: z
    .union([
      z.strictObject({ id: MessageIdSchema, author: AuthorSchema, preview: z.string() }),
      z.strictObject({ deleted: z.literal(true) }),
    ])
    .nullable(),
  id: MessageIdSchema,
  conversationId: ShortIdSchema,
  seq: z.number().int().nonnegative(),
  rev: z.number().int().nonnegative(),
  kind: z.enum(["text", "system"]),
  author: AuthorSchema,
  body: z.string().nullable(),
  system: SystemMessageSchema.nullable(),
  createdAt: z.iso.datetime(),
});
export const MessageViewSchema = MessageSchema.extend({ systemText: z.string().nullable() });
// Shared by the API and the composer, which must keep rejected text out of the send queue.
// Postgres text cannot store U+0000, so reject it here instead of failing the write.
export const MessageBodySchema = z
  .string()
  .refine((body) => /\S/u.test(body) && !body.includes("\u0000") && [...body].length <= MESSAGE_MAX_CODE_POINTS);
const MessageRefsSchema = z
  // PostgreSQL jsonb cannot represent NUL or unpaired UTF-16 surrogates in identifiers.
  .array(CloudResourceRefSchema.refine((ref) => !/[\u0000\uD800-\uDFFF]/u.test(ref.id)))
  .max(MAX_MESSAGE_REFS)
  .transform((refs) => {
    const seen = new Set<string>();
    return refs.filter((ref) => {
      const key = JSON.stringify([ref.type, ref.id]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
export const SendMessageSchema = z
  .strictObject({
    clientId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    body: z.union([MessageBodySchema, z.literal("")]),
    refs: MessageRefsSchema.optional(),
    thread: ThreadIdSchema.optional(),
    replyTo: MessageIdSchema.optional(),
  })
  .refine((message) => message.body !== "" || (message.refs?.length ?? 0) > 0);
export const SharedQuerySchema = z.strictObject({
  kind: z.enum(["all", "images", "documents", "links", "elements"]).default("all"),
  thread: ThreadSelectorSchema.optional(),
  cursor: z.string().max(160).optional(),
});
const sharedMetadata = {
  messageId: MessageIdSchema,
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  thread: ThreadIdSchema.nullable(),
  author: AuthorSchema,
  createdAt: z.iso.datetime(),
};
export const SharedItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("link"), url: z.url({ protocol: /^https?$/ }).max(MAX_MESSAGE_LINK_LENGTH), ...sharedMetadata }),
  z.strictObject({ kind: z.literal("element"), ref: CloudResourceRefSchema, ...sharedMetadata }),
]);
export type SharedItem = z.infer<typeof SharedItemSchema>;
export const SharedPageSchema = z.strictObject({
  items: z.array(SharedItemSchema).max(SHARED_PAGE_SIZE),
  nextCursor: z.string().nullable(),
});
const sequenceQuery = (minimum: number) =>
  z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(minimum).max(Number.MAX_SAFE_INTEGER));
export const MessageQuerySchema = z
  .strictObject({ before: sequenceQuery(1).optional(), after: sequenceQuery(0).optional(), thread: ThreadSelectorSchema.optional() })
  .refine((query) => query.before === undefined || query.after === undefined);
export const MessageParamSchema = ConversationParamSchema.extend({ message: MessageIdSchema });
export const ReactionParamSchema = MessageParamSchema.extend({ emoji: EmojiSchema });
export const ChangesQuerySchema = z.object({ afterRev: sequenceQuery(0) });
/**
 * `from` and `to` are the positions the page covers for its thread selection: every selected message in that range is
 * in `items`, also where other threads' messages lie between them. A client joins pages and live messages by them.
 */
export const MessagePageSchema = z.object({
  items: z.array(MessageViewSchema),
  seqHead: z.number().int(),
  rev: z.number().int(),
  from: z.number().int().min(1),
  to: z.number().int().min(0),
});
// A stale or mistyped deep link still opens the latest history.
export const SnapshotQuerySchema = z.strictObject({
  message: z.string().max(64).optional().catch(undefined),
  thread: ThreadSelectorSchema.optional(),
});
export const ChatSnapshotSchema = z.object({
  cursor: z.string(),
  conversation: ConversationSchema,
  page: MessagePageSchema,
  /** The chat's threads; without threads only General, with its count. */
  threads: ThreadListSchema,
  /** The requested message when it exists in this chat; the page is the window around it. */
  focus: MessageIdSchema.nullable(),
});
export const ChangesPageSchema = z.object({
  rev: z.number().int(),
  more: z.boolean(),
  conversation: ConversationSchema.nullable(),
  messages: z.array(MessageViewSchema),
});
export const ChatLiveEventSchema = z.discriminatedUnion("type", [
  ReadUpdateSchema.extend({ type: z.literal("read") }),
  z.object({ type: z.literal("membership"), conversationId: ShortIdSchema }),
  z.object({ type: z.literal("personal") }),
  SidebarPreferencesSchema.extend({ type: z.literal("preferences") }),
  z.strictObject({ type: z.literal("threads"), conversationId: ShortIdSchema }),
  z.strictObject({
    type: z.literal("reactions"),
    conversationId: ShortIdSchema,
    messageId: MessageIdSchema,
    rev: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("message"), message: MessageSchema.omit({ reactions: true }) }),
  MessageSchema.pick({
    thread: true,
    conversationId: true,
    id: true,
    seq: true,
    rev: true,
    kind: true,
    author: true,
    createdAt: true,
  }).extend({
    type: z.literal("summary"),
    preview: z.string().nullable(),
    mention: z.boolean(),
  }),
]);

export const ItemEventsQuerySchema = z.strictObject({
  thread: z.union([ShortIdSchema, z.literal("all")]).default("all"),
  before: z.string().datetime({ offset: true }).max(40).optional(),
  after: z.string().datetime({ offset: true }).max(40).optional(),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ItemEventSchema = z.object({
  id: z.string().max(100),
  at: z.string().datetime({ offset: true }),
  icon: z
    .string()
    .regex(/^ti ti-[a-z0-9-]+$/)
    .max(80),
  sentence: z.string().max(4000),
  count: z.number().int().min(1),
  thread: z.union([
    z.object({ id: ShortIdSchema, name: z.string() }),
    z.object({ ref: z.object({ type: z.enum(["spaces.item", "notebooks.note"]), id: ShortIdSchema }), name: z.string() }),
  ]),
});
export const ItemEventsPageSchema = z.object({
  items: z.array(ItemEventSchema).max(100),
  nextCursor: z.string().max(256).nullable(),
  unavailable: z.literal(true).optional(),
});
