import { lazySync } from "@k2b/cloud";
import { getEffectivePermissions, type PermissionLevel } from "@k2b/cloud/server";
import { accounts, coreSettings, logger, notifications } from "@k2b/cloud/services";
import { createPgOutbox } from "@k2b/cloud/services/outbox";
import { redis, sql } from "bun";
import { z } from "zod";
import { app } from "../config";
import type { PushData } from "../notifications";
import { messagePreview } from "../system-messages";
import { type ChatContext, type ConversationRow, discoveryAllowed, memberUsers } from "./access";
import { badgeCount } from "./badge";
import { titles } from "./conversation-titles";
import type { MessageRow } from "./message-store";
import { type NotificationChoice, resolveNotifications } from "./notification-levels";
import {
  recheckSystemRecipients,
  resolveSystemRecipients,
  SYSTEM_READER_VALIDITY_MS,
  type SystemReaderDecision,
} from "./system-notification-access";

export const DELIVERY_BATCH = 500;
export const PUSH_DELAY_MS = 3_000;
export const ALERT_WINDOW_SECONDS = 10;
const log = logger("chat:notifications");
const MessageInput = z.object({ messageId: z.uuid() });
const PushInput = z.object({ userId: z.uuid(), conversationId: z.uuid(), addedMessageId: z.uuid().optional() });
// Sync's documented defaults bound each stream to seven days / 256 maximum-size messages.
// JetStream evicts oldest pending work; sync.controls() exposes depth and dead letters in admin.
export const deliveryJob = lazySync((sync) => sync.job<z.infer<typeof MessageInput>>({ id: "chat:delivery" }));
export const pushJob = lazySync((sync) => sync.job<z.infer<typeof PushInput>>({ id: "chat:push" }));

type DeliveryMessage = MessageRow & { id: string; conversation_id: string; notification_cursor: string | null; notification_done: boolean };
type Candidate = {
  id: string;
  profile: string;
  notify: NotificationChoice;
  notify_until: Date | null;
  mention: boolean;
  reply: boolean;
  follow: boolean;
};
type Pending = {
  user_id: string;
  conversation_id: string;
  message_id: string;
  personal_message_id: string | null;
  reason: PushData["reason"];
  message_count: number;
  due_at: Date;
};
const pushKey = (userId: string, conversationId: string) => `${userId}:${conversationId}`;
export const alertKey = (userId: string) => `chat:push:alert:${userId}`;

