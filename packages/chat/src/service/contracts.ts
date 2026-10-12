import { z } from "zod";

export const MEMBER_PAGE_SIZE = 100;
export const CONVERSATION_PAGE_SIZE = 50;
export const MAX_GROUP_MEMBERS = 500;
export const PEOPLE_PAGE_SIZE = 20;
export const MAX_PARTICIPANTS = 5_000;
export const MAX_EXISTING_MATCHES = 10;
export const CREATE_LIMIT = 30;
export const CREATE_WINDOW_SECONDS = 3_600;
export const MESSAGE_PAGE_SIZE = 50;
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
export const ConversationCursorSchema = z.object({ at: z.iso.datetime({ offset: true }), id: ShortIdSchema });
// JSON is URL-encoded by the caller. Strict parsing prevents unbounded or malformed cursor state.
export const ConversationQuerySchema = z.object({
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
export const MemberQuerySchema = z.object({ cursor: z.uuid().optional() });
export const MessageIdSchema = z.string().regex(/^[0-9A-Za-z]{10}$/);
const AuthorSchema = z.object({ type: z.enum(["user", "service_account"]), id: z.uuid(), name: z.string() });
export const ConversationSchema = z.object({
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
  permission: PermissionSchema,
  addedAt: z.string(),
});
export const MemberPageSchema = z.object({ items: z.array(MemberSchema), nextCursor: z.string().nullable() });
export const ChangeSchema = z.object({ added: z.number().int() });
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
export const SendMessageSchema = z.strictObject({
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  // Postgres text cannot store U+0000, so reject it here instead of failing the write.
  body: z.string().refine((body) => /\S/u.test(body) && !body.includes("\u0000") && [...body].length <= 20_000),
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
  z.object({ type: z.literal("membership"), conversationId: ShortIdSchema }),
  z.object({ type: z.literal("message"), message: MessageSchema }),
  MessageSchema.pick({ conversationId: true, id: true, seq: true, rev: true, kind: true, author: true, createdAt: true }).extend({
    type: z.literal("summary"),
    preview: z.string().nullable(),
    mention: z.boolean(),
  }),
]);
