import { toPgTextArray } from "@k2b/cloud/services";
import { principalLabel } from "@k2b/cloud/shared";
import type { sql } from "bun";
import type { z } from "zod";
import { type ChatContext, messages, personalChannelKey, subjectPrincipal } from "./access";
import type { Mention, MessageSchema } from "./contracts";
import { chatLive } from "./live";

export const mentionViews = async (db: typeof sql, messageIds: string[], locale?: string) => {
  const result = new Map<string, z.infer<typeof MessageSchema>["mentions"]>();
  if (!messageIds.length) return result;
  const rows = await db<
    {
      message: string;
      start_offset: number;
      end_offset: number;
      principal_type: "user" | "service_account";
      principal_id: string;
      name: string | null;
    }[]
  >`SELECT m.short_id AS message, mm.*, CASE WHEN mm.principal_type = 'user' THEN COALESCE(NULLIF(u.display_name, ''), u.uid) ELSE sa.name END AS name
    FROM chat.message_mentions mm JOIN chat.messages m ON m.id = mm.message_id
    LEFT JOIN auth.users u ON mm.principal_type = 'user' AND u.id = mm.principal_id
    LEFT JOIN auth.service_accounts sa ON mm.principal_type = 'service_account' AND sa.id = mm.principal_id
    WHERE m.short_id = ANY(${toPgTextArray(messageIds)}::text[]) ORDER BY m.short_id, mm.start_offset`;
  for (const row of rows) {
    const items = result.get(row.message) ?? [];
    items.push({
      start: row.start_offset,
      end: row.end_offset,
      principal: { type: row.principal_type, id: row.principal_id },
      name: principalLabel(
        {
          principal:
            row.principal_type === "user"
              ? { type: "user", userId: row.principal_id }
              : { type: "service_account", serviceAccountId: row.principal_id },
          displayName: row.name ?? messages({ locale }).formerAccount,
        },
        locale,
      ),
    });
    result.set(row.message, items);
  }
  return result;
};
export const storeMentions = async (db: typeof sql, messageId: string, mentions: readonly Mention[]) => {
  for (const mention of mentions)
    await db`INSERT INTO chat.message_mentions (message_id, principal_type, principal_id, start_offset, end_offset, created_at)
      SELECT id, ${mention.principal.type}, ${mention.principal.id}::uuid, ${mention.start}, ${mention.end}, created_at
      FROM chat.messages WHERE short_id = ${messageId}`;
};
/** Personal invalidation contains no resource identity or message content. Re-read with the receiver's current credential. */
export const publishForYou = async (
  db: typeof sql,
  context: Pick<ChatContext, "accessSubject">,
  messageId: string,
  conversationId: string,
) => {
  const self = subjectPrincipal(context.accessSubject);
  const targets = await db<{ type: "user" | "service_account"; id: string }[]>`
    SELECT principal_type AS type, principal_id AS id FROM chat.message_mentions mm JOIN chat.messages m ON m.id = mm.message_id
      WHERE m.short_id = ${messageId}
    UNION
    SELECT original.author_type, original.author_id FROM chat.messages reply JOIN chat.messages original
      ON original.conversation_id = reply.conversation_id AND original.seq = reply.reply_to_seq
      WHERE reply.short_id = ${messageId}`;
  for (const target of targets) {
    if (target.type === self.type && target.id === self.id) continue;
    const subject =
      target.type === "user"
        ? { type: "user" as const, userId: target.id }
        : { type: "service_account" as const, serviceAccountId: target.id };
    // A first incoming system mention or reply starts at the pre-message head, so it follows normal thread read rules.
    await db`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq)
      SELECT ${target.type}, ${target.id}::uuid, c.id, 'ondemand', m.seq - 1
      FROM chat.conversations c JOIN chat.messages m ON m.conversation_id = c.id
      WHERE c.short_id = ${conversationId} AND c.kind = 'system' AND m.short_id = ${messageId}
      ON CONFLICT DO NOTHING`;
    await chatLive.publish(db, { key: personalChannelKey(subject), data: { type: "for-you" } });
  }
};

export const publishForYouRead = async (db: typeof sql, context: ChatContext, conversationId: string) => {
  const self = subjectPrincipal(context.accessSubject);
  const [row] = await db<{ relevant: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM chat.message_mentions mm JOIN chat.messages m ON m.id = mm.message_id JOIN chat.conversations c ON c.id = m.conversation_id
      WHERE c.short_id = ${conversationId} AND mm.principal_type = ${self.type} AND mm.principal_id = ${self.id}::uuid
        AND NOT (m.author_type = ${self.type} AND m.author_id = ${self.id}::uuid)
    UNION ALL
    SELECT 1 FROM chat.messages original JOIN chat.messages reply ON reply.conversation_id = original.conversation_id AND reply.reply_to_seq = original.seq
      JOIN chat.conversations c ON c.id = original.conversation_id
      WHERE c.short_id = ${conversationId} AND original.author_type = ${self.type} AND original.author_id = ${self.id}::uuid
        AND NOT (reply.author_type = ${self.type} AND reply.author_id = ${self.id}::uuid)
  ) AS relevant`;
  if (!row?.relevant) return false;
  await chatLive.publish(db, { key: personalChannelKey(context.accessSubject), data: { type: "for-you" } });
  return true;
};
