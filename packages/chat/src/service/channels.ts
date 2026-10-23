import { createAccess, deleteAccess, err, fail, ok } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { z } from "zod";
import {
  actingPrincipal,
  boundConversation,
  type ChatContext,
  type ConversationRow,
  capPermission,
  discoveryAllowed,
  discoveryGroupCondition,
  messages,
  principalCondition,
  repairMemberCount,
  requireConversation,
  subjectPrincipal,
} from "./access";
import {
  ChannelQuerySchema,
  CONVERSATION_PAGE_SIZE,
  DiscoveryEntriesSchema,
  type DiscoveryEntrySchema,
  DiscoveryUpdateSchema,
  MAX_PARTICIPANTS,
} from "./contracts";
import { addDirectSubject, conversations, lockConversation, projectConversations, record, transaction, value } from "./conversations";
import { publishMembership } from "./live-updates";
import { appendMessage } from "./message-store";

type Entry = z.infer<typeof DiscoveryEntrySchema>;
export const validateDiscovery = async (db: typeof sql, entries: Entry[], context: ChatContext) => {
  const t = messages(context);
  if (entries.some((entry) => entry.principal.type === "authenticated") && !(await discoveryAllowed()))
    return fail(err.badInput(t.authenticatedDiscoveryDisabled));
  const groupIds = entries.flatMap((entry) => (entry.principal.type === "group" ? [entry.principal.groupId] : []));
  if (groupIds.length) {
    const [caller] =
      context.accessSubject.type === "user"
        ? await db<{ profile: string }[]>`SELECT profile FROM auth.users WHERE id = ${context.accessSubject.userId}::uuid`
        : [];
    if (caller?.profile === "guest") return fail(err.badInput(t.fullAccountGroups));
    const rows = await db<{ id: string }[]>`SELECT id FROM auth.groups WHERE id = ANY(${toPgUuidArray(groupIds)}::uuid[]) FOR SHARE`;
    if (rows.length !== groupIds.length) return fail(err.badInput(t.groupUnavailable));
  }
  return ok();
};
const audience = async (db: typeof sql, entries: Entry[], conversationId?: string) => {
  const authenticated = entries.some((entry) => entry.principal.type === "authenticated") && (await discoveryAllowed());
  const ids = entries.flatMap((entry) => (entry.principal.type === "group" ? [entry.principal.groupId] : []));
  const [row] = await db<{ count: number }[]>`
    WITH RECURSIVE groups(id, provider) AS (
      SELECT id, provider FROM auth.groups WHERE id = ANY(${toPgUuidArray(ids)}::uuid[])
      UNION SELECT child.id, child.provider FROM groups parent JOIN auth.group_groups_v2 gg ON gg.parent_group_id = parent.id
      JOIN auth.groups child ON child.id = gg.child_group_id AND child.provider = parent.provider
    ) SELECT ((SELECT COUNT(*) FROM auth.users u WHERE (u.account_expires IS NULL OR u.account_expires > now())
      AND (${authenticated} OR (u.profile <> 'guest' AND u.id IN (SELECT ug.user_id FROM groups g JOIN auth.user_groups_v2 ug ON ug.group_id = g.id))))
      + (SELECT COUNT(*) FROM auth.service_accounts WHERE ${authenticated} AND status = 'active'
        AND (kind IN ('standalone', 'agent') OR (kind = 'resource_bound' AND app_id = 'chat'
          AND resource_type = 'conversation' AND resource_id = ${conversationId ?? null}))))::int AS count`;
  return { audienceCount: row!.count, includesAuthenticated: authenticated };
};
export const writeDiscovery = async (db: typeof sql, row: ConversationRow, entries: Entry[], context: ChatContext) => {
  const previous = await db<
    { access_id: string }[]
  >`SELECT access_id FROM chat.conversation_access WHERE conversation_id = ${row.id}::uuid AND role = 'discoverable'`;
  for (const entry of previous) value(await deleteAccess({ id: entry.access_id }, db));
  const actor = actingPrincipal(context.actor);
  for (const entry of entries) {
    const access = value(await createAccess({ principal: entry.principal, permission: entry.permission }, db));
    await db`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${row.id}::uuid, ${access.id}::uuid, 'discoverable', ${actor.type}, ${actor.id}::uuid)`;
  }
};
const preview = async (input: ChatContext & { input: unknown; conversationId?: string }) => {
  const parsed = DiscoveryEntriesSchema.safeParse(input.input);
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok || (bound.data !== null && !input.conversationId) || capPermission("read", input.actor) === "none")
    return fail(err.forbidden(messages(input).forbidden));
  return sql.begin(async (db) => {
    if (input.conversationId) {
      const allowed = await requireConversation({ ...input, conversationId: input.conversationId, required: "admin" }, db);
      if (!allowed.ok) return allowed;
    }
    const valid = await validateDiscovery(db, parsed.data, input);
    return valid.ok ? ok(await audience(db, parsed.data, input.conversationId)) : valid;
  });
};
const get = async (input: ChatContext & { conversationId: string }) =>
  sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const allowed = await requireConversation({ ...input, required: "admin" }, db);
    if (!allowed.ok) return allowed;
    const entries = await db<{ access_id: string; group_id: string | null; permission: "read" | "write"; name: string | null }[]>`
    SELECT ca.access_id, a.group_id, a.permission, COALESCE(NULLIF(g.name, ''), g.cn) AS name
    FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id LEFT JOIN auth.groups g ON g.id = a.group_id
    WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.role = 'discoverable' ORDER BY ca.added_at, ca.access_id`;
    const projected = entries.map((entry) => ({
      accessId: entry.access_id,
      principal: entry.group_id ? { type: "group" as const, groupId: entry.group_id } : { type: "authenticated" as const },
      permission: entry.permission,
      displayName: entry.name ?? messages(input).allAuthenticated,
    }));
    return ok({
      entries: projected,
      allowAuthenticated: await discoveryAllowed(),
      ...(await audience(db, projected, allowed.data.short_id)),
    });
  });
