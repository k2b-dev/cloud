import { toPgUuidArray } from "@k2b/cloud/services";
import { crypto } from "@k2b/stdlib";
import type { sql } from "bun";
import type { z } from "zod";
import { messagePreview, renderSystemMessage } from "../system-messages";
import { type ChatContext, type ConversationRow, subjectPrincipal } from "./access";
import { type MessageSchema, type SystemMessage, SystemMessageSchema } from "./contracts";
import { chatLive } from "./live";
import { chatLiveUpdates } from "./live-updates";

export type MessageRow = {
  short_id: string;
  seq: bigint | string;
  rev: bigint | string;
  kind: "text" | "system";
  author_type: "user" | "service_account";
  author_id: string;
  author_name: string;
  body_md: string | null;
  system_code: string | null;
  system_params: unknown;
  created_at: Date;
};
export const projectMessage = (row: MessageRow, conversationId: string): z.infer<typeof MessageSchema> => ({
  id: row.short_id,
  conversationId,
  seq: Number(row.seq),
  rev: Number(row.rev),
  kind: row.kind,
  author: { type: row.author_type, id: row.author_id, name: row.author_name },
  body: row.body_md,
  system: row.kind === "system" ? SystemMessageSchema.parse({ code: row.system_code, params: row.system_params }) : null,
  createdAt: row.created_at.toISOString(),
});
export const messageView = (row: MessageRow, conversationId: string, locale?: string) => {
  const message = projectMessage(row, conversationId);
  return { ...message, systemText: message.system ? renderSystemMessage(message.system, message.author.name, locale) : null };
};
export const personSnapshots = async (db: typeof sql, ids: string[]) => {
  const rows = await db<{ id: string; name: string }[]>`SELECT id, COALESCE(NULLIF(display_name, ''), uid) AS name
    FROM auth.users WHERE id = ANY(${toPgUuidArray(ids)}::uuid[])`;
  return ids.map((id) => {
    const row = rows.find((row) => row.id === id);
    if (!row) throw new Error("Chat message names a missing person");
    return row;
  });
};

type NewMessage = { kind: "text"; clientId: string; body: string } | { kind: "system"; system: SystemMessage };
// The caller holds the conversation lock until commit, so numbers cannot become visible out of order.
export const appendMessage = async (
  db: typeof sql,
  conversation: ConversationRow,
  context: ChatContext,
  message: NewMessage,
  affected: readonly string[] = [],
) => {
  const author = subjectPrincipal(context.accessSubject);
  const [snapshot] = await personSnapshots(db, [author.id]);
  if (!snapshot) throw new Error("Chat message has no author");
  const [head] = await db<{ seq_head: bigint | string; rev: bigint | string }[]>`UPDATE chat.conversations
    SET seq_head = seq_head + 1, rev = rev + 1, changed_rev = rev + 1,
      last_activity_at = ${message.kind === "text" ? db`GREATEST(last_activity_at, clock_timestamp())` : db`last_activity_at`}, updated_at = now()
    WHERE id = ${conversation.id}::uuid RETURNING seq_head, rev`;
  if (!head) throw new Error("Chat message has no conversation");
  let row: MessageRow | undefined;
  for (let attempt = 0; attempt < 10 && !row; attempt++) {
    [row] = await db<MessageRow[]>`INSERT INTO chat.messages
      (short_id, conversation_id, seq, rev, kind, author_type, author_id, author_name, client_id, body_md, system_code, system_params, created_at)
      VALUES (${crypto.common.readableId(10)}, ${conversation.id}::uuid, ${head.seq_head}, ${head.rev}, ${message.kind},
        ${author.type}, ${author.id}::uuid, ${snapshot.name}, ${message.kind === "text" ? message.clientId : null},
        ${message.kind === "text" ? message.body : null}, ${message.kind === "system" ? message.system.code : null},
        ${message.kind === "system" ? JSON.stringify(message.system.params) : null}::text::jsonb,
        ${message.kind === "text" ? db`(SELECT last_activity_at FROM chat.conversations WHERE id = ${conversation.id}::uuid)` : db`clock_timestamp()`})
      ON CONFLICT (short_id) DO NOTHING RETURNING *`;
  }
  if (!row) throw new Error("Chat message ID could not be allocated");
  const projected = projectMessage(row, conversation.short_id);
  for (const row of chatLiveUpdates(
    conversation.short_id,
    projected,
    message.kind === "text" ? messagePreview(message.body) : null,
    affected,
  ))
    await chatLive.publish(db, row);
  return row;
};
