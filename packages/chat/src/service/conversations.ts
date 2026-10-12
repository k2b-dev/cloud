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
  resolveDisplayNames,
  type ServiceError,
  updateAccess,
} from "@k2b/cloud/server";
import { audit, toPgUuidArray } from "@k2b/cloud/services";
import { crypto } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import {
  actingPrincipal,
  auditActor,
  boundConversation,
  type ChatContext,
  type ConversationRow,
  capPermission,
  messages,
  permissionFromRank,
  principalCondition,
  requireConversation,
  subjectPrincipal,
} from "./access";
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
  MAX_PARTICIPANTS,
  MEMBER_PAGE_SIZE,
  MemberQuerySchema,
  UpdateConversationSchema,
  UpdateMemberSchema,
} from "./contracts";
import { chatLive } from "./live";
import { appendMessage, personSnapshots } from "./message-store";
import { deriveTitle, TITLE_NAME_LIMIT } from "./titles";

const creationLimit = ratelimit({ id: "chat.conversation.create", limit: CREATE_LIMIT, windowSecs: CREATE_WINDOW_SECONDS });
// Throw after any write failure so returning a failed Result cannot commit partial work.
class TransactionFailure extends Error {
  constructor(readonly error: ServiceError) {
    super(error.message);
  }
}
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new TransactionFailure(result.error);
  return result.data;
};
const transaction = async <T>(work: (db: typeof sql) => Promise<Result<T>>): Promise<Result<T>> => {
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
const record = (db: typeof sql, context: ChatContext, id: string, action: string, metadata: Record<string, unknown> = {}) =>
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
const lockConversation = async (db: typeof sql, id: string) => {
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
const validateMembers = async (ids: string[], context: ChatContext, db: typeof sql): Promise<Result<void>> => {
  if (ids.length === 0) return ok();
  const t = messages(context);
  const rows = await db<{ id: string; profile: string; active: boolean }[]>`
    SELECT id, profile, (account_expires IS NULL OR account_expires > now()) AS active
    FROM auth.users WHERE id = ANY(${toPgUuidArray(ids)}::uuid[]) FOR SHARE
  `;
  const missing = ids.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length) {
    const [kinds] = await db<{ service_account: boolean; directory_group: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM auth.service_accounts WHERE id = ANY(${toPgUuidArray(missing)}::uuid[])) AS service_account,
        EXISTS(SELECT 1 FROM auth.groups WHERE id = ANY(${toPgUuidArray(missing)}::uuid[])) AS directory_group
    `;
    if (kinds?.service_account) return fail(err.badInput(t.peopleOnly));
    if (kinds?.directory_group) return fail(err.badInput(t.groupsUnsupported));
    return fail(err.badInput(t.memberUnavailable));
  }
  if (rows.some((row) => !row.active)) return fail(err.badInput(t.memberUnavailable));
  if (rows.some((row) => row.profile !== "user")) return fail(err.badInput(t.guestsUnsupported));
  return ok();
};

const addDirectMember = async (db: typeof sql, row: ConversationRow, userId: string, permission: PermissionLevel, context: ChatContext) => {
  const access = value(await createAccess({ principal: { type: "user", userId }, permission }, db));
  const author = actingPrincipal(context.actor);
  await db`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
    VALUES (${row.id}::uuid, ${access.id}::uuid, 'member', ${author.type}, ${author.id}::uuid)`;
  await db`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq)
    SELECT 'user', ${userId}::uuid, id, 'direct', seq_head FROM chat.conversations WHERE id = ${row.id}::uuid`;
};

/** One bounded query for titles across the page, including the creation transaction's own grants. */
const titles = async (rows: ConversationRow[], context: ChatContext, db: typeof sql) => {
  const self = subjectPrincipal(context.accessSubject);
  const others = rows.length
    ? await db<{ conversation_id: string; display_name: string; given_name: string }[]>`
    SELECT c.id AS conversation_id, names.display_name, names.given_name
    FROM chat.conversations c
    CROSS JOIN LATERAL (
      SELECT COALESCE(NULLIF(u.display_name, ''), u.uid) AS display_name, COALESCE(u.given_name, '') AS given_name
      FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id JOIN auth.users u ON u.id = a.user_id
      WHERE ca.conversation_id = c.id AND ca.role = 'member'
        AND NOT (${self.type} = 'user' AND a.user_id = ${self.id}::uuid)
      ORDER BY ca.added_at, ca.access_id LIMIT ${TITLE_NAME_LIMIT + 1}
    ) names
    WHERE c.id = ANY(${toPgUuidArray(rows.map((row) => row.id))}::uuid[])
  `
    : [];
  return new Map(
    rows.map((row) => [
      row.id,
      deriveTitle(
        row.name,
        others
          .filter((other) => other.conversation_id === row.id)
          .map((other) => ({ displayName: other.display_name, givenName: other.given_name })),
        context.locale,
      ),
    ]),
  );
};
const project = (
  row: ConversationRow,
  permission: Exclude<PermissionLevel, "none">,
  title: string,
): z.infer<typeof ConversationSchema> => ({
  id: row.short_id,
  name: row.name,
  icon: row.icon,
  purpose: row.purpose,
  memberCount: row.member_count,
  permission,
  title,
  createdAt: row.created_at.toISOString(),
  lastActivityAt: row.last_activity_at.toISOString(),
});

type CreateOutcome = z.infer<typeof CreateOutcomeSchema>;
// Cloud's ServiceError status union omits 429; respond() maps this result shape to its own status.
type RateLimited = { ok: false; error: string; code: "RATE_LIMITED"; status: 429 };
const create = async (input: ChatContext & { input: unknown }): Promise<Result<CreateOutcome> | RateLimited> => {
  const t = messages(input);
  if (input.accessSubject.type !== "user") return fail(err.badInput(t.peopleOnly));
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok || bound.data !== null) return fail(err.forbidden(t.forbidden));
  const parsed = parse(CreateConversationSchema, input.input, input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  const callerId = input.accessSubject.userId;
  const members = data.members.filter((id) => id !== callerId);
  const allIds = [callerId, ...members];
  try {
    const result = await sql.begin(async (db): Promise<Result<CreateOutcome> | RateLimited> => {
      const [caller] = await db<
        { profile: string; active: boolean }[]
      >`SELECT profile, (account_expires IS NULL OR account_expires > now()) AS active
      FROM auth.users WHERE id = ${callerId}::uuid FOR SHARE`;
      if (!caller?.active) return fail(err.badInput(t.memberUnavailable));
      if (caller.profile === "guest" && members.length) return fail(err.badInput(t.guestCreate));
      const valid = await validateMembers(members, input, db);
      if (!valid.ok) return valid;
      // One lock per member set: a waiting create sees the committed chat, so only allowDuplicate adds another.
      // A hash collision only serializes two unrelated creations.
      await db`SELECT pg_advisory_xact_lock(hashtextextended(${"chat.conversation.create:" + [...new Set(allIds)].sort().join(",")}, 0))`;
      if (!data.allowDuplicate) {
        const matches = await db<(ConversationRow & { archived: boolean })[]>`
        SELECT c.*, EXISTS(SELECT 1 FROM chat.participants p WHERE p.conversation_id = c.id AND p.principal_type = 'user'
          AND p.principal_id = ${callerId}::uuid AND p.archived_at IS NOT NULL) AS archived
        FROM chat.conversations c
        WHERE c.id IN (SELECT ca.conversation_id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
            WHERE ca.role = 'member' AND a.user_id = ${callerId}::uuid AND a.permission IN ('read', 'write', 'admin'))
          AND NOT EXISTS(SELECT 1 FROM chat.conversation_access ca WHERE ca.conversation_id = c.id AND ca.role = 'discoverable')
          AND (SELECT COUNT(*) FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
            WHERE ca.conversation_id = c.id AND ca.role = 'member' AND (a.user_id IS NOT NULL OR a.service_account_id IS NOT NULL)) = ${allIds.length}
          AND (SELECT COUNT(DISTINCT a.user_id) FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
            WHERE ca.conversation_id = c.id AND ca.role = 'member' AND a.user_id = ANY(${toPgUuidArray(allIds)}::uuid[])) = ${allIds.length}
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
      value(await requireConversation({ ...input, conversationId: row.short_id, required: "admin" }, db));
      await appendMessage(db, row, input, { kind: "system", system: { code: "conversation_created", params: {} } });
      await record(db, input, row.short_id, "chat.conversation.create", { memberCount: allIds.length });
      const names = await titles([row], input, db);
      return ok({ outcome: "created", conversation: project(row, "admin", names.get(row.id)!) });
    });
    if (result.ok) chatLive.wake();
    return result;
  } catch (error) {
    if (error instanceof TransactionFailure) return fail(error.error);
    throw error;
  }
};