const update = async (input: ChatContext & { conversationId: string; input: unknown }) => {
  const parsed = DiscoveryUpdateSchema.safeParse(input.input);
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  return transaction(async (db) => {
    await lockConversation(db, input.conversationId);
    const allowed = await requireConversation({ ...input, required: "admin" }, db);
    if (!allowed.ok) return allowed;
    const data = parsed.data;
    if (data.entries.length && !(data.name === undefined ? allowed.data.name : data.name))
      return fail(err.badInput(messages(input).channelNameRequired));
    if (data.entries.length && !(data.purpose === undefined ? allowed.data.purpose : data.purpose))
      return fail(err.badInput(messages(input).channelPurposeRequired));
    if (data.entries.length) {
      const [thread] = await db`SELECT id FROM chat.threads WHERE conversation_id = ${allowed.data.id}::uuid LIMIT 1`;
      if (thread) return fail({ code: "THREADS_UNAVAILABLE", status: 409, message: messages(input).threadsUnavailable });
    }
    const valid = await validateDiscovery(db, data.entries, input);
    if (!valid.ok) return valid;
    const previous = await db<{ group_id: string | null; permission: string }[]>`SELECT a.group_id, a.permission
      FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.role = 'discoverable'`;
    const entryKey = (groupId: string | null, permission: string) => `${groupId ?? "authenticated"}:${permission}`;
    const oldKeys = previous.map((entry) => entryKey(entry.group_id, entry.permission)).sort();
    const nextKeys = data.entries
      .map((entry) => entryKey(entry.principal.type === "group" ? entry.principal.groupId : null, entry.permission))
      .sort();
    const discoveryChanged = JSON.stringify(oldKeys) !== JSON.stringify(nextKeys);
    const changed = {
      ...(data.name !== undefined && data.name !== allowed.data.name ? { name: data.name } : {}),
      ...(data.purpose !== undefined && data.purpose !== allowed.data.purpose ? { purpose: data.purpose } : {}),
    };
    if (discoveryChanged) await writeDiscovery(db, allowed.data, data.entries, input);
    if (Object.keys(changed).length) {
      await db`UPDATE chat.conversations SET name = ${data.name === undefined ? allowed.data.name : data.name}, purpose = ${data.purpose === undefined ? allowed.data.purpose : data.purpose} WHERE id = ${allowed.data.id}::uuid`;
      await appendMessage(db, allowed.data, input, { kind: "system", system: { code: "details_changed", params: changed } });
    }
    if (discoveryChanged) {
      await appendMessage(db, allowed.data, input, {
        kind: "system",
        system: { code: "discovery_changed", params: { count: data.entries.length } },
      });
      await record(db, input, input.conversationId, "chat.discovery.update", { count: data.entries.length });
    }
    return conversations.get(input, db);
  });
};
const browse = async (input: ChatContext & { query?: unknown }) => {
  const parsed = ChannelQuerySchema.safeParse(input.query ?? {});
  if (!parsed.success) return fail(err.badInput(messages(input).invalidInput));
  const cursor = parsed.data.cursor;
  const bound = boundConversation(input.actor, input.locale);
  if (!bound.ok) return bound;
  if (capPermission("read", input.actor) === "none") return ok({ items: [], nextCursor: null });
  const allow = await discoveryAllowed();
  const pattern = parsed.data.q ? `%${parsed.data.q.replace(/[\\%_]/g, (c) => "\\" + c)}%` : null;
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (db) => {
    const rows = await db<
      (ConversationRow & { cursor_name: string; permission_rank: number })[]
    >`SELECT c.*, lower(c.name) COLLATE "C" AS cursor_name,
      (SELECT MAX(CASE WHEN ca.role = 'discoverable' THEN 1 ELSE CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END END)::int FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
        WHERE ca.conversation_id = c.id AND ${principalCondition(input.accessSubject, db)} AND (ca.role = 'member' OR ${discoveryGroupCondition(input.accessSubject, db)}) AND a.permission IN ('read', 'write', 'admin') AND (ca.role = 'member' OR NOT a.authenticated_only OR ${allow})) AS permission_rank FROM chat.conversations c
      WHERE EXISTS(SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
        WHERE ca.conversation_id = c.id AND ca.role = 'discoverable' AND ${principalCondition(input.accessSubject, db)} AND (ca.role = 'member' OR ${discoveryGroupCondition(input.accessSubject, db)})
          AND a.permission IN ('read', 'write') AND (NOT a.authenticated_only OR ${allow}))
        AND ${bound.data ? db`c.short_id = ${bound.data}` : db`true`}
        AND ${pattern ? db`(c.name ILIKE ${pattern} OR c.purpose ILIKE ${pattern})` : db`true`}
        AND ${cursor ? db`(lower(c.name) COLLATE "C", c.id) > (${cursor.name}, ${cursor.id}::uuid)` : db`true`}
      ORDER BY lower(c.name) COLLATE "C", c.id LIMIT ${CONVERSATION_PAGE_SIZE + 1}`;
    const page = rows.slice(0, CONVERSATION_PAGE_SIZE);
    const items = await projectConversations(db, page, input);
    const last = page.at(-1);
    return ok({
      items,
      nextCursor: rows.length > CONVERSATION_PAGE_SIZE && last ? JSON.stringify({ name: last.cursor_name, id: last.id }) : null,
    });
  });
};
const join = async (input: ChatContext & { conversationId: string }) =>
  transaction(async (db) => {
    await lockConversation(db, input.conversationId);
    const allowed = await requireConversation({ ...input, required: "read" }, db);
    if (!allowed.ok) return allowed;
    const self = subjectPrincipal(input.accessSubject);
    const [existing] = await db<{ member: boolean; rank: number }[]>`SELECT
    EXISTS(SELECT 1 FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.role = 'member' AND ${principalCondition(input.accessSubject, db)} AND (ca.role = 'member' OR ${discoveryGroupCondition(input.accessSubject, db)}) AND a.permission IN ('read', 'write', 'admin')) AS member,
    (SELECT COALESCE(MAX(CASE a.permission WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END), 0)::int FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
      WHERE ca.conversation_id = ${allowed.data.id}::uuid AND ca.role = 'discoverable' AND ${principalCondition(input.accessSubject, db)} AND (ca.role = 'member' OR ${discoveryGroupCondition(input.accessSubject, db)}) AND (NOT a.authenticated_only OR ${await discoveryAllowed()})) AS rank`;
    if (existing?.member) return conversations.get(input, db);
    if (!existing?.rank) return fail(err.forbidden(messages(input).forbidden));
    if (existing.rank >= 2 && capPermission("write", input.actor) === "read") return fail(err.forbidden(messages(input).forbidden));
    if ((await repairMemberCount(allowed.data.id, db)) >= MAX_PARTICIPANTS) return fail(err.badInput(messages(input).participantLimit));
    await addDirectSubject(db, allowed.data, self, existing.rank >= 2 ? "write" : "read", input);
    await repairMemberCount(allowed.data.id, db);
    await publishMembership(db, allowed.data, [self.type === "user" ? self.id : `service_account:${self.id}`]);
    await record(db, input, input.conversationId, "chat.member.join");
    return conversations.get(input, db);
  });
const options = async () => ok({ allowAuthenticated: await discoveryAllowed() });
export const channels = { options, preview, get, update, browse, join };