/** The same bulk grant helper as Chat's live fan-out, including guest/discovery restrictions. */
const permissions = async (
  conversation: ConversationRow,
  people: { id: string; profile: string }[],
): Promise<Map<string, PermissionLevel>> => {
  const result = new Map<string, PermissionLevel>();
  // Owner decisions are prepared outside transactions; local Chat grants never authorize system chats.
  if (conversation.kind === "system") return result;
  const allow = await discoveryAllowed();
  for (const guest of [false, true]) {
    const group = people.filter((person) => (person.profile === "guest") === guest);
    if (!group.length) continue;
    const subjects = group.map((person) => ({ type: "user" as const, userId: person.id }));
    const [members, discovery] = await Promise.all([
      getEffectivePermissions({
        accessIds: sql`SELECT access_id FROM chat.conversation_access WHERE conversation_id = ${conversation.id}::uuid AND role = 'member'`,
        subjects,
      }),
      getEffectivePermissions({
        accessIds: sql`SELECT ca.access_id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
          WHERE ca.conversation_id = ${conversation.id}::uuid AND ca.role = 'discoverable'
            AND (NOT a.authenticated_only OR ${allow}) AND (${!guest} OR a.group_id IS NULL)`,
        subjects,
      }),
    ]);
    // Discovery grants authorize reading only; joining creates the member grant that can authorize writing.
    for (const [index, person] of group.entries()) {
      const member = members[index] ?? "none";
      result.set(person.id, member !== "none" ? member : (discovery[index] ?? "none") !== "none" ? "read" : "none");
    }
  }
  return result;
};
const messageCandidates = (db: typeof sql, message: DeliveryMessage, conversation: ConversationRow) => db<Candidate[]>`
  WITH recipients AS (
    SELECT principal_id AS id FROM chat.participants WHERE conversation_id = ${conversation.id}::uuid AND principal_type = 'user' AND notify = 'all'
    UNION SELECT id FROM (${memberUsers(conversation.id, db)}) members
    UNION SELECT principal_id FROM chat.message_mentions WHERE message_id = ${message.id}::uuid AND principal_type = 'user'
    UNION SELECT author_id FROM chat.messages WHERE conversation_id = ${conversation.id}::uuid AND seq = ${message.reply_to_seq} AND author_type = 'user'
    UNION SELECT principal_id FROM chat.thread_follows WHERE conversation_id = ${conversation.id}::uuid AND thread_id = ${message.thread_id}::uuid
      AND principal_type = 'user' AND ${conversation.kind === "system"}
  ) SELECT u.id, u.profile, COALESCE(p.notify, 'default') AS notify, p.notify_until,
    EXISTS(SELECT 1 FROM chat.message_mentions mm WHERE mm.message_id = ${message.id}::uuid AND mm.principal_type = 'user' AND mm.principal_id = u.id) AS mention,
    EXISTS(SELECT 1 FROM chat.messages original WHERE original.conversation_id = ${conversation.id}::uuid AND original.seq = ${message.reply_to_seq}
      AND original.author_type = 'user' AND original.author_id = u.id) AS reply,
    EXISTS(SELECT 1 FROM chat.thread_follows f WHERE f.principal_type = 'user' AND f.principal_id = u.id AND f.thread_id = ${message.thread_id}::uuid
      AND ${conversation.kind === "system"}) AS follow
  FROM recipients r JOIN auth.users u ON u.id = r.id
  LEFT JOIN chat.participants p ON p.conversation_id = ${conversation.id}::uuid AND p.principal_type = 'user' AND p.principal_id = u.id
  WHERE NOT (${message.author_type} = 'user' AND u.id = ${message.author_id}::uuid)
    AND (p.conversation_id IS NULL OR p.joined_seq < ${message.seq})
    AND (u.account_expires IS NULL OR u.account_expires > now())
    AND ${message.notification_cursor ? db`u.id > ${message.notification_cursor}::uuid` : db`true`} ORDER BY u.id LIMIT ${DELIVERY_BATCH}`;

const addedCandidates = (db: typeof sql, message: DeliveryMessage, conversation: ConversationRow) => db<Candidate[]>`
  SELECT u.id, u.profile, COALESCE(p.notify, 'default') AS notify, p.notify_until, false AS mention, false AS reply, false AS follow
  FROM chat.messages added CROSS JOIN LATERAL unnest(added.notification_added_users) recipients(id) JOIN auth.users u ON u.id = recipients.id
  JOIN chat.participants p ON p.conversation_id = ${conversation.id}::uuid AND p.principal_type = 'user' AND p.principal_id = u.id
  WHERE added.id = ${message.id}::uuid AND NOT (${message.author_type} = 'user' AND u.id = ${message.author_id}::uuid)
    AND (u.account_expires IS NULL OR u.account_expires > now())
    AND ${message.notification_cursor ? db`u.id > ${message.notification_cursor}::uuid` : db`true`} ORDER BY u.id LIMIT ${DELIVERY_BATCH}`;

