import { sql } from "@k2b/cloud";
import { listAccessRecipientUserIds } from "@k2b/cloud/server";

/** Notes inherit the owning notebook's management grants. */
export async function listNotebookManagers(input: { id: string; afterId?: string; userId?: string; limit: number }, note = false) {
  const rows = note
    ? await sql<{ access_id: string }[]>`SELECT na.access_id FROM notebooks.notes n
        JOIN notebooks.notebooks b ON b.id=n.notebook_id JOIN notebooks.notebook_access na ON na.notebook_id=b.id WHERE n.short_id=${input.id}`
    : await sql<{ access_id: string }[]>`SELECT na.access_id FROM notebooks.notebooks b
        JOIN notebooks.notebook_access na ON na.notebook_id=b.id WHERE b.short_id=${input.id}`;
  return listAccessRecipientUserIds({
    accessIds: rows.map((row) => row.access_id),
    afterId: input.afterId,
    userId: input.userId,
    limit: input.limit,
  });
}
