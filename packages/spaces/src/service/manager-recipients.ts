import { sql } from "@k2b/cloud";
import { listAccessRecipientUserIds } from "@k2b/cloud/server";

/** Item management inherits the owning Space's grants, exactly like its reader. */
export async function listSpaceManagers(input: { id: string; afterId?: string; userId?: string; limit: number }, item = false) {
  const rows = item
    ? await sql<{ access_id: string }[]>`SELECT sa.access_id FROM spaces.items i
        JOIN spaces.spaces s ON s.id=i.space_id JOIN spaces.space_access sa ON sa.space_id=s.id WHERE i.short_id=${input.id}`
    : await sql<{ access_id: string }[]>`SELECT sa.access_id FROM spaces.spaces s
        JOIN spaces.space_access sa ON sa.space_id=s.id WHERE s.short_id=${input.id}`;
  return listAccessRecipientUserIds({
    accessIds: rows.map((row) => row.access_id),
    afterId: input.afterId,
    userId: input.userId,
    limit: input.limit,
  });
}
