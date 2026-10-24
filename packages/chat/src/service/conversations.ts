import {
  createAccess,
  deleteAccess,
  ensureManagerRemains,
  err,
  fail,
  ok,
  type PermissionLevel,
  type Result,
  ratelimit,
  updateAccess,
} from "@k2b/cloud/server";
import { audit, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { crypto } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { messagePreview } from "../system-messages";
import {
  actingPrincipal,
  auditActor,
  boundConversation,
  type ChatContext,
  type ConversationRow,
  capPermission,
  coMemberIds,
  groupUsers,
  memberUsers,
  messages,
  permissionFromRank,
  readableMemberCondition,
  repairMemberCount,
  requireConversation,
  subjectPrincipal,
} from "./access";
import { validateDiscovery, writeDiscovery } from "./discovery";
import { TransactionFailure, value } from "./transaction-failure";

export { value };

import {
  AddMembersSchema,
  CONVERSATION_PAGE_SIZE,
  ConversationQuerySchema,
  type ConversationSchema,
  CREATE_LIMIT,
  CREATE_WINDOW_SECONDS,
  CreateConversationSchema,
  type CreateOutcomeSchema,
  LeaveSchema,
  MAX_EXISTING_MATCHES,
  MAX_GROUP_MEMBERS,
  MAX_PARTICIPANTS,
  MEMBER_PAGE_SIZE,
  type MemberPrincipal,
  MemberQuerySchema,
  PEOPLE_PAGE_SIZE,
  PeopleQuerySchema,
  UpdateConversationSchema,
  UpdateMemberSchema,
} from "./contracts";
import { deletedPeople } from "./former-accounts";
import { chatLive } from "./live";
import { publishMembership } from "./live-updates";
import { appendMessage, personSnapshots } from "./message-store";
import { projectRead, type ReadProjection, readProjection, unreadQuery } from "./read-state";
import { readerBatch, readResource } from "./resource-access";
import { messageCondition, type ThreadBudget, visibleThreadIdPage } from "./thread-access";

import { threadStates } from "./thread-state";
import { deriveTitle, TITLE_NAME_LIMIT } from "./titles";

const creationLimit = ratelimit({ id: "chat.conversation.create", limit: CREATE_LIMIT, windowSecs: CREATE_WINDOW_SECONDS });
// Throw after any write failure so returning a failed Result cannot commit partial work.
export const transaction = async <T>(work: (db: typeof sql) => Promise<Result<T>>): Promise<Result<T>> => {
  try {
    const result = await sql.begin(work);
    if (result.ok) chatLive.wake();
    return result;
  } catch (error) {
    if (error instanceof TransactionFailure) return fail(error.error);
    throw error;
  }
};
const parse = <T>(schema: z.ZodType<T>, input: unknown, context: ChatContext): Result<T> => {
  const result = schema.safeParse(input);
  return result.success ? ok(result.data) : fail(err.badInput(messages(context).invalidInput));
};
const notMember = (context: ChatContext) => fail({ code: "NOT_FOUND", message: messages(context).memberNotFound, status: 404 });
const conflict = (message: string) => fail({ code: "CONFLICT", message, status: 409 });
export const record = (db: typeof sql, context: ChatContext, id: string, action: string, metadata: Record<string, unknown> = {}) =>
  audit.record(
    {
      action,
      outcome: "allowed",
      actor: auditActor(context.actor),
      target: { type: "chat_conversation", id },
      requestId: context.requestId,
      metadata,
    },
    db,
  );
export const lockConversation = async (db: typeof sql, id: string) => {
  await db`SELECT id FROM chat.conversations WHERE short_id = ${id} FOR UPDATE`;
};
const authorizeManagement = async (
  db: typeof sql,
  context: ChatContext,
  id: string,
  action: string,
  required: "read" | "admin" = "admin",
) => {
  const result = await requireConversation({ ...context, conversationId: id, required }, db);
  if (result.ok && result.data.kind === "system") return fail(err.forbidden(messages(context).forbidden));
  if (!result.ok && result.error.status === 403)
    await audit.recordResult({
      action,
      actor: auditActor(context.actor),
      target: { type: "chat_conversation", id },
      requestId: context.requestId,
      result,
      db,
    });
  return result;
};

/** Validate only requested IDs, without returning directory details to the caller. */
const validateMembers = async (
  principals: MemberPrincipal[],
  context: ChatContext,
  db: typeof sql,
  lock = true,
  conversationId?: string,
): Promise<Result<void>> => {
  if (!principals.length) return ok();
  const t = messages(context);
  const [caller] =
    context.accessSubject.type === "user"
      ? await db<{ profile: string }[]>`
    SELECT profile FROM auth.users WHERE id = ${context.accessSubject.userId}::uuid ${lock ? db`FOR SHARE` : db``}`
      : [];
  const groups = principals.filter((principal) => principal.type === "group");
  if ((context.accessSubject.type !== "user" || caller?.profile === "guest") && groups.length)
    return fail(err.badInput(t.fullAccountGroups));
  const ids = principals.filter((principal) => principal.type === "user").map((principal) => principal.userId);
  const rows = await db<{ id: string; active: boolean; co_member: boolean }[]>`
    SELECT id, (account_expires IS NULL OR account_expires > now()) AS active,
      ${caller?.profile === "guest" ? db`u.id IN (${coMemberIds(context.accessSubject, db)})` : db`true`} AS co_member
    FROM auth.users u WHERE id = ANY(${toPgUuidArray(ids)}::uuid[]) ${lock ? db`FOR SHARE` : db``}
  `;
  const missing = ids.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length) return fail(err.badInput(t.memberUnavailable));
  if (rows.some((row) => !row.active)) return fail(err.badInput(t.memberUnavailable));
  if (rows.some((row) => !row.co_member)) return fail(err.badInput(t.guestCoMembers));
  const services = principals.filter((p) => p.type === "service_account").map((p) => p.serviceAccountId);
  if (services.length) {
    if (caller?.profile === "guest") return fail(err.badInput(t.guestCoMembers));
    const rows = await db<
      { id: string }[]
    >`SELECT id FROM auth.service_accounts WHERE id = ANY(${toPgUuidArray(services)}::uuid[]) AND status = 'active' AND (kind IN ('standalone', 'agent') OR (kind = 'resource_bound' AND app_id = 'chat' AND resource_type = 'conversation' AND resource_id = ${conversationId ?? null})) ${lock ? db`FOR SHARE` : db``}`;
    if (rows.length !== services.length) return fail(err.badInput(t.memberUnavailable));
  }
  for (const group of groups) {
    const [found] = await db<{ id: string }[]>`SELECT id FROM auth.groups WHERE id = ${group.groupId}::uuid ${lock ? db`FOR SHARE` : db``}`;
    if (!found) return fail(err.badInput(t.groupUnavailable));
    const users = await db<{ id: string }[]>`${groupUsers(group.groupId, db)} LIMIT ${MAX_GROUP_MEMBERS + 1}`;
    if (users.length > MAX_GROUP_MEMBERS) return fail(err.badInput(t.groupTooLarge));
  }
  return ok();
};

const checkParticipantLimit = async (db: typeof sql, id: string, context: ChatContext) => {
  const count = await repairMemberCount(id, db);
  if (count > MAX_PARTICIPANTS) throw new TransactionFailure(err.badInput(messages(context).participantLimit));
};