const get = async (input: ChatContext & { conversationId: string }, db: typeof sql = sql) => {
  const result = await requireConversation({ ...input, required: "read" }, db);
  if (!result.ok) return result;
  const row = result.data;
  const names = await titles([row], input, db);
  return ok(project(row, row.permission, names.get(row.id)!));
};
const list = async (input: ChatContext & { query?: unknown }) => {
  const parsed = parse(ConversationQuerySchema, input.query ?? {}, input);
  if (!parsed.ok) return parsed;
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok) return fail(err.forbidden(messages(input).forbidden));
  if (capPermission("read", input.actor) === "none") return ok({ items: [], nextCursor: null });
  const cursor = parsed.data.cursor;
  const rows = await sql<(ConversationRow & { permission_rank: number; cursor_at: string })[]>`
    SELECT c.*, MAX(CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END)::int AS permission_rank,
      to_char(c.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM chat.conversations c JOIN chat.conversation_access ca ON ca.conversation_id = c.id JOIN auth.access a ON a.id = ca.access_id
    WHERE ca.role = 'member' AND ${principalCondition(input.accessSubject)} AND a.permission IN ('read', 'write', 'admin')
      AND ${bound.data ? sql`c.short_id = ${bound.data}` : sql`true`}
      AND ${cursor ? sql`(c.last_activity_at, c.short_id) < (${cursor.at}::timestamptz, ${cursor.id})` : sql`true`}
    GROUP BY c.id ORDER BY c.last_activity_at DESC, c.short_id DESC LIMIT ${CONVERSATION_PAGE_SIZE + 1}
  `;
  const page = rows.slice(0, CONVERSATION_PAGE_SIZE);
  const names = await titles(page, input, sql);
  const items = page.map((row) =>
    project(
      row,
      z.enum(["read", "write", "admin"]).parse(capPermission(permissionFromRank(row.permission_rank), input.actor)),
      names.get(row.id)!,
    ),
  );
  const last = page.at(-1);
  return ok({
    items,
    nextCursor: rows.length > CONVERSATION_PAGE_SIZE && last ? JSON.stringify({ at: last.cursor_at, id: last.short_id }) : null,
  });
};
const update = async (input: ChatContext & { conversationId: string; input: unknown }) => {
  const parsed = parse(UpdateConversationSchema, input.input, input);
  if (!parsed.ok) return parsed;
  return transaction(async (db) => {
    await lockConversation(db, input.conversationId);
    const allowed = await requireConversation({ ...input, required: "write" }, db);
    if (!allowed.ok) return allowed;
    const data = parsed.data;
    const before = allowed.data;
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
    return ok(project(row, before.permission, names.get(before.id)!));
  });
};

