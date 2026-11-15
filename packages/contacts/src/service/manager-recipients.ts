import { sql } from "@k2b/cloud";
import { listAccessRecipientUserIds } from "@k2b/cloud/server";

export async function listBookManagers(input: { id: string; afterId?: string; userId?: string; limit: number }) {
  const rows = await sql<{ access_id: string }[]>`SELECT ba.access_id FROM contacts.books b
    JOIN contacts.book_access ba ON ba.book_id=b.id WHERE b.short_id=${input.id}`;
  return listAccessRecipientUserIds({ accessIds: rows.map((row) => row.access_id),
    afterId: input.afterId, userId: input.userId, limit: input.limit });
}
