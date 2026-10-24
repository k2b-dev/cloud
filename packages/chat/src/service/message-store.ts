import type { CloudResourceRef } from "@k2b/cloud/contracts";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { crypto } from "@k2b/stdlib";
import type { sql } from "bun";
import type { z } from "zod";
import { messagePreview, renderSystemMessage } from "../system-messages";
import { type ChatContext, type ConversationRow, messages, subjectPrincipal } from "./access";
import { type MessageSchema, type SystemMessage, SystemMessageSchema } from "./contracts";
import { deletedPeople } from "./former-accounts";
import { chatLive } from "./live";
import { chatLiveUpdates } from "./live-updates";
import { type MentionTarget, mentionViews, publishForYou, storeMentions } from "./mention-store";
import { extractMessageLinks } from "./message-links";
import { reactionGroups } from "./reaction-store";

export type MessageRow = {
  short_id: string;
  seq: bigint | string;
  rev: bigint | string;
  kind: "text" | "system";
  author_type: "user" | "service_account";
  author_id: string;
  author_name: string;
  body_md: string | null;
  refs: CloudResourceRef[];
  links: string[];
  system_code: string | null;
  system_params: unknown;
  created_at: Date;
  thread_id: string | null;
  reply_to_seq: bigint | string | null;
};
export const projectMessage = (
  row: MessageRow,
  conversationId: string,
  thread: string | null = null,
  replyTo: z.infer<typeof MessageSchema>["replyTo"] = null,
): z.infer<typeof MessageSchema> => ({
  reactions: [],
  mentions: [],
  thread,
  replyTo,
  id: row.short_id,
  conversationId,
  seq: Number(row.seq),
  rev: Number(row.rev),
  kind: row.kind,
  author: { type: row.author_type, id: row.author_id, name: row.author_name },
  body: row.body_md,
  refs: row.refs,
  system: row.kind === "system" ? SystemMessageSchema.parse({ code: row.system_code, params: row.system_params }) : null,
  createdAt: row.created_at.toISOString(),
});
const systemPeople = (system: SystemMessage | null) => {
  if (!system) return [];
  switch (system.code) {
    case "members_added":
      return system.params.members;
    case "member_removed":
    case "permission_changed":
    case "manager_assigned":
      return [system.params.member];
    case "member_left":
      return system.params.successor ? [system.params.successor] : [];
    default:
      return [];
  }
};
export const messageViews = async (
  db: typeof sql,
  rows: MessageRow[],
  conversationId: string,
  subject: ChatContext["accessSubject"],
  locale?: string,
) => {
  const mentions = await mentionViews(
    db,
    rows.map((row) => row.short_id),
    locale,
  );
  const reactions = await reactionGroups(
    db,
    rows.map((row) => row.short_id),
    subject,
    locale,
  );
  const threadIds = [...new Set(rows.flatMap((row) => (row.thread_id ? [row.thread_id] : [])))];
  const threadRows = threadIds.length
    ? await db<{ id: string; short_id: string }[]>`
    SELECT id, short_id FROM chat.threads WHERE id = ANY(${toPgUuidArray(threadIds)}::uuid[])`
    : [];
  const threads = new Map(threadRows.map((row) => [row.id, row.short_id]));
  const replySeqs = [...new Set(rows.flatMap((row) => (row.reply_to_seq == null ? [] : [String(row.reply_to_seq)])))];
  const originals = replySeqs.length
    ? await db<MessageRow[]>`SELECT m.* FROM chat.messages m
    JOIN chat.conversations c ON c.id = m.conversation_id WHERE c.short_id = ${conversationId}
      AND m.seq = ANY(${toPgTextArray(replySeqs)}::bigint[])`
    : [];
  const replies = new Map(originals.map((row) => [String(row.seq), projectMessage(row, conversationId)]));
  const projected = rows.map((row) => projectMessage(row, conversationId, row.thread_id ? threads.get(row.thread_id)! : null));
  const all = [...projected, ...replies.values()];
  const absent = await Promise.all(
    (["user", "service_account"] as const).map((type) =>
      deletedPeople(
        db,
        all.flatMap((message) => [
          ...(message.author.type === type ? [message.author.id] : []),
          ...systemPeople(message.system)
            .filter((person) => (person.type ?? "user") === type)
            .map((person) => person.id),
        ]),
        type,
      ),
    ),
  );
  const deleted = new Set(absent.flatMap((ids) => [...ids]));
  const former = messages({ locale }).formerAccount;
  for (const message of all) {
    if (deleted.has(message.author.id)) message.author.name = former;
    for (const person of systemPeople(message.system)) if (deleted.has(person.id)) person.name = former;
  }
  return projected.map((message, index) => {
    message.mentions = mentions.get(message.id) ?? [];
    message.reactions = (reactions.get(message.id) ?? []).map(({ emoji, count, own }) => ({ emoji, count, own }));
    const seq = rows[index]!.reply_to_seq;
    const original = replies.get(String(seq));
    message.replyTo =
      seq == null
        ? null
        : original
          ? {
              id: original.id,
              author: original.author,
              preview: messagePreview(
                original.system ? renderSystemMessage(original.system, original.author.name, locale) : original.body!,
              ),
            }
          : { deleted: true };
    return { ...message, systemText: message.system ? renderSystemMessage(message.system, message.author.name, locale) : null };
  });
};
export const personSnapshots = async (db: typeof sql, ids: string[], type: "user" | "service_account" = "user") => {
  const rows =
    type === "service_account"
      ? await db<
          { id: string; name: string; type: "service_account" }[]
        >`SELECT id, name, 'service_account' AS type FROM auth.service_accounts WHERE id = ANY(${toPgUuidArray(ids)}::uuid[])`
      : await db<{ id: string; name: string; type?: "service_account" }[]>`SELECT id, COALESCE(NULLIF(display_name, ''), uid) AS name
    FROM auth.users WHERE id = ANY(${toPgUuidArray(ids)}::uuid[])`;
  return ids.map((id) => {
    const row = rows.find((row) => row.id === id);
    if (!row) throw new Error("Chat message names a missing person");
    return row;
  });
};