/** One durable cursor update and all recipient aggregates commit together; redelivery never adds a message twice. */
export const deliverMessage = async (messageId: string, signal?: AbortSignal): Promise<boolean> => {
  const [preparedMessage] = await sql<DeliveryMessage[]>`SELECT * FROM chat.messages WHERE id = ${messageId}::uuid`;
  if (!preparedMessage || preparedMessage.notification_done) return false;
  const [preparedConversation] = await sql<
    ConversationRow[]
  >`SELECT * FROM chat.conversations WHERE id = ${preparedMessage.conversation_id}::uuid`;
  if (!preparedConversation) return false;
  const preparedCandidates =
    preparedMessage.kind === "text"
      ? await messageCandidates(sql, preparedMessage, preparedConversation)
      : await addedCandidates(sql, preparedMessage, preparedConversation);
  const system =
    preparedConversation.kind === "system"
      ? await resolveSystemRecipients(
          preparedConversation.id,
          preparedMessage.thread_id,
          preparedCandidates.map((person) => person.id),
          sql,
          "background",
          { signal },
        )
      : null;
  const access = system
    ? new Map([...system.readable].map((id) => [id, "read" as const]))
    : await permissions(preparedConversation, preparedCandidates);
  const queued = await sql.begin(async (db) => {
    if (system) await db`SET LOCAL lock_timeout = '1s'`;
    const [message] = await db<DeliveryMessage[]>`SELECT * FROM chat.messages WHERE id = ${messageId}::uuid FOR UPDATE`;
    if (!message || message.notification_done) return false;
    const [conversation] = await db<ConversationRow[]>`SELECT * FROM chat.conversations WHERE id = ${message.conversation_id}::uuid`;
    if (!conversation) return false;
    const candidates =
      message.kind === "text" ? await messageCandidates(db, message, conversation) : await addedCandidates(db, message, conversation);
    // A concurrent delivery or resource change invalidates preparation; retry from the durable cursor.
    if (
      message.notification_cursor !== preparedMessage.notification_cursor ||
      message.thread_id !== preparedMessage.thread_id ||
      conversation.kind !== preparedConversation.kind ||
      conversation.resource_type !== preparedConversation.resource_type ||
      conversation.resource_id !== preparedConversation.resource_id ||
      candidates.some((person) => !preparedCandidates.some((prepared) => prepared.id === person.id))
    )
      return true;
    if (system?.readable.size && performance.now() >= system.deadline) throw new Error("System chat reader decision expired");
    if (system) {
      const current = await recheckSystemRecipients(system, conversation.id, message.thread_id, db);
      for (const id of access.keys()) if (!current.has(id)) access.delete(id);
    }
    const [flags] = await db<{ channel: boolean; now: Date }[]>`SELECT clock_timestamp() AS now,
      EXISTS(SELECT 1 FROM chat.conversation_access WHERE conversation_id = ${conversation.id}::uuid AND role = 'discoverable') AS channel`;
    for (const person of candidates) {
      const permission = access.get(person.id) ?? "none";
      if (permission === "none") continue;
      const level = resolveNotifications(
        {
          kind: conversation.kind,
          channel: flags!.channel,
          permission,
          memberCount: conversation.member_count,
          notify: person.notify,
          notifyUntil: person.notify_until,
        },
        flags!.now,
      ).level;
      const reason =
        message.kind === "system" ? "added" : person.mention ? "mention" : person.reply ? "reply" : person.follow ? "follow" : "message";
      if (level === "none" || (reason === "message" && level !== "all")) continue;
      if (reason === "added") {
        await db`INSERT INTO chat.notification_outbox (message_id, conversation_id, user_id, ordering_key, due_at)
          VALUES (${message.id}::uuid, ${conversation.id}::uuid, ${person.id}::uuid, ${pushKey(person.id, conversation.id)}, ${message.created_at}::timestamptz + interval '3 seconds') ON CONFLICT DO NOTHING`;
        continue;
      }
      await db`INSERT INTO chat.notification_push_state (user_id, conversation_id)
        VALUES (${person.id}::uuid, ${conversation.id}::uuid) ON CONFLICT DO NOTHING`;
      const [pushed] = await db<{ last_seq: string }[]>`SELECT last_seq FROM chat.notification_push_state
        WHERE user_id = ${person.id}::uuid AND conversation_id = ${conversation.id}::uuid FOR UPDATE`;
      if (pushed && Number(pushed.last_seq) >= Number(message.seq)) continue;
      const personal = reason === "mention" || reason === "reply" || reason === "follow";
      const [row] = await db<
        Pending[]
      >`INSERT INTO chat.notification_pending AS pending (user_id, conversation_id, message_id, personal_message_id, reason)
        VALUES (${person.id}::uuid, ${conversation.id}::uuid, ${message.id}::uuid, ${personal ? message.id : null}::uuid, ${reason})
        ON CONFLICT (user_id, conversation_id) DO UPDATE SET
          message_id = CASE WHEN (SELECT seq FROM chat.messages WHERE id = pending.message_id) < ${message.seq} THEN EXCLUDED.message_id ELSE pending.message_id END,
          personal_message_id = CASE WHEN ${personal} AND (pending.personal_message_id IS NULL
            OR (SELECT seq FROM chat.messages WHERE id = pending.personal_message_id) < ${message.seq})
            THEN EXCLUDED.personal_message_id ELSE pending.personal_message_id END,
          reason = CASE WHEN pending.personal_message_id IS NULL OR (${personal}
            AND (SELECT seq FROM chat.messages WHERE id = pending.personal_message_id) < ${message.seq})
            THEN EXCLUDED.reason ELSE pending.reason END,
          message_count = LEAST(pending.message_count::bigint + 1, 2147483647)::int
        RETURNING *`;
      if (row) {
        await db`INSERT INTO chat.notification_outbox (message_id, conversation_id, user_id, ordering_key, due_at)
          VALUES (${message.id}::uuid, ${conversation.id}::uuid, ${person.id}::uuid, ${pushKey(person.id, conversation.id)}, ${row.due_at})
          ON CONFLICT DO NOTHING`;
      }
    }
    // Roll back every aggregate if local work outlived its prepared owner decision.
    if (system?.readable.size && performance.now() >= system.deadline) throw new Error("System chat reader decision expired");
    const more = candidates.length === DELIVERY_BATCH;
    await db`UPDATE chat.messages SET notification_cursor = ${candidates.at(-1)?.id ?? message.notification_cursor}::uuid,
      notification_done = ${!more} WHERE id = ${message.id}::uuid`;
    return more;
  });
  return queued;
};