export const addDirectSubject = async (
  db: typeof sql,
  row: ConversationRow,
  principal: ReturnType<typeof subjectPrincipal>,
  permission: PermissionLevel,
  context: ChatContext,
) => {
  const accessPrincipal =
    principal.type === "user"
      ? { type: "user" as const, userId: principal.id }
      : { type: "service_account" as const, serviceAccountId: principal.id };
  const access = value(await createAccess({ principal: accessPrincipal, permission }, db));
  const author = actingPrincipal(context.actor);
  await db`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
    VALUES (${row.id}::uuid, ${access.id}::uuid, 'member', ${author.type}, ${author.id}::uuid)`;
  await db`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq)
    SELECT ${principal.type}, ${principal.id}::uuid, id, 'direct', seq_head FROM chat.conversations WHERE id = ${row.id}::uuid
    ON CONFLICT (principal_type, principal_id, conversation_id) DO UPDATE SET origin = 'direct'`;
};
const addDirectMember = (db: typeof sql, row: ConversationRow, userId: string, permission: PermissionLevel, context: ChatContext) =>
  addDirectSubject(db, row, { type: "user", id: userId }, permission, context);

const addGroups = async (
  db: typeof sql,
  row: ConversationRow,
  groups: Extract<MemberPrincipal, { type: "group" }>[],
  context: ChatContext,
) => {
  const memberIds = new Set<string>();
  const author = actingPrincipal(context.actor);
  for (const group of groups) {
    const access = value(await createAccess({ principal: group, permission: "write" }, db));
    await db`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${row.id}::uuid, ${access.id}::uuid, 'member', ${author.type}, ${author.id}::uuid)`;
    const resolved = await db<
      { id: string }[]
    >`SELECT id FROM (${groupUsers(group.groupId, db)}) members ORDER BY id LIMIT ${MAX_GROUP_MEMBERS}`;
    for (const person of resolved) memberIds.add(person.id);
  }
  const ids = [...memberIds];
  await db`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq)
    SELECT 'user', u.id, c.id, 'ondemand', c.seq_head FROM auth.users u CROSS JOIN chat.conversations c
    WHERE c.id = ${row.id}::uuid AND u.id = ANY(${toPgUuidArray(ids)}::uuid[])
    ON CONFLICT DO NOTHING`;
  return ids;
};
const groupSnapshots = async (db: typeof sql, ids: string[]) => db<{ id: string; name: string }[]>`
  SELECT id, COALESCE(NULLIF(name, ''), cn) AS name FROM auth.groups WHERE id = ANY(${toPgUuidArray(ids)}::uuid[]) ORDER BY id`;
// Membership hints go out once, with the first message of the change.
const appendAdded = async (
  db: typeof sql,
  row: ConversationRow,
  context: ChatContext,
  ids: string[],
  groupIds: string[],
  affected: string[],
  serviceIds: string[] = [],
) => {
  if (ids.length || serviceIds.length)
    await appendMessage(
      db,
      row,
      context,
      {
        kind: "system",
        system: {
          code: "members_added",
          params: { members: [...(await personSnapshots(db, ids)), ...(await personSnapshots(db, serviceIds, "service_account"))] },
        },
      },
      affected,
    );
  if (groupIds.length)
    await appendMessage(
      db,
      row,
      context,
      { kind: "system", system: { code: "groups_added", params: { groups: await groupSnapshots(db, groupIds) } } },
      ids.length || serviceIds.length ? [] : affected,
    );
};

/** The same bounded member-name selection used by sidebar titles and search. */
const titleNamesQuery = (context: ChatContext, db: typeof sql) => {
  const self = subjectPrincipal(context.accessSubject);
  return db`
      SELECT display_name, given_name, former, "group",
        row_number() OVER (ORDER BY section, added_at, joined_seq, order_id) AS position FROM (
        SELECT COALESCE(NULLIF(u.display_name, ''), u.uid) AS display_name, COALESCE(u.given_name, '') AS given_name,
          false AS former, false AS "group", 0 AS section, ca.added_at AS added_at, 0::bigint AS joined_seq, ca.access_id AS order_id
        FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id JOIN auth.users u ON u.id = a.user_id
        WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.permission IN ('read', 'write', 'admin')
          AND NOT (${self.type} = 'user' AND a.user_id = ${self.id}::uuid)
        UNION ALL
        SELECT sa.name, '', false, false, 0, ca.added_at, 0::bigint, ca.access_id
        FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id JOIN auth.service_accounts sa ON sa.id = a.service_account_id
        WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.permission IN ('read', 'write', 'admin')
          AND NOT (${self.type} = 'service_account' AND sa.id = ${self.id}::uuid)
        UNION ALL
        SELECT '', '', true, false, 1, NULL::timestamptz, p.joined_seq, p.principal_id FROM chat.participants p
        WHERE p.conversation_id = c.id AND p.origin = 'direct'
          AND ((p.principal_type = 'user' AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.principal_id))
            OR (p.principal_type = 'service_account' AND NOT EXISTS (SELECT 1 FROM auth.service_accounts sa WHERE sa.id = p.principal_id)))
        UNION ALL
        SELECT COALESCE(NULLIF(g.name, ''), g.cn), '', false, true, 2, ca.added_at, 0::bigint, ca.access_id
        FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id JOIN auth.groups g ON g.id = a.group_id
        WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.group_id IS NOT NULL AND a.permission IN ('read', 'write', 'admin')
      ) entries ORDER BY section, added_at, joined_seq, order_id LIMIT ${TITLE_NAME_LIMIT + 1}`;
};