type NewMessage =
  | {
      kind: "text";
      mentions?: MentionTarget[];
      clientId: string;
      body: string;
      refs?: CloudResourceRef[];
      threadId?: string;
      replyToSeq?: string | bigint;
    }
  | { kind: "system"; system: SystemMessage; threadId?: string };
// The caller holds the conversation lock until commit, so numbers cannot become visible out of order.
export const appendMessage = async (
  db: typeof sql,
  conversation: ConversationRow,
  context: Pick<ChatContext, "accessSubject">,
  message: NewMessage,
  affected: readonly string[] = [],
) => {
  const author = subjectPrincipal(context.accessSubject);
  const [snapshot] = await personSnapshots(db, [author.id], author.type);
  if (!snapshot) throw new Error("Chat message has no author");
  const [head] = await db<{ seq_head: bigint | string; rev: bigint | string }[]>`UPDATE chat.conversations
    SET seq_head = seq_head + 1, rev = rev + 1, changed_rev = rev + 1,
      last_activity_at = ${message.kind === "text" ? db`GREATEST(last_activity_at, clock_timestamp())` : db`last_activity_at`}, updated_at = now()
    WHERE id = ${conversation.id}::uuid RETURNING seq_head, rev`;
  if (!head) throw new Error("Chat message has no conversation");
  const refs = message.kind === "text" ? (message.refs ?? []) : [];
  const links = message.kind === "text" ? extractMessageLinks(message.body) : [];
  let row: MessageRow | undefined;
  for (let attempt = 0; attempt < 10 && !row; attempt++) {
    [row] = await db<MessageRow[]>`INSERT INTO chat.messages
      (short_id, conversation_id, seq, rev, kind, author_type, author_id, author_name, client_id, body_md, system_code, system_params, created_at, thread_id, reply_to_seq, refs, links)
      VALUES (${crypto.common.readableId(10)}, ${conversation.id}::uuid, ${head.seq_head}, ${head.rev}, ${message.kind},
        ${author.type}, ${author.id}::uuid, ${snapshot.name}, ${message.kind === "text" ? message.clientId : null},
        ${message.kind === "text" ? message.body : null}, ${message.kind === "system" ? message.system.code : null},
        ${message.kind === "system" ? JSON.stringify(message.system.params) : null}::text::jsonb,
        ${message.kind === "text" ? db`(SELECT last_activity_at FROM chat.conversations WHERE id = ${conversation.id}::uuid)` : db`clock_timestamp()`},
        ${message.threadId ?? null}::uuid, ${message.kind === "text" ? (message.replyToSeq ?? null) : null},
        ${JSON.stringify(refs)}::text::jsonb, ${toPgTextArray(links)}::text[])
      ON CONFLICT (short_id) DO NOTHING RETURNING *`;
  }
  if (!row) throw new Error("Chat message ID could not be allocated");
  if (message.kind === "text") await storeMentions(db, row.short_id, message.mentions ?? []);
  if (row.thread_id) await db`UPDATE chat.threads SET last_activity_at = ${row.created_at} WHERE id = ${row.thread_id}::uuid`;
  const [view] = await messageViews(db, [row], conversation.short_id, context.accessSubject);
  if (!view) throw new Error("Chat message could not be projected");
  // Every member renders a system line in their own language, so the live event carries its code, not its text.
  const { systemText: _, reactions: _reactions, ...projected } = view;
  for (const row of chatLiveUpdates(
    conversation.short_id,
    projected,
    message.kind === "text" ? messagePreview(message.body) : null,
    affected,
  ))
    await chatLive.publish(
      db,
      conversation.kind === "system" && projected.thread
        ? { ...row, key: `${row.key.startsWith("c:") ? "t" : "s"}:${conversation.short_id}:${projected.thread}` }
        : row,
    );
  if (message.kind === "text" && (message.mentions?.length || message.replyToSeq !== undefined))
    await publishForYou(db, context, row.short_id, conversation.short_id);
  return row;
};