export const notificationOutbox = createPgOutbox<{
  id: string;
  attempts: number;
  message_id: string;
  conversation_id: string;
  user_id: string | null;
  ordering_key: string;
  due_at: Date | null;
}>({
  table: "chat.notification_outbox",
  name: "chat:notification-outbox",
  orderBy: "ordering_key",
  sequence: "seq",
  reconcileIntervalMs: 1_000,
  publish: async (row) => {
    if (row.user_id) {
      const [message] = await sql<
        { kind: string; short_id: string }[]
      >`SELECT kind, short_id FROM chat.messages WHERE id = ${row.message_id}::uuid`;
      if (!message) return;
      const added = message.kind === "system";
      const [pending] = added
        ? [true]
        : await sql`SELECT 1 FROM chat.notification_pending WHERE user_id = ${row.user_id}::uuid AND conversation_id = ${row.conversation_id}::uuid`;
      if (!pending) return;
      const receipt = await pushJob().submit({
        key: `${pushKey(row.user_id, row.conversation_id)}${added ? `:${message.short_id}` : ""}`,
        input: { userId: row.user_id, conversationId: row.conversation_id, ...(added ? { addedMessageId: row.message_id } : {}) },
        coalesce: true,
        at: row.due_at ?? undefined,
      });
      // Do not lose work submitted while a previous job for this chat is settling.
      // The outbox retries duplicates until the running job consumed it or the key is released.
      if (receipt.duplicate) throw new Error("Chat push already queued or running");
    } else await deliveryJob().submit({ key: row.message_id, input: { messageId: row.message_id }, coalesce: true });
  },
});

