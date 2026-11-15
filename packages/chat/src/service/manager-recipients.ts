import { sql } from "@k2b/cloud";
import { listAccessRecipientUserIds } from "@k2b/cloud/server";

/** Discoverability never confers management, and system conversations have no Chat owner. */
export async function listConversationManagers(input: { id: string; afterId?: string; userId?: string; limit: number }) {
  const rows = await sql<{ access_id: string }[]>`SELECT ca.access_id FROM chat.conversations c
    JOIN chat.conversation_access ca ON ca.conversation_id=c.id
    WHERE c.short_id=${input.id} AND c.kind='chat' AND ca.role='member'`;
  return listAccessRecipientUserIds({ accessIds: rows.map((row) => row.access_id),
    afterId: input.afterId, userId: input.userId, limit: input.limit });
}
