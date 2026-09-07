import { sql } from "bun";

const mailboxId = async (table: "conversations" | "message_contents" | "drafts" | "outbox_submissions", id: string) => {
  const rows =
    table === "conversations"
      ? await sql<Array<{ mailbox_id: string }>>`SELECT mailbox_id::text FROM mail.conversations WHERE id = ${id}::uuid`
      : table === "message_contents"
        ? await sql<Array<{ mailbox_id: string }>>`SELECT mailbox_id::text FROM mail.message_contents WHERE id = ${id}::uuid`
        : table === "drafts"
          ? await sql<Array<{ mailbox_id: string }>>`SELECT mailbox_id::text FROM mail.drafts WHERE id = ${id}::uuid`
          : await sql<Array<{ mailbox_id: string }>>`SELECT mailbox_id::text FROM mail.outbox_submissions WHERE id = ${id}::uuid`;
  return rows[0]?.mailbox_id ?? null;
};

export const conversation = (id: string) => mailboxId("conversations", id);
export const message = (id: string) => mailboxId("message_contents", id);
export const messageConversation = async (id: string, mailboxId: string): Promise<string | null> => {
  const [row] = await sql<Array<{ id: string }>>`
    SELECT c.id::text FROM mail.conversation_messages cm
    JOIN mail.conversations c ON c.id = cm.conversation_id
    WHERE cm.message_id = ${id}::uuid AND c.mailbox_id = ${mailboxId}::uuid
    ORDER BY c.id LIMIT 1
  `;
  return row?.id ?? null;
};
export const draft = (id: string) => mailboxId("drafts", id);
export const delivery = (id: string) => mailboxId("outbox_submissions", id);

export const comment = async (id: string): Promise<{ mailboxId: string; conversationId: string } | null> => {
  const [row] = await sql<Array<{ mailbox_id: string; conversation_id: string }>>`
    SELECT conversation.mailbox_id::text, comment.conversation_id::text
    FROM mail.conversation_comments comment
    JOIN mail.conversations conversation ON conversation.id = comment.conversation_id
    WHERE comment.id = ${id}::uuid
  `;
  return row ? { mailboxId: row.mailbox_id, conversationId: row.conversation_id } : null;
};

export const reminder = async (id: string): Promise<{ mailboxId: string; conversationId: string } | null> => {
  const [row] = await sql<Array<{ mailbox_id: string; conversation_id: string }>>`
    SELECT conversation.mailbox_id::text, reminder.conversation_id::text
    FROM mail.conversation_reminders reminder
    JOIN mail.conversations conversation ON conversation.id = reminder.conversation_id
    WHERE reminder.id = ${id}::uuid
  `;
  return row ? { mailboxId: row.mailbox_id, conversationId: row.conversation_id } : null;
};

export const attachment = async (id: string): Promise<{ mailboxId: string; messageId: string } | null> => {
  const [row] = await sql<Array<{ mailbox_id: string; message_id: string }>>`
    SELECT message.mailbox_id::text, attachment.message_id::text
    FROM mail.attachments attachment
    JOIN mail.message_contents message ON message.id = attachment.message_id
    WHERE attachment.id = ${id}::uuid
  `;
  return row ? { mailboxId: row.mailbox_id, messageId: row.message_id } : null;
};