const recipientContext = async (userId: string): Promise<ChatContext | null> => {
  const user = await accounts.users.get({ id: userId });
  if (!user) return null;
  const [prefs] = await sql<
    { locale: string | null }[]
  >`SELECT locale FROM chat.account_prefs WHERE principal_type = 'user' AND principal_id = ${userId}::uuid`;
  return {
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId },
    locale: prefs?.locale ?? (await coreSettings.get<string>("app.locale")),
  };
};
/** Atomic SET NX owns the exact rolling 10-second alert budget across all chat replicas. */
export const allowAlert = async (userId: string, desired: boolean, mention: boolean): Promise<boolean> => {
  if (!desired) return false;
  if (mention) return true;
  return (await redis.send("SET", [alertKey(userId), "1", "NX", "EX", String(ALERT_WINDOW_SECONDS)])) === "OK";
};
const pushParticipant = async (db: typeof sql, userId: string, conversationId: string, threadId: string | null, lastSeq: string) => {
  const [participant] = await db<
    { notify: NotificationChoice; notify_until: Date | null; read_seq: string; channel: boolean; read_since_push: boolean }[]
  >`
    SELECT p.notify, p.notify_until,
      LEAST(GREATEST(COALESCE(CASE WHEN ${threadId}::uuid IS NULL THEN p.last_read_seq ELSE tr.last_read_seq END, 0), p.joined_seq),
        COALESCE((CASE WHEN ${threadId}::uuid IS NULL THEN p.unread_from_seq ELSE tr.unread_from_seq END) - 1, 9223372036854775807)) AS read_seq,
      EXISTS(SELECT 1 FROM chat.conversation_access WHERE conversation_id = p.conversation_id AND role = 'discoverable') AS channel,
      (COALESCE(p.last_read_seq, 0) >= ${lastSeq} OR EXISTS(SELECT 1 FROM chat.thread_reads reads
        WHERE reads.principal_type = 'user' AND reads.principal_id = p.principal_id AND reads.conversation_id = p.conversation_id AND reads.last_read_seq >= ${lastSeq})) AS read_since_push
    FROM chat.participants p LEFT JOIN chat.thread_reads tr ON tr.thread_id = ${threadId}::uuid AND tr.principal_type = 'user' AND tr.principal_id = p.principal_id
    WHERE p.principal_type = 'user' AND p.principal_id = ${userId}::uuid AND p.conversation_id = ${conversationId}::uuid`;
  return participant;
};
/** Return the remaining delay when called early; workers resubmit rather than sleeping. */
export const sendPush = async (
  userId: string,
  conversationId: string,
  addedMessageId?: string,
  signal?: AbortSignal,
): Promise<number | null> => {
  // Prepare without a reserved connection. A short transaction validates this snapshot before enqueueing.
  const db = sql;
  await db`INSERT INTO chat.notification_push_state (user_id, conversation_id)
    SELECT u.id, c.id FROM auth.users u CROSS JOIN chat.conversations c WHERE u.id = ${userId}::uuid AND c.id = ${conversationId}::uuid ON CONFLICT DO NOTHING`;
  const [state] = await db<{ last_seq: string; last_push_at: Date | null }[]>`SELECT * FROM chat.notification_push_state
    WHERE user_id = ${userId}::uuid AND conversation_id = ${conversationId}::uuid`;
  if (!state) return null;
  const [pending] = addedMessageId
    ? await db<Pending[]>`SELECT ${userId}::uuid AS user_id, ${conversationId}::uuid AS conversation_id,
          id AS message_id, NULL::uuid AS personal_message_id, 'added' AS reason, 1 AS message_count, created_at + interval '3 seconds' AS due_at
          FROM chat.messages WHERE id = ${addedMessageId}::uuid AND conversation_id = ${conversationId}::uuid
            AND kind = 'system' AND ${userId}::uuid = ANY(notification_added_users) AND system_code IN ('conversation_created', 'members_added', 'groups_added')`
    : await db<
        Pending[]
      >`SELECT * FROM chat.notification_pending WHERE user_id = ${userId}::uuid AND conversation_id = ${conversationId}::uuid`;
  if (!pending) return null;
  const pendingSnapshot = { ...pending };
  const [clock] = await db<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const remaining = pending.due_at.getTime() - clock!.now.getTime();
  if (remaining > 0) return remaining;
  const clear = async (transaction: typeof sql = db) => {
    if (!addedMessageId)
      await transaction`DELETE FROM chat.notification_pending WHERE user_id = ${userId}::uuid AND conversation_id = ${conversationId}::uuid
          AND message_id = ${pendingSnapshot.message_id}::uuid AND personal_message_id IS NOT DISTINCT FROM ${pendingSnapshot.personal_message_id}::uuid
          AND reason = ${pendingSnapshot.reason} AND message_count = ${pendingSnapshot.message_count}`;
  };
  const [conversation] = await db<ConversationRow[]>`SELECT * FROM chat.conversations WHERE id = ${conversationId}::uuid`;
  // Preserve the newest undeleted message when a coalesced message was deleted during the delay.
  const [latest] = await db<DeliveryMessage[]>`SELECT * FROM chat.messages
    WHERE conversation_id = ${conversationId}::uuid AND deleted_at IS NULL
      AND seq <= (SELECT seq FROM chat.messages WHERE id = ${pending.message_id}::uuid)
      AND (${addedMessageId !== undefined} OR seq > ${state.last_seq})
      AND (${addedMessageId !== undefined} OR kind = 'text')
      AND (${addedMessageId === undefined} OR id = ${pending.message_id}::uuid)
    ORDER BY seq DESC LIMIT 1`;
  const [person] = await db<
    { id: string; profile: string }[]
  >`SELECT id, profile FROM auth.users WHERE id = ${userId}::uuid AND (account_expires IS NULL OR account_expires > now())`;
  if (!conversation || !latest || !person) {
    await clear();
    return null;
  }
  const permission = conversation.kind === "system" ? "read" : ((await permissions(conversation, [person])).get(userId) ?? "none");
  if (permission === "none") {
    await clear();
    return null;
  }
  const participant = await pushParticipant(db, userId, conversationId, latest.thread_id, state.last_seq);
  const level = resolveNotifications(
    {
      kind: conversation.kind,
      channel: participant?.channel ?? false,
      permission,
      memberCount: conversation.member_count,
      notify: participant?.notify ?? "default",
      notifyUntil: participant?.notify_until ?? null,
    },
    clock!.now,
  ).level;
  const [personal] = pending.personal_message_id
    ? await db<DeliveryMessage[]>`SELECT m.* FROM chat.messages m
          LEFT JOIN chat.participants p ON p.conversation_id = m.conversation_id AND p.principal_type = 'user' AND p.principal_id = ${userId}::uuid
          LEFT JOIN chat.thread_reads tr ON tr.thread_id = m.thread_id AND tr.principal_type = 'user' AND tr.principal_id = ${userId}::uuid
          WHERE m.id = ${pending.personal_message_id}::uuid AND m.deleted_at IS NULL AND m.seq > LEAST(GREATEST(COALESCE(
            CASE WHEN m.thread_id IS NULL THEN p.last_read_seq ELSE tr.last_read_seq END, 0), COALESCE(p.joined_seq, 0)),
            COALESCE((CASE WHEN m.thread_id IS NULL THEN p.unread_from_seq ELSE tr.unread_from_seq END) - 1, 9223372036854775807))`
    : [];
  if (pending.personal_message_id && !personal) {
    pending.reason = "message";
    pending.message_count = Math.max(1, pending.message_count - 1);
  }
  if (
    level === "none" ||
    (pending.reason === "message" && level !== "all") ||
    Number(participant?.read_seq ?? 0) >= Number(latest.seq) ||
    (!addedMessageId && Number(state.last_seq) >= Number(latest.seq))
  ) {
    await clear();
    return null;
  }
  const context = await recipientContext(userId);
  if (!context) {
    await clear();
    return null;
  }
  const chosen = personal ?? latest;
  const [author] = await db<
    { first_name: string; agent: boolean }[]
  >`SELECT COALESCE((SELECT given_name FROM auth.users WHERE id = ${chosen.author_id}::uuid), '') AS first_name,
    EXISTS(SELECT 1 FROM auth.service_accounts WHERE id = ${chosen.author_id}::uuid AND kind = 'agent' AND ${chosen.author_type} = 'service_account') AS agent`;
  const [attachment] = await db<
    { kind: "image" | "file" }[]
  >`SELECT kind FROM chat.attachments WHERE message_id = ${chosen.id}::uuid ORDER BY created_at, id LIMIT 1`;
  const [thread] = chosen.thread_id
    ? await db<{ short_id: string; name: string }[]>`SELECT short_id, name FROM chat.threads WHERE id = ${chosen.thread_id}::uuid`
    : [];
  const preview = await app.settings.get("chat.push_preview");
  const title = (await titles([conversation], context, db)).get(conversation.id)!;
  const personalReason = pending.reason === "mention" || pending.reason === "reply" || pending.reason === "follow";
  const alert = await allowAlert(
    userId,
    personalReason || state.last_push_at === null || participant?.read_since_push === true,
    // A mention or a reply to you always sounds, also inside another chat's 10-second alert window.
    pending.reason === "mention" || pending.reason === "reply",
  );
  const data: PushData = {
    chat: conversation.short_id,
    title,
    sender: chosen.author_name,
    firstName: author?.first_name.trim().split(/\s+/)[0] || chosen.author_name.split(/\s+/)[0] || chosen.author_name,
    agent: author?.agent ?? false,
    text: preview ? messagePreview(chosen.body_md ?? "") : "",
    attachment: attachment?.kind ?? null,
    reason: pending.reason,
    threadName: thread?.name ?? null,
    href: `/app/chat/c/${conversation.short_id}${thread ? `/t/${thread.short_id}` : ""}/m/${chosen.short_id}`,
    // Earlier coalesced messages can belong to other, now unreadable elements.
    further: conversation.kind === "system" ? 0 : pending.message_count - 1,
    preview,
    badge: await badgeCount(context, sql, "cached"),
    alert,
  };
  const definition =
    pending.reason === "added" ? app.notifications.added : personalReason ? app.notifications.mention : app.notifications.message;
  const decisions = new Map<string | null, SystemReaderDecision>();
  // Use a monotonic clock and include all owner round-trips and connection/lock waits.
  const readerDeadline = conversation.kind === "system" ? performance.now() + SYSTEM_READER_VALIDITY_MS : null;
  if (conversation.kind === "system") {
    const readerSignal = AbortSignal.any([AbortSignal.timeout(SYSTEM_READER_VALIDITY_MS), ...(signal ? [signal] : [])]);
    for (const threadId of new Set([chosen.thread_id, latest.thread_id])) {
      const decision = await resolveSystemRecipients(conversation.id, threadId, [userId], sql, "background", {
        signal: readerSignal,
        locale: context.locale,
      });
      if (!decision.readable.has(userId)) {
        await clear();
        return null;
      }
      decisions.set(threadId, decision);
    }
  }
  return sql.begin(async (transaction) => {
    // Overlapping workers serialize only local validation and the idempotent platform enqueue.
    if (readerDeadline !== null) await transaction`SET LOCAL lock_timeout = '1s'`;
    const [currentState] = await transaction<{ last_seq: string }[]>`SELECT last_seq FROM chat.notification_push_state
        WHERE user_id = ${userId}::uuid AND conversation_id = ${conversationId}::uuid FOR UPDATE`;
    if (!currentState || String(currentState.last_seq) !== String(state.last_seq)) return PUSH_DELAY_MS;
    if (!addedMessageId) {
      const [current] = await transaction<Pending[]>`SELECT * FROM chat.notification_pending
          WHERE user_id = ${userId}::uuid AND conversation_id = ${conversationId}::uuid FOR UPDATE`;
      if (!current) return null;
      // New delivery may grow this aggregate while the owner answers. It must not starve this send.
      const [stillPending] = await transaction`SELECT 1 FROM chat.messages current, chat.messages prepared
          WHERE current.id = ${current.message_id}::uuid AND prepared.id = ${pendingSnapshot.message_id}::uuid
            AND current.seq >= prepared.seq`;
      if (!stillPending) return PUSH_DELAY_MS;
    }
    for (const [threadId, decision] of decisions)
      if (!(await recheckSystemRecipients(decision, conversation.id, threadId, transaction)).has(userId)) {
        await clear(transaction);
        return null;
      }
    // Local reads/mutes/expiry can change while the owner is answering. Discard preparation and retry.
    const currentParticipant = await pushParticipant(transaction, userId, conversationId, latest.thread_id, state.last_seq);
    if (JSON.stringify(currentParticipant) !== JSON.stringify(participant)) return PUSH_DELAY_MS;
    if (conversation.kind !== "system" && (await permissions(conversation, [person])).get(userId) === "none") {
      await clear(transaction);
      return null;
    }
    const [unchanged] = await transaction`SELECT 1 FROM chat.conversations c JOIN auth.users u ON u.id = ${userId}::uuid
        WHERE c.id = ${conversationId}::uuid
          AND c.kind = ${conversation.kind} AND c.resource_type IS NOT DISTINCT FROM ${conversation.resource_type}
          AND c.resource_id IS NOT DISTINCT FROM ${conversation.resource_id}
          AND (u.account_expires IS NULL OR u.account_expires > now())`;
    if (!unchanged) return PUSH_DELAY_MS;
    for (const message of [chosen, latest]) {
      const [unchangedMessage] = await transaction`SELECT 1 FROM chat.messages
          WHERE id = ${message.id}::uuid AND conversation_id = ${conversationId}::uuid AND deleted_at IS NULL
            AND thread_id IS NOT DISTINCT FROM ${message.thread_id}::uuid
            AND content_rev IS NOT DISTINCT FROM ${message.content_rev ?? null}::bigint`;
      if (!unchangedMessage) return PUSH_DELAY_MS;
    }
    if (readerDeadline !== null && performance.now() >= readerDeadline) throw new Error("System chat reader decision expired");
    const result = await notifications.send(definition, {
      recipient: { userId },
      data,
      locale: context.locale,
      idempotencyKey: `${conversation.short_id}:${latest.short_id}`,
    });
    if (result.status === "error") throw new Error("Chat notification preparation failed");
    await transaction`UPDATE chat.notification_push_state SET last_seq = GREATEST(last_seq, ${latest.seq}), last_push_at = clock_timestamp()
    WHERE user_id = ${userId}::uuid AND conversation_id = ${conversationId}::uuid`;
    if (!addedMessageId) {
      // Consume this snapshot while retaining any newer delivery and its personal reason.
      await transaction`DELETE FROM chat.notification_pending WHERE user_id = ${userId}::uuid
          AND conversation_id = ${conversationId}::uuid AND message_id = ${pendingSnapshot.message_id}::uuid`;
      await transaction`UPDATE chat.notification_pending SET
          due_at = GREATEST(due_at, clock_timestamp() + interval '3 seconds'),
          message_count = GREATEST(1, message_count - ${pendingSnapshot.message_count}),
          reason = CASE WHEN personal_message_id IS NOT DISTINCT FROM ${pendingSnapshot.personal_message_id}::uuid THEN 'message' ELSE reason END,
          personal_message_id = CASE WHEN personal_message_id IS NOT DISTINCT FROM ${pendingSnapshot.personal_message_id}::uuid THEN NULL ELSE personal_message_id END
          WHERE user_id = ${userId}::uuid AND conversation_id = ${conversationId}::uuid`;
    }
    return null;
  });
};