type MemberRow = { access_id: string; user_id: string; permission: Exclude<PermissionLevel, "none">; added_at: Date; active: boolean };
const directEntries = (db: typeof sql, conversationId: string) => db<MemberRow[]>`
  SELECT ca.access_id, a.user_id, a.permission, ca.added_at, (u.account_expires IS NULL OR u.account_expires > now()) AS active
  FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
  JOIN auth.users u ON u.id = a.user_id
  WHERE ca.conversation_id = ${conversationId}::uuid AND ca.role = 'member' AND a.user_id IS NOT NULL ORDER BY ca.access_id
`;
const candidate = (row: MemberRow) => ({
  id: row.access_id,
  principal: { type: "user" as const, userId: row.user_id },
  permission: row.permission,
});
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
  const allowed = await requireConversation({ ...input, required: "read" });
  if (!allowed.ok) return allowed;
  const parsed = parse(MemberQuerySchema, input.query ?? {}, input);
  if (!parsed.ok) return parsed;
  const cursor = parsed.data.cursor;
  const rows = await sql<MemberRow[]>`SELECT ca.access_id, a.user_id, a.permission, ca.added_at
    FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
    WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.role = 'member' AND a.user_id IS NOT NULL
      AND ${cursor ? sql`ca.access_id > ${cursor}::uuid` : sql`true`} ORDER BY ca.access_id LIMIT ${MEMBER_PAGE_SIZE + 1}`;
  const page = rows.slice(0, MEMBER_PAGE_SIZE);
  const entries = await resolveDisplayNames(
    page.map((row) => ({
      accessId: row.access_id,
      principal: { type: "user" as const, userId: row.user_id },
      permission: row.permission,
      addedAt: row.added_at.toISOString(),
    })),
  );
  return ok({ items: entries, nextCursor: rows.length > MEMBER_PAGE_SIZE ? page.at(-1)!.access_id : null });
};
const addMembers = async (input: ChatContext & { conversationId: string; input: unknown }) => {
  const parsed = parse(AddMembersSchema, input.input, input);
  if (!parsed.ok) return parsed;
  return transaction(async (db) => {
    await lockConversation(db, input.conversationId);
    const allowed = await authorizeManagement(db, input, input.conversationId, "chat.member.add");
    if (!allowed.ok) return allowed;
    const before = await directEntries(db, allowed.data.id);
    const ids = parsed.data.members.filter((id) => !before.some((row) => row.user_id === id));
    if (input.accessSubject.type === "user" && ids.length) {
      const [caller] = await db<
        { profile: string }[]
      >`SELECT profile FROM auth.users WHERE id = ${input.accessSubject.userId}::uuid FOR SHARE`;
      if (caller?.profile === "guest") return fail(err.badInput(messages(input).guestMembers));
    }
    const valid = await validateMembers(ids, input, db);
    if (!valid.ok) return valid;
    // Count participants too: the total limit also covers future on-demand participants.
    const [count] = await db<
      { count: number }[]
    >`SELECT COUNT(*)::int AS count FROM chat.participants WHERE conversation_id = ${allowed.data.id}::uuid`;
    if ((count?.count ?? 0) + ids.length > MAX_PARTICIPANTS) return fail(err.badInput(messages(input).participantLimit));
    for (const id of ids) await addDirectMember(db, allowed.data, id, "write", input);
    if (ids.length) {
      await db`UPDATE chat.conversations SET member_count = member_count + ${ids.length} WHERE id = ${allowed.data.id}::uuid`;
      await appendMessage(db, allowed.data, input, {
        kind: "system",
        system: {
          code: "members_added",
          params: { members: await personSnapshots(db, ids) },
        },
      });
    }
    await record(db, input, allowed.data.short_id, "chat.member.add", { count: ids.length });
    return ok({ added: ids.length });
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
      const [snapshot] = await personSnapshots(db, [member.user_id]);
      await appendMessage(db, allowed.data, input, {
        kind: "system",
        system: {
          code: "permission_changed",
          params: { member: snapshot!, permission: parsed.data.permission },
        },
      });
    }
    await record(db, input, allowed.data.short_id, "chat.member.update", { permission: parsed.data.permission });
    return ok({ success: true as const });
  });
};
const deleteDirect = async (db: typeof sql, row: ConversationRow, member: MemberRow) => {
  await db`DELETE FROM chat.participants WHERE conversation_id = ${row.id}::uuid AND principal_type = 'user' AND principal_id = ${member.user_id}::uuid`;
  value(await deleteAccess({ id: member.access_id }, db)); // FK cascade removes the junction.
  await db`UPDATE chat.conversations SET member_count = member_count - 1 WHERE id = ${row.id}::uuid`;
};
const removeMember = async (input: ChatContext & { conversationId: string; accessId: string }) => {
  if (!z.uuid().safeParse(input.accessId).success) return notMember(input);
  return transaction(async (db) => {
    await lockConversation(db, input.conversationId);
    const allowed = await authorizeManagement(db, input, input.conversationId, "chat.member.remove");
    if (!allowed.ok) return allowed;
    const before = await directEntries(db, allowed.data.id);
    const member = before.find((row) => row.access_id === input.accessId.toLowerCase());
    if (!member) return notMember(input);
    const guarded = guardManagers(
      before,
      before.filter((row) => row.access_id !== member.access_id),
      input,
    );
    if (!guarded.ok) return guarded;
    const [snapshot] = await personSnapshots(db, [member.user_id]);
    await deleteDirect(db, allowed.data, member);
    await appendMessage(db, allowed.data, input, { kind: "system", system: { code: "member_removed", params: { member: snapshot! } } });
    await record(db, input, allowed.data.short_id, "chat.member.remove", { count: 1 });
    return ok({ success: true as const });
  });
};
const leave = async (input: ChatContext & { conversationId: string; input: unknown }) => {
  const parsed = parse(LeaveSchema, input.input, input);
  if (!parsed.ok) return parsed;
  return transaction(async (db) => {
    await lockConversation(db, input.conversationId);
    const allowed = await authorizeManagement(db, input, input.conversationId, "chat.member.leave", "read");
    if (!allowed.ok) return allowed;
    const before = await directEntries(db, allowed.data.id);
    const self = subjectPrincipal(input.accessSubject);
    const own = self.type === "user" ? before.find((row) => row.user_id === self.id) : undefined;
    const t = messages(input);
    if (!own) return conflict(t.noDirectEntry);
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
    const [snapshot] = successorMember ? await personSnapshots(db, [successorMember.user_id]) : [];
    await deleteDirect(db, allowed.data, own);
    await appendMessage(db, allowed.data, input, {
      kind: "system",
      system: {
        code: "member_left",
        params: snapshot ? { successor: snapshot } : {},
      },
    });
    await record(db, input, allowed.data.short_id, "chat.member.leave", { count: 1, ...(needsSuccessor ? { permission: "admin" } : {}) });
    return ok({ success: true as const });
  });
};

export const conversations = {
  create,
  list,
  get,
  update,
  members: { list: listMembers, add: addMembers, update: updateMember, remove: removeMember },
  leave,
};