/** SQL counterpart of deriveTitle for filtering before the eight-result limit. */
export const conversationSearchTitle = (context: ChatContext, db: typeof sql) => {
  const t = messages(context);
  const whitespace =
    " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  return db`COALESCE(NULLIF(c.name, ''), (
    SELECT CASE WHEN count(*) = 0 THEN ${t.you}
      WHEN count(*) = 1 THEN max(CASE WHEN former THEN ${t.formerAccount} ELSE display_name END)
      ELSE string_agg(CASE WHEN former THEN ${t.formerAccount} WHEN "group" THEN display_name
        ELSE COALESCE(NULLIF(btrim(given_name, ${whitespace}), ''), NULLIF(split_part(regexp_replace(btrim(display_name, ${whitespace}), ${`[${whitespace}]+`}, ' ', 'g'), ' ', 1), ''), display_name) END,
        ', ' ORDER BY position) FILTER (WHERE position <= ${TITLE_NAME_LIMIT})
        || CASE WHEN count(*) > ${TITLE_NAME_LIMIT} THEN ${", " + t.moreNames} ELSE '' END END
    FROM (${titleNamesQuery(context, db)}) ranked
  ))`;
};

/** One bounded query for titles across the page, including the creation transaction's own grants. */
const titles = async (rows: ConversationRow[], context: ChatContext, db: typeof sql) => {
  const others = rows.length
    ? await db<{ conversation_id: string; display_name: string; given_name: string; former: boolean; group: boolean }[]>`
    SELECT c.id AS conversation_id, names.* FROM chat.conversations c
    CROSS JOIN LATERAL (
      ${titleNamesQuery(context, db)}
    ) names WHERE c.id = ANY(${toPgUuidArray(rows.map((row) => row.id))}::uuid[])
  `
    : [];
  return new Map(
    rows.map((row) => [
      row.id,
      deriveTitle(
        row.name,
        others
          .filter((other) => other.conversation_id === row.id)
          .map((other) => ({ displayName: other.display_name, givenName: other.given_name, former: other.former, group: other.group })),
        context.locale,
      ),
    ]),
  );
};
const lastMessages = async (rows: ConversationRow[], context: ChatContext, db: typeof sql, ids?: string[]) => {
  const visibility = messageCondition(db, ids);
  const found = rows.length
    ? await db<
        {
          conversation_id: string;
          short_id: string;
          author_type: "user" | "service_account";
          author_id: string;
          author_name: string;
          body: string;
          created_at: Date;
          thread_short_id: string | null;
          thread_name: string | null;
          resource_type: string | null;
          resource_id: string | null;
        }[]
      >`
      SELECT c.id AS conversation_id, m.*, t.short_id AS thread_short_id, t.name AS thread_name, t.resource_type, t.resource_id FROM chat.conversations c
      CROSS JOIN LATERAL (
        SELECT short_id, thread_id, author_type, author_id, author_name,
          left(regexp_replace(body_md, ${"[\\t\\n\\v\\f\\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"}, ' ', 'g'), 600) AS body, created_at
        FROM chat.messages WHERE conversation_id = c.id AND kind = 'text' AND ${visibility} ORDER BY seq DESC LIMIT 1
      ) m LEFT JOIN chat.threads t ON t.id = m.thread_id WHERE c.id = ANY(${toPgUuidArray(rows.map((row) => row.id))}::uuid[])
    `
    : [];
  await readerBatch(found, async (row) => {
    if (!row.resource_type || !row.resource_id) return;
    const resource = await readResource(context, { type: row.resource_type, id: row.resource_id });
    row.thread_name = resource?.name ?? row.thread_name;
  });
  const absent = await Promise.all(
    (["user", "service_account"] as const).map((type) =>
      deletedPeople(
        db,
        found.filter((row) => row.author_type === type).map((row) => row.author_id),
        type,
      ),
    ),
  );
  const deleted = new Set(absent.flatMap((ids) => [...ids]));
  return new Map(
    found.map((row) => [
      row.conversation_id,
      {
        id: row.short_id,
        author: {
          type: row.author_type,
          id: row.author_id,
          name: deleted.has(row.author_id) ? messages(context).formerAccount : row.author_name,
        },
        preview: messagePreview(row.body),
        thread: row.thread_short_id === null ? null : { id: row.thread_short_id, name: row.thread_name! },
        createdAt: row.created_at.toISOString(),
      },
    ]),
  );
};
const lifecycleFlags = async (rows: ConversationRow[], context: ChatContext, db: typeof sql) => {
  const self = subjectPrincipal(context.accessSubject);
  const found = rows.length
    ? await db<{ id: string; with_guests: boolean; peer_deactivated: boolean }[]>`
    SELECT c.id, EXISTS (SELECT 1 FROM (${memberUsers(db`c.id`, db)}) members JOIN auth.users u ON u.id = members.id WHERE u.profile = 'guest') AS with_guests,
      (${self.type} = 'user'
        AND (SELECT COUNT(*) FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
          WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.user_id IS NOT NULL) = 2
        AND NOT EXISTS (SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
          WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.group_id IS NOT NULL)
        AND EXISTS (SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
          WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.user_id = ${self.id}::uuid)
        AND EXISTS (SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id JOIN auth.users u ON u.id = a.user_id
          WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.user_id <> ${self.id}::uuid AND u.account_expires <= now())) AS peer_deactivated
    FROM chat.conversations c WHERE c.id = ANY(${toPgUuidArray(rows.map((row) => row.id))}::uuid[])`
    : [];
  return new Map(found.map((row) => [row.id, { withGuests: row.with_guests, peerDeactivated: row.peer_deactivated }]));
};
const project = (
  row: ConversationRow,
  permission: Exclude<PermissionLevel, "none">,
  title: string,
  lastMessage: z.infer<typeof ConversationSchema>["lastMessage"],
  flags: { withGuests: boolean; peerDeactivated: boolean },
  state: Pick<z.infer<typeof ConversationSchema>, "archived" | "pinnedRank" | "read" | "unread" | "threads" | "channel" | "member">,
): z.infer<typeof ConversationSchema> => ({
  id: row.short_id,
  ...(row.kind === "system" && row.resource_type && row.resource_id
    ? { kind: row.kind, resource: { type: row.resource_type, id: row.resource_id } }
    : {}),
  name: row.name,
  icon: row.icon,
  purpose: row.purpose,
  memberCount: row.member_count,
  ...flags,
  ...state,
  rev: Number(row.rev),
  permission,
  title,
  lastMessage,
  createdAt: row.created_at.toISOString(),
  lastActivityAt: row.last_activity_at.toISOString(),
});

export const projectConversations = async (
  db: typeof sql,
  rows: (ConversationRow & { permission_rank: number })[],
  context: ChatContext,
) => {
  const names = await titles(rows, context, db),
    latest = await lastMessages(rows, context, db),
    flags = await lifecycleFlags(rows, context, db);
  const states = new Map(
    (
      await db<ReadProjection[]>`${unreadQuery(
        db,
        context.accessSubject,
        rows.map((row) => row.id),
      )}`
    ).map((row) => [row.conversation_id, projectRead(row)]),
  );
  return rows.map((row) =>
    project(
      row,
      z.enum(["read", "write", "admin"]).parse(capPermission(permissionFromRank(row.permission_rank), context.actor)),
      names.get(row.id)!,
      latest.get(row.id) ?? null,
      flags.get(row.id)!,
      states.get(row.id)!,
    ),
  );
};

type CreateOutcome = z.infer<typeof CreateOutcomeSchema>;
// Cloud's ServiceError status union omits 429; respond() maps this result shape to its own status.
type RateLimited = { ok: false; error: string; code: "RATE_LIMITED"; status: 429 };
const create = async (input: ChatContext & { input: unknown }): Promise<Result<CreateOutcome> | RateLimited> => {
  const t = messages(input);
  if (input.accessSubject.type !== "user") return fail(err.badInput(t.personalAccountRequired));
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok || bound.data !== null) return fail(err.forbidden(t.forbidden));
  const parsed = parse(CreateConversationSchema, input.input, input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  const callerId = input.accessSubject.userId;
  const members = data.members.filter((principal) => principal.type !== "user" || principal.userId !== callerId);
  const services = members.filter((p) => p.type === "service_account").map((p) => p.serviceAccountId);
  const people = members.filter((principal) => principal.type === "user").map((principal) => principal.userId);
  const groups = members.filter((principal) => principal.type === "group");
  const allIds = [callerId, ...people];
  // Compare normalized meaning, including explicit duplicate creation, rather than transport field order.
  const payload = JSON.stringify({
    members: [...members].sort((a, b) => {
      const left = JSON.stringify(a);
      const right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
    name: data.name ?? null,
    icon: data.icon ?? null,
    purpose: data.purpose ?? null,
    allowDuplicate: data.allowDuplicate,
    ...(data.discovery?.length
      ? {
          discovery: [...data.discovery].sort((a, b) => {
            const left = JSON.stringify(a);
            const right = JSON.stringify(b);
            return left < right ? -1 : left > right ? 1 : 0;
          }),
        }
      : {}),
  });
  try {
    const result = await sql.begin(async (db): Promise<Result<CreateOutcome> | RateLimited> => {
      const [caller] = await db<
        { profile: string; active: boolean }[]
      >`SELECT profile, (account_expires IS NULL OR account_expires > now()) AS active
      FROM auth.users WHERE id = ${callerId}::uuid FOR SHARE`;
      if (!caller?.active) return fail(err.badInput(t.memberUnavailable));
      if (data.createKey) {
        // Serializes the absent-row case too; a waiting transaction reads the committed mapping.
        await db`SELECT pg_advisory_xact_lock(hashtextextended(${"chat.create_intent:" + callerId + ":" + data.createKey}, 0))`;
        const [intent] = await db<{ short_id: string; same_payload: boolean }[]>`
          SELECT c.short_id, i.payload = ${payload}::jsonb AS same_payload FROM chat.create_intents i
          JOIN chat.conversations c ON c.id = i.conversation_id
          WHERE i.user_id = ${callerId}::uuid AND i.create_key = ${data.createKey}::uuid`;
        if (intent) {
          // Reproject current state and grants, never a cached admin response or a new creation.
          const current = await getInSnapshot({ ...input, conversationId: intent.short_id }, db);
          if (!current.ok) return current;
          if (!intent.same_payload) return conflict(t.createIntentChanged);
          return ok({ outcome: "created", conversation: current.data });
        }
      }
      const valid = await validateMembers(members, input, db);
      if (!valid.ok) return valid;
      if (data.discovery?.length) {
        if (!data.name) return fail(err.badInput(t.channelNameRequired));
        if (!data.purpose) return fail(err.badInput(t.channelPurposeRequired));
        const discoveryValid = await validateDiscovery(db, data.discovery, input);
        if (!discoveryValid.ok) return discoveryValid;
      }
      // One lock per member set: a waiting create sees the committed chat, so only allowDuplicate adds another.
      // A hash collision only serializes two unrelated creations.
      await db`SELECT pg_advisory_xact_lock(hashtextextended(${"chat.conversation.create:" + [...allIds.map((id) => `user:${id}`), ...services.map((id) => `service_account:${id}`)].sort().join(",")}, 0))`;
      if (!data.allowDuplicate && !groups.length && !data.discovery?.length) {
        const matches = await db<(ConversationRow & { archived: boolean })[]>`
        SELECT c.*, EXISTS(SELECT 1 FROM chat.participants p WHERE p.conversation_id = c.id AND p.principal_type = 'user'
          AND p.principal_id = ${callerId}::uuid AND p.archived_at IS NOT NULL) AS archived
        FROM chat.conversations c
        WHERE c.id IN (SELECT ca.conversation_id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
            WHERE ca.role = 'member' AND a.user_id = ${callerId}::uuid AND a.permission IN ('read', 'write', 'admin'))
          AND NOT EXISTS(SELECT 1 FROM chat.conversation_access ca WHERE ca.conversation_id = c.id AND ca.role = 'discoverable')
          AND NOT EXISTS (SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
            WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.group_id IS NOT NULL)
          AND (SELECT COUNT(*) FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
            WHERE ca.conversation_id = c.id AND ca.role = 'member' AND (a.user_id IS NOT NULL OR a.service_account_id IS NOT NULL)) = ${allIds.length + services.length}
          AND (SELECT COUNT(DISTINCT (a.user_id, a.service_account_id)) FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
            WHERE ca.conversation_id = c.id AND ca.role = 'member' AND (a.user_id = ANY(${toPgUuidArray(allIds)}::uuid[]) OR a.service_account_id = ANY(${toPgUuidArray(services)}::uuid[]))) = ${allIds.length + services.length}
        ORDER BY c.last_activity_at DESC, c.short_id DESC LIMIT ${MAX_EXISTING_MATCHES}
      `;
        if (matches.length) {
          const names = await titles(matches, input, db);
          return ok({
            outcome: "existing",
            matches: matches.map((row) => ({
              id: row.short_id,
              name: row.name,
              title: names.get(row.id)!,
              lastActivityAt: row.last_activity_at.toISOString(),
              archived: row.archived,
            })),
          });
        }
      }
      const limited = await creationLimit.check(`${actingPrincipal(input.actor).type}:${actingPrincipal(input.actor).id}`);
      if (limited.limited) return { ok: false, code: "RATE_LIMITED", error: t.rateLimited, status: 429 };
      const author = actingPrincipal(input.actor);
      let row: ConversationRow | undefined;
      // ON CONFLICT keeps a readable-ID collision from aborting the surrounding transaction.
      for (let attempt = 0; attempt < 10 && !row; attempt++) {
        [row] = await db<
          ConversationRow[]
        >`INSERT INTO chat.conversations (short_id, name, icon, purpose, created_by_type, created_by_id, member_count)
        VALUES (${crypto.common.readableId(6)}, ${data.name ?? null}, ${data.icon ?? null}, ${data.purpose ?? null}, ${author.type}, ${author.id}::uuid, ${allIds.length})
        ON CONFLICT (short_id) DO NOTHING RETURNING *`;
      }
      if (!row) throw new TransactionFailure(err.internal(t.createFailed));
      for (const id of allIds) await addDirectMember(db, row, id, id === callerId ? "admin" : "write", input);
      for (const id of services) await addDirectSubject(db, row, { type: "service_account", id }, "write", input);
      const groupPeople = await addGroups(db, row, groups, input);
      await checkParticipantLimit(db, row.id, input);
      row.member_count = await repairMemberCount(row.id, db);
      value(await requireConversation({ ...input, conversationId: row.short_id, required: "admin" }, db));
      if (data.discovery?.length) await writeDiscovery(db, row, data.discovery, input);
      let latestMessage = await appendMessage(db, row, input, { kind: "system", system: { code: "conversation_created", params: {} } }, [
        ...new Set([...allIds, ...groupPeople, ...services.map((id) => `service_account:${id}`)]),
      ]);
      if (groups.length)
        latestMessage = await appendMessage(db, row, input, {
          kind: "system",
          system: {
            code: "groups_added",
            params: {
              groups: await groupSnapshots(
                db,
                groups.map((group) => group.groupId),
              ),
            },
          },
        });
      if (data.createKey)
        await db`INSERT INTO chat.create_intents (user_id, create_key, payload, conversation_id)
          VALUES (${callerId}::uuid, ${data.createKey}::uuid, ${payload}::jsonb, ${row.id}::uuid)`;
      await record(db, input, row.short_id, "chat.conversation.create", { memberCount: row.member_count });
      const names = await titles([row], input, db);
      const latest = await lastMessages([row], input, db);
      return ok({
        outcome: "created",
        conversation: project(
          { ...row, rev: latestMessage.rev },
          "admin",
          names.get(row.id)!,
          latest.get(row.id) ?? null,
          (await lifecycleFlags([row], input, db)).get(row.id)!,
          projectRead((await db<ReadProjection[]>`${unreadQuery(db, input.accessSubject, [row.id])}`)[0]!),
        ),
      });
    });
    if (result.ok) chatLive.wake();
    return result;
  } catch (error) {
    if (error instanceof TransactionFailure) return fail(error.error);
    throw error;
  }
};

const getInSnapshot = async (
  input: ChatContext & { conversationId: string; summaryCursor?: string; threadBudget?: ThreadBudget; selectedThread?: string | null },
  db: typeof sql,
) => {
  const result = await requireConversation({ ...input, required: "read" }, db);
  if (!result.ok) return result;
  const row = result.data;
  const page =
    row.kind === "system" && input.selectedThread !== undefined
      ? { ids: input.selectedThread ? [input.selectedThread] : [], nextCursor: "" }
      : await visibleThreadIdPage(db, input, row.id, input.summaryCursor, input.threadBudget);
  const visibleIds = page.ids;
  const read = await readProjection(
    db,
    input,
    row.id,
    visibleIds,
    input.selectedThread === null || (!input.summaryCursor && page.nextCursor !== ""),
  );
  const resource =
    row.kind === "system" && row.resource_type && row.resource_id
      ? await readResource(input, { type: row.resource_type, id: row.resource_id })
      : null;
  const names = await titles([row], input, db);
  const latest = await lastMessages([row], input, db, visibleIds);
  return ok({
    ...(row.kind === "system" ? { summaryCursor: page.nextCursor } : {}),
    ...project(
      resource
        ? {
            ...row,
            name: resource.name,
            purpose: resource.description,
            last_activity_at: latest.get(row.id) ? new Date(latest.get(row.id)!.createdAt) : row.created_at,
          }
        : row,
      row.permission,
      resource?.name ?? names.get(row.id)!,
      latest.get(row.id) ?? null,
      (await lifecycleFlags([row], input, db)).get(row.id)!,
      read,
    ),
  });
};
const get = (
  input: ChatContext & { conversationId: string; summaryCursor?: string; threadBudget?: ThreadBudget; selectedThread?: string | null },
  db?: typeof sql,
) => (db ? getInSnapshot(input, db) : sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", (tx) => getInSnapshot(input, tx)));
const list = (input: ChatContext & { query?: unknown }) =>
  sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const parsed = parse(ConversationQuerySchema, input.query ?? {}, input);
    if (!parsed.ok) return parsed;
    const bound = boundConversation(input.actor, input.locale);
    if (!bound.ok) return fail(err.forbidden(messages(input).forbidden));
    if (capPermission("read", input.actor) === "none") return ok({ items: [], nextCursor: null });
    const cursor = parsed.data.cursor;
    const ids = parsed.data.ids;
    const self = subjectPrincipal(input.accessSubject);
    const archived = parsed.data.archived === "true";
    const rows = await db<(ConversationRow & { permission_rank: number; cursor_at: string })[]>`
    SELECT c.*, MAX(CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END)::int AS permission_rank,
      to_char(c.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM chat.conversations c JOIN chat.conversation_access ca ON ca.conversation_id = c.id JOIN auth.access a ON a.id = ca.access_id
    LEFT JOIN chat.participants p ON p.conversation_id = c.id AND p.principal_type = ${self.type} AND p.principal_id = ${self.id}::uuid
    WHERE ${readableMemberCondition(input.accessSubject, bound.data, db)}
      AND c.kind = 'chat'
      AND ${ids ? db`c.short_id = ANY(${toPgTextArray(ids)}::text[])` : db`true`}
      AND (p.archived_at IS NOT NULL) = ${archived}
      AND ${parsed.data.unread === "true" ? db`EXISTS(SELECT 1 FROM (${threadStates(db, input.accessSubject, db`c.id`)}) states WHERE states.unread > 0 OR states.unread_from_seq IS NOT NULL)` : db`true`}
      AND ${
        cursor
          ? db`(COALESCE(p.pinned_rank, 2147483647) > ${cursor.rank} OR
        (COALESCE(p.pinned_rank, 2147483647) = ${cursor.rank} AND (c.last_activity_at, c.short_id) < (${cursor.at}::timestamptz, ${cursor.id})))`
          : db`true`
      }
    GROUP BY c.id, p.pinned_rank ORDER BY COALESCE(p.pinned_rank, 2147483647), c.last_activity_at DESC, c.short_id DESC LIMIT ${CONVERSATION_PAGE_SIZE + 1}
  `;
    const page = rows.slice(0, CONVERSATION_PAGE_SIZE);
    const items = await projectConversations(db, page, input);
    const last = page.at(-1);
    return ok({
      items,
      nextCursor:
        rows.length > CONVERSATION_PAGE_SIZE && last
          ? JSON.stringify({
              at: last.cursor_at,
              id: last.short_id,
              rank: items.find((row) => row.id === last.short_id)!.pinnedRank ?? 2147483647,
            })
          : null,
    });
  });
const update = async (input: ChatContext & { conversationId: string; input: unknown }) => {
  const parsed = parse(UpdateConversationSchema, input.input, input);
  if (!parsed.ok) return parsed;
  return transaction(async (db) => {
    await lockConversation(db, input.conversationId);
    const allowed = await requireConversation({ ...input, required: "write" }, db);
    if (!allowed.ok) return allowed;
    if (allowed.data.kind === "system") return fail(err.forbidden(messages(input).forbidden));
    const data = parsed.data;
    const before = allowed.data;
    if (data.name === null || data.purpose === null) {
      const [channel] = await db<
        { exists: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM chat.conversation_access WHERE conversation_id = ${before.id}::uuid AND role = 'discoverable') AS exists`;
      if (channel?.exists)
        return fail(err.badInput(data.name === null ? messages(input).channelNameRequired : messages(input).channelPurposeRequired));
    }
    const changed = {
      ...(data.name !== undefined && data.name !== before.name ? { name: data.name } : {}),
      ...(data.icon !== undefined && data.icon !== before.icon ? { icon: data.icon } : {}),
      ...(data.purpose !== undefined && data.purpose !== before.purpose ? { purpose: data.purpose } : {}),
    };
    let row = before;
    if (Object.keys(changed).length) {
      await db`UPDATE chat.conversations SET name = ${data.name === undefined ? before.name : data.name},
        icon = ${data.icon === undefined ? before.icon : data.icon}, purpose = ${data.purpose === undefined ? before.purpose : data.purpose}
        WHERE id = ${before.id}::uuid`;
      await appendMessage(db, before, input, { kind: "system", system: { code: "details_changed", params: changed } });
      row = value(await requireConversation({ ...input, required: "write" }, db));
    }
    await record(db, input, before.short_id, "chat.conversation.update", { fields: Object.keys(data) });
    const names = await titles([row], input, db);
    const latest = await lastMessages([row], input, db);
    return ok(
      project(
        row,
        before.permission,
        names.get(before.id)!,
        latest.get(row.id) ?? null,
        (await lifecycleFlags([row], input, db)).get(row.id)!,
        projectRead((await db<ReadProjection[]>`${unreadQuery(db, input.accessSubject, [row.id])}`)[0]!),
      ),
    );
  });
};

