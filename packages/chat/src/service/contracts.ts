import { z } from "zod";

export const MEMBER_PAGE_SIZE = 100;
export const CONVERSATION_PAGE_SIZE = 50;
export const UNREAD_CAP = 100;
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
export const MemberPrincipalSchema = z.discriminatedUnion("type", [
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
      const key = principal.type + ":" + (principal.type === "user" ? principal.userId : principal.groupId);
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
export const SidebarSectionSchema = z.enum(["pinned", "channels", "chats"]);
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
export const PeoplePageSchema = z.object({
  items: z.array(z.object({ id: z.uuid(), displayName: z.string() })),
  nextCursor: z.string().nullable(),
});
export const MemberQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  cursor: PeopleQuerySchema.shape.cursor,
});
export const MessageIdSchema = z.string().regex(/^[0-9A-Za-z]{10}$/);
const AuthorSchema = z.object({ type: z.enum(["user", "service_account"]), id: z.uuid(), name: z.string() });
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
export const ReadUpdateSchema = ReadStateSchema.extend({
  conversationId: ShortIdSchema,
  unread: z.number().int().min(0).max(UNREAD_CAP),
  asOfRev: z.number().int().min(0),
});
export const ReadSchema = z.strictObject({ seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
export const MarkUnreadSchema = z.strictObject({ message: MessageIdSchema.optional() });
export const ReadAllSchema = z.strictObject({ confirmed: z.boolean().default(false) });
export const ReadAllOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("confirm") }),
  z.object({ outcome: z.literal("done"), marked: z.number().int(), more: z.boolean() }),
]);
export const ConversationSchema = z.object({
  archived: z.boolean(),
  pinnedRank: z.number().int().nonnegative().nullable(),
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
  lastMessage: z.object({ id: MessageIdSchema, author: AuthorSchema, preview: z.string(), createdAt: z.iso.datetime() }).nullable(),
});
export const ExistingMatchSchema = ConversationSchema.pick({ id: true, name: true, title: true, lastActivityAt: true }).extend({
  archived: z.boolean(),
});
export const CreateOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("created"), conversation: ConversationSchema }),
  z.object({ outcome: z.literal("existing"), matches: z.array(ExistingMatchSchema) }),
]);
export const ConversationPageSchema = z.object({ items: z.array(ConversationSchema), nextCursor: z.string().nullable() });
export const MemberSchema = z.object({
  accessId: z.uuid(),
  principal: MemberPrincipalSchema,
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
  /** The access subject's direct user membership, independent of search and pagination. */
  self: z.object({ accessId: z.uuid(), permission: PermissionSchema, active: z.boolean() }).nullable(),
});
export const MemberPreviewSchema = z.object({
  joining: z.number().int().nonnegative(),
  throughGroups: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
});
export const ChangeSchema = z.object({ added: z.number().int() });
export const MemberRemovalSchema = z.object({ success: z.literal(true), keptThroughGroup: z.boolean() });
export const SuccessSchema = z.object({ success: z.literal(true) });

const personSnapshot = z.object({ id: z.uuid(), name: z.string() });
export const SystemMessageSchema = z.discriminatedUnion("code", [
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
export const MessageSchema = z.object({
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
export const SendMessageSchema = z.strictObject({
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  body: MessageBodySchema,
});
const sequenceQuery = (minimum: number) =>
  z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(minimum).max(Number.MAX_SAFE_INTEGER));
export const MessageQuerySchema = z
  .object({ before: sequenceQuery(1).optional(), after: sequenceQuery(0).optional() })
  .refine((query) => query.before === undefined || query.after === undefined);
export const MessageParamSchema = ConversationParamSchema.extend({ message: MessageIdSchema });
export const ChangesQuerySchema = z.object({ afterRev: sequenceQuery(0) });
export const MessagePageSchema = z.object({ items: z.array(MessageViewSchema), seqHead: z.number().int(), rev: z.number().int() });
// A stale or mistyped deep link still opens the latest history.
export const SnapshotQuerySchema = z.object({ message: z.string().max(64).optional().catch(undefined) });
export const ChatSnapshotSchema = z.object({
  cursor: z.string(),
  conversation: ConversationSchema,
  page: MessagePageSchema,
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
  z.object({ type: z.literal("message"), message: MessageSchema }),
  MessageSchema.pick({ conversationId: true, id: true, seq: true, rev: true, kind: true, author: true, createdAt: true }).extend({
    type: z.literal("summary"),
    preview: z.string().nullable(),
    mention: z.boolean(),
  }),
]);