let deliveryWorker: Awaited<ReturnType<ReturnType<typeof deliveryJob>["process"]>> | undefined;
let pushWorker: Awaited<ReturnType<ReturnType<typeof pushJob>["process"]>> | undefined;
export const notificationLifecycle = {
  async start() {
    deliveryWorker = await deliveryJob().process({ concurrency: 1 }, async (context) => {
      context.signal.throwIfAborted();
      const input = MessageInput.parse(context.input);
      if (await deliverMessage(input.messageId, context.signal)) context.resubmit();
      await context.heartbeat();
    });
    pushWorker = await pushJob().process({ concurrency: 1 }, async (context) => {
      context.signal.throwIfAborted();
      const input = PushInput.parse(context.input);
      const delayMs = await sendPush(input.userId, input.conversationId, input.addedMessageId, context.signal);
      if (delayMs !== null) context.resubmit({ delayMs });
    });
    notificationOutbox.start();
    log.info("Chat notification workers started", { deliveryBatch: DELIVERY_BATCH, pushDelayMs: PUSH_DELAY_MS, retention: "sync-default" });
  },
  async stop() {
    await notificationOutbox.stop();
    deliveryWorker?.stop();
    pushWorker?.stop();
    await Promise.all([deliveryWorker?.drain(), pushWorker?.drain()]);
    deliveryWorker = undefined;
    pushWorker = undefined;
  },
};