type MemberRow = {
  access_id: string;
  principal_type: "user" | "service_account";
  principal_id: string;
  permission: Exclude<PermissionLevel, "none">;
  added_at: Date;
  active: boolean;
  service_account_kind?: "standalone" | "agent" | "resource_bound" | "user_delegated";
};
const directEntries = (db: typeof sql, conversationId: string) => db<MemberRow[]>`
  SELECT ca.access_id, CASE WHEN a.user_id IS NOT NULL THEN 'user' ELSE 'service_account' END AS principal_type,
    COALESCE(a.user_id, a.service_account_id) AS principal_id, a.permission, ca.added_at, sa.kind AS service_account_kind,
    CASE WHEN a.user_id IS NOT NULL THEN u.account_expires IS NULL OR u.account_expires > now() ELSE sa.status = 'active' END AS active
  FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
  LEFT JOIN auth.users u ON u.id = a.user_id LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
  WHERE ca.conversation_id = ${conversationId}::uuid AND ca.role = 'member' AND (u.id IS NOT NULL OR sa.id IS NOT NULL) ORDER BY ca.access_id
`;
const candidate = (row: MemberRow) => ({
  id: row.access_id,
  principal:
    row.principal_type === "user"
      ? { type: "user" as const, userId: row.principal_id }
      : { type: "service_account" as const, serviceAccountId: row.principal_id },
  permission: row.permission,
  serviceAccountKind: row.service_account_kind,
});
const affectedKey = (row: MemberRow) => (row.principal_type === "user" ? row.principal_id : `service_account:${row.principal_id}`);
const guardManagers = (before: MemberRow[], after: MemberRow[], input: ChatContext) => {
  // Expired accounts cannot sign in, so they cannot count as remaining managers.
  const result = ensureManagerRemains({
    before: before.filter((row) => row.active).map(candidate),
    after: after.filter((row) => row.active).map(candidate),
    locale: input.locale,
  });
  return result.ok ? result : fail({ ...result.error, message: messages(input).lastManager });
};
const listMembers = async (input: ChatContext & { conversationId: string; query?: unknown }) => {
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const parsed = parse(MemberQuerySchema, input.query ?? {}, input);
    if (!parsed.ok) return parsed;
    if (allowed.data.kind === "system") return ok({ items: [], nextCursor: null, managers: 0, self: null });
    const { q, cursor } = parsed.data;
    const [caller] =
      input.accessSubject.type === "user"
        ? await db<{ profile: string }[]>`SELECT profile FROM auth.users WHERE id = ${input.accessSubject.userId}::uuid`
        : [];
    const pattern = q ? `%${q.replace(/[\\%_]/g, (character) => "\\" + character)}%` : null;
    const rows = await db<
      {
        access_id: string;
        user_id: string | null;
        group_id: string | null;
        service_account_id: string | null;
        service_account_kind: MemberRow["service_account_kind"];
        permission: Exclude<PermissionLevel, "none">;
        added_at: Date;
        name: string;
        cursor_name: string;
        avatar_hash: string | null;
        guest: boolean;
        deactivated: boolean;
        group_size: number | null;
      }[]
    >`
      WITH page AS (
        SELECT entries.*, lower(name) AS cursor_name FROM (
          SELECT ca.access_id, a.user_id, a.group_id, a.service_account_id, sa.kind AS service_account_kind, a.permission, ca.added_at,
            COALESCE(COALESCE(NULLIF(u.display_name, ''), u.uid), COALESCE(NULLIF(g.name, ''), g.cn), sa.name) AS name,
            u.uid, g.cn, u.avatar_hash, COALESCE(u.profile = 'guest', false) AS guest,
            COALESCE(u.account_expires <= now(), sa.status <> 'active', false) AS deactivated
          FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
          LEFT JOIN auth.users u ON u.id = a.user_id LEFT JOIN auth.groups g ON g.id = a.group_id LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
          WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.role = 'member'
            AND (a.user_id IS NOT NULL OR a.group_id IS NOT NULL OR a.service_account_id IS NOT NULL)
        ) entries
        WHERE ${pattern ? db`(name ILIKE ${pattern} OR uid ILIKE ${pattern} OR cn ILIKE ${pattern})` : db`true`}
          AND ${cursor ? db`(lower(name), access_id) > (${cursor.name}, ${cursor.id}::uuid)` : db`true`}
        ORDER BY lower(name), access_id LIMIT ${MEMBER_PAGE_SIZE + 1}
      )
      SELECT page.*, ${
        input.accessSubject.type !== "user" || caller?.profile === "guest"
          ? db`NULL::int`
          : db`CASE WHEN group_id IS NULL THEN NULL ELSE (
        SELECT COUNT(*)::int FROM (${groupUsers(db`page.group_id`, db)} LIMIT ${MAX_GROUP_MEMBERS + 1}) people
      ) END`
      } AS group_size FROM page ORDER BY cursor_name, access_id
    `;
    const [count] = await db<
      { managers: number }[]
    >`SELECT COUNT(*)::int AS managers FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
      LEFT JOIN auth.users u ON u.id = a.user_id LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
      WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.role = 'member' AND a.permission = 'admin'
      AND ((u.id IS NOT NULL AND (u.account_expires IS NULL OR u.account_expires > now())) OR (sa.status = 'active' AND sa.kind IN ('standalone', 'agent')))`;
    const page = rows.slice(0, MEMBER_PAGE_SIZE);
    const subject = subjectPrincipal(input.accessSubject);
    const [self] = await db<
      { accessId: string; permission: "read" | "write" | "admin"; active: boolean }[]
    >`SELECT ca.access_id AS "accessId", a.permission,
      CASE WHEN a.user_id IS NOT NULL THEN u.account_expires IS NULL OR u.account_expires > now() ELSE sa.status = 'active' END AS active
      FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id LEFT JOIN auth.users u ON u.id = a.user_id LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
      WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.role = 'member' AND ${subject.type === "user" ? db`a.user_id = ${subject.id}::uuid` : db`a.service_account_id = ${subject.id}::uuid`} LIMIT 1`;
    const last = page.at(-1);
    return ok({
      items: page.map((row) => ({
        accessId: row.access_id,
        principal: row.user_id
          ? { type: "user" as const, userId: row.user_id }
          : row.service_account_id
            ? { type: "service_account" as const, serviceAccountId: row.service_account_id }
            : { type: "group" as const, groupId: row.group_id! },
        ...(row.service_account_kind ? { serviceAccountKind: row.service_account_kind } : {}),
        displayName: row.name,
        ...(row.user_id ? { avatarHash: row.avatar_hash } : {}),
        guest: row.guest,
        deactivated: row.deactivated,
        groupSize: row.group_size,
        permission: row.permission,
        addedAt: row.added_at.toISOString(),
      })),
      nextCursor: rows.length > MEMBER_PAGE_SIZE && last ? JSON.stringify({ name: last.cursor_name, id: last.access_id }) : null,
      managers: count!.managers,
      self: self ?? null,
    });
  });
};
const newMembers = async (db: typeof sql, conversationId: string, members: MemberPrincipal[]) => {
  const requested = members.map((principal) =>
    principal.type === "user" ? principal.userId : principal.type === "group" ? principal.groupId : principal.serviceAccountId,
  );
  const existing = await db<{ user_id: string | null; group_id: string | null; service_account_id: string | null }[]>`
      SELECT a.user_id, a.group_id, a.service_account_id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
      WHERE ca.conversation_id = ${conversationId}::uuid AND ca.role = 'member'
        AND (a.user_id = ANY(${toPgUuidArray(requested)}::uuid[]) OR a.group_id = ANY(${toPgUuidArray(requested)}::uuid[]) OR a.service_account_id = ANY(${toPgUuidArray(requested)}::uuid[]))`;
  // Existing entries are a no-op, so a group that has grown since it was added does not block the request.
  return members.filter(
    (principal) =>
      !existing.some((entry) =>
        principal.type === "user"
          ? entry.user_id === principal.userId
          : principal.type === "group"
            ? entry.group_id === principal.groupId
            : entry.service_account_id === principal.serviceAccountId,
      ),
  );
};
const previewMembers = async (input: ChatContext & { conversationId: string; input: unknown }) => {
  const parsed = parse(AddMembersSchema, input.input, input);
  if (!parsed.ok) return parsed;
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const allowed = await requireConversation({ ...input, required: "admin" }, db);
    if (!allowed.ok) return allowed;
    if (allowed.data.kind === "system") return fail(err.forbidden(messages(input).forbidden));
    const principals = await newMembers(db, allowed.data.id, parsed.data.members);
    const valid = await validateMembers(principals, input, db, false, input.conversationId);
    if (!valid.ok) return valid;
    const direct = new Set(principals.filter((principal) => principal.type === "user").map((principal) => principal.userId));
    const joining = new Set(direct);
    for (const principal of principals) {
      if (principal.type !== "group") continue;
      const people = await db<{ id: string }[]>`${groupUsers(principal.groupId, db)} LIMIT ${MAX_GROUP_MEMBERS}`;
      for (const person of people) joining.add(person.id);
    }
    const existing = await db<{ id: string }[]>`
      SELECT id FROM (${memberUsers(allowed.data.id, db)}) members WHERE id = ANY(${toPgUuidArray([...joining])}::uuid[])
    `;
    for (const person of existing) joining.delete(person.id);
    const current = await db<{ id: string }[]>`${memberUsers(allowed.data.id, db)} LIMIT ${MAX_PARTICIPANTS + 1}`;
    const [serviceCount] = await db<
      { count: number }[]
    >`SELECT COUNT(DISTINCT a.service_account_id)::int AS count FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.role = 'member' AND a.service_account_id IS NOT NULL AND a.permission IN ('read', 'write', 'admin')`;
    const newServices = principals.filter((p) => p.type === "service_account").length;
    const memberCount = current.length + serviceCount!.count + joining.size + newServices;
    if (memberCount > MAX_PARTICIPANTS) return fail(err.badInput(messages(input).participantLimit));
    return ok({ joining: joining.size + newServices, throughGroups: [...joining].filter((id) => !direct.has(id)).length, memberCount });
  });
};
const addMembers = async (input: ChatContext & { conversationId: string; input: unknown }) => {
  const parsed = parse(AddMembersSchema, input.input, input);
  if (!parsed.ok) return parsed;
  return transaction(async (db) => {
    await lockConversation(db, input.conversationId);
    const allowed = await authorizeManagement(db, input, input.conversationId, "chat.member.add");
    if (!allowed.ok) return allowed;
    const principals = await newMembers(db, allowed.data.id, parsed.data.members);
    const valid = await validateMembers(principals, input, db, true, input.conversationId);
    if (!valid.ok) return valid;
    const ids = principals.filter((principal) => principal.type === "user").map((principal) => principal.userId);
    const groups = principals.filter((principal) => principal.type === "group");
    const services = principals.filter((p) => p.type === "service_account").map((p) => p.serviceAccountId);
    for (const id of services) await addDirectSubject(db, allowed.data, { type: "service_account", id }, "write", input);
    for (const id of ids) await addDirectMember(db, allowed.data, id, "write", input);
    const groupPeople = await addGroups(db, allowed.data, groups, input);
    await checkParticipantLimit(db, allowed.data.id, input);
    await repairMemberCount(allowed.data.id, db);
    await appendAdded(
      db,
      allowed.data,
      input,
      ids,
      groups.map((group) => group.groupId),
      [...new Set([...ids, ...groupPeople, ...services.map((id) => `service_account:${id}`)])],
      services,
    );
    await record(db, input, allowed.data.short_id, "chat.member.add", { count: principals.length });
    return ok({ added: principals.length });
  });
};
const updateMember = async (input: ChatContext & { conversationId: string; accessId: string; input: unknown }) => {
  const parsed = parse(UpdateMemberSchema, input.input, input);
  if (!parsed.ok) return parsed;
  if (!z.uuid().safeParse(input.accessId).success) return notMember(input);
  return transaction(async (db) => {
    await lockConversation(db, input.conversationId);
    const allowed = await authorizeManagement(db, input, input.conversationId, "chat.member.update");
    if (!allowed.ok) return allowed;
    const before = await directEntries(db, allowed.data.id);
    const member = before.find((row) => row.access_id === input.accessId.toLowerCase());
    if (!member) return notMember(input);
    const after = before.map((row) =>
      row.access_id === input.accessId.toLowerCase() ? { ...row, permission: parsed.data.permission } : row,
    );
    const guarded = guardManagers(before, after, input);
    if (!guarded.ok) return guarded;
    if (member.permission !== parsed.data.permission) {
      value(await updateAccess({ id: input.accessId, permission: parsed.data.permission }, db));
      const [snapshot] = await personSnapshots(db, [member.principal_id], member.principal_type);
      await appendMessage(
        db,
        allowed.data,
        input,
        {
          kind: "system",
          system: {
            code: "permission_changed",
            params: { member: snapshot!, permission: parsed.data.permission },
          },
        },
        [affectedKey(member)],
      );
    }
    await record(db, input, allowed.data.short_id, "chat.member.update", { permission: parsed.data.permission });
    return ok({ success: true as const });
  });
};
const deleteDirect = async (db: typeof sql, row: ConversationRow, member: MemberRow) => {
  value(await deleteAccess({ id: member.access_id }, db)); // FK cascade removes the junction.
  const [remaining] =
    member.principal_type === "user"
      ? await db<{ id: string }[]>`SELECT id FROM (${memberUsers(row.id, db)}) members WHERE id = ${member.principal_id}::uuid`
      : [];
  if (remaining)
    await db`UPDATE chat.participants SET origin = 'ondemand' WHERE conversation_id = ${row.id}::uuid AND principal_type = ${member.principal_type} AND principal_id = ${member.principal_id}::uuid`;
  else
    await db`DELETE FROM chat.participants WHERE conversation_id = ${row.id}::uuid AND principal_type = ${member.principal_type} AND principal_id = ${member.principal_id}::uuid`;
  await repairMemberCount(row.id, db);
  return Boolean(remaining);
};
const removeMember = async (input: ChatContext & { conversationId: string; accessId: string }) => {
  if (!z.uuid().safeParse(input.accessId).success) return notMember(input);
  return transaction(async (db) => {
    await lockConversation(db, input.conversationId);
    const allowed = await authorizeManagement(db, input, input.conversationId, "chat.member.remove");
    if (!allowed.ok) return allowed;
    const [group] = await db<
      { group_id: string }[]
    >`SELECT a.group_id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
      WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.role = 'member' AND ca.access_id = ${input.accessId}::uuid AND a.group_id IS NOT NULL`;
    if (group) {
      const resolved = await db<
        { id: string }[]
      >`SELECT id FROM (${groupUsers(group.group_id, db)}) members ORDER BY id LIMIT ${MAX_GROUP_MEMBERS}`;
      const [snapshot] = await groupSnapshots(db, [group.group_id]);
      value(await deleteAccess({ id: input.accessId }, db));
      await db`DELETE FROM chat.participants p WHERE conversation_id = ${allowed.data.id}::uuid AND principal_type = 'user' AND origin = 'ondemand'
        AND NOT EXISTS (SELECT 1 FROM (${memberUsers(allowed.data.id, db)}) members WHERE members.id = p.principal_id)`;
      await repairMemberCount(allowed.data.id, db);
      await appendMessage(
        db,
        allowed.data,
        input,
        { kind: "system", system: { code: "group_removed", params: { group: snapshot! } } },
        resolved.map((person) => person.id),
      );
      await record(db, input, allowed.data.short_id, "chat.member.remove", { count: 1 });
      return ok({ success: true as const, keptThroughGroup: false });
    }
    const before = await directEntries(db, allowed.data.id);
    const member = before.find((row) => row.access_id === input.accessId.toLowerCase());
    if (!member) return notMember(input);
    const guarded = guardManagers(
      before,
      before.filter((row) => row.access_id !== member.access_id),
      input,
    );
    if (!guarded.ok) return guarded;
    const [snapshot] = await personSnapshots(db, [member.principal_id], member.principal_type);
    const keptThroughGroup = await deleteDirect(db, allowed.data, member);
    await appendMessage(db, allowed.data, input, { kind: "system", system: { code: "member_removed", params: { member: snapshot! } } }, [
      affectedKey(member),
    ]);
    await record(db, input, allowed.data.short_id, "chat.member.remove", { count: 1 });
    return ok({ success: true as const, keptThroughGroup });
  });
};
const leave = async (input: ChatContext & { conversationId: string; input: unknown }) => {
  const parsed = parse(LeaveSchema, input.input, input);
  if (!parsed.ok) return parsed;
  return transaction(async (db) => {
    await lockConversation(db, input.conversationId);
    const allowed = await authorizeManagement(
      db,
      input,
      input.conversationId,
      "chat.member.leave",
      parsed.data.successor ? "admin" : "read",
    );
    if (!allowed.ok) return allowed;
    const before = await directEntries(db, allowed.data.id);
    const self = subjectPrincipal(input.accessSubject);
    const own = before.find((row) => row.principal_type === self.type && row.principal_id === self.id);
    const t = messages(input);
    if (!own) {
      const [member] =
        self.type === "user"
          ? await db<{ id: string }[]>`SELECT id FROM (${memberUsers(allowed.data.id, db)}) members WHERE id = ${self.id}::uuid`
          : [];
      return conflict(member ? t.groupMemberLeave : t.noDirectEntry);
    }
    const others = before.filter((row) => row.access_id !== own.access_id);
    if (!others.length) return conflict(t.cannotLeaveAlone);
    const successor = parsed.data.successor;
    if (successor && !others.some((row) => row.access_id === successor)) return fail(err.badInput(t.invalidSuccessor));
    if (successor && !others.find((row) => row.access_id === successor)?.active) return fail(err.badInput(t.memberUnavailable));
    const needsSuccessor = !guardManagers(before, others, input).ok;
    if (needsSuccessor && !successor) return conflict(t.successorRequired);
    const after = others.map((row) => (needsSuccessor && row.access_id === successor ? { ...row, permission: "admin" as const } : row));
    const guarded = guardManagers(before, after, input);
    if (!guarded.ok) return guarded;
    if (needsSuccessor && successor) value(await updateAccess({ id: successor, permission: "admin" }, db));
    const successorMember = needsSuccessor ? others.find((row) => row.access_id === successor) : undefined;
    const [snapshot] = successorMember ? await personSnapshots(db, [successorMember.principal_id], successorMember.principal_type) : [];
    const keptThroughGroup = await deleteDirect(db, allowed.data, own);
    const [channel] = await db<
      { exists: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM chat.conversation_access WHERE conversation_id = ${allowed.data.id}::uuid AND role = 'discoverable') AS exists`;
    if (channel?.exists) {
      if (snapshot)
        await appendMessage(db, allowed.data, input, {
          kind: "system",
          system: { code: "permission_changed", params: { member: snapshot, permission: "admin" } },
        });
      await publishMembership(db, allowed.data, [affectedKey(own), ...(successorMember ? [affectedKey(successorMember)] : [])]);
    } else {
      await appendMessage(
        db,
        allowed.data,
        input,
        {
          kind: "system",
          system: {
            code: "member_left",
            params: snapshot ? { successor: snapshot } : {},
          },
        },
        [affectedKey(own), ...(successorMember ? [affectedKey(successorMember)] : [])],
      );
    }
    await record(db, input, allowed.data.short_id, "chat.member.leave", { count: 1, ...(needsSuccessor ? { permission: "admin" } : {}) });
    // Subscribing again uses the channel's audience; a person added directly outside it cannot come back alone.
    const canRejoin = !!channel?.exists && (await requireConversation({ ...input, required: "read" }, db)).ok;
    return ok({ success: true as const, keptThroughGroup, canRejoin });
  });
};

const people = async (input: ChatContext & { query?: unknown }) => {
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok || bound.data !== null) return fail(err.forbidden(messages(input).forbidden));
  const parsed = parse(PeopleQuerySchema, input.query ?? {}, input);
  if (!parsed.ok) return parsed;
  if (input.accessSubject.type !== "user") return ok({ items: [], nextCursor: null });
  const { search, cursor } = parsed.data;
  const pattern = search ? `%${search.replace(/[\\%_]/g, (character) => "\\" + character)}%` : null;
  const rows = await sql<{ id: string; display_name: string; cursor_name: string }[]>`
    SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.uid) AS display_name, lower(COALESCE(NULLIF(u.display_name, ''), u.uid)) AS cursor_name
    FROM auth.users u WHERE u.id <> ${input.accessSubject.userId}::uuid AND (u.account_expires IS NULL OR u.account_expires > now())
      AND u.id IN (${coMemberIds(input.accessSubject)})
      AND ${pattern ? sql`(COALESCE(NULLIF(u.display_name, ''), u.uid) ILIKE ${pattern} OR u.uid ILIKE ${pattern})` : sql`true`}
      AND ${cursor ? sql`(lower(COALESCE(NULLIF(u.display_name, ''), u.uid)), u.id) > (${cursor.name}, ${cursor.id}::uuid)` : sql`true`}
    ORDER BY lower(COALESCE(NULLIF(u.display_name, ''), u.uid)), u.id LIMIT ${PEOPLE_PAGE_SIZE + 1}`;
  const page = rows.slice(0, PEOPLE_PAGE_SIZE);
  const last = page.at(-1);
  return ok({
    items: page.map((row) => ({ id: row.id, displayName: row.display_name })),
    nextCursor: rows.length > PEOPLE_PAGE_SIZE && last ? JSON.stringify({ name: last.cursor_name, id: last.id }) : null,
  });
};

export const conversations = {
  create,
  people,
  list,
  get,
  update,
  members: { list: listMembers, preview: previewMembers, add: addMembers, update: updateMember, remove: removeMember },
  leave,
};
