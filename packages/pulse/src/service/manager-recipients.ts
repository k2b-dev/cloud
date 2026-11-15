import { sql } from "@k2b/cloud";
import { listAccessRecipientUserIds } from "@k2b/cloud/server";

export async function listBaseManagers(input: { id: string; afterId?: string; userId?: string; limit: number }) {
  const rows = await sql<{ access_id: string }[]>`SELECT ba.access_id FROM pulse.bases b
    JOIN pulse.base_access ba ON ba.base_id=b.id WHERE b.short_id=${input.id}`;
  return listAccessRecipientUserIds({
    accessIds: rows.map((row) => row.access_id),
    afterId: input.afterId,
    userId: input.userId,
    limit: input.limit,
  });
}
